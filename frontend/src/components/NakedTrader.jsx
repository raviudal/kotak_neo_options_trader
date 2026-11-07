import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Zap, ArrowUpRight, ArrowDownRight, ShieldAlert, CheckCircle2, 
  Calendar, RefreshCw, AlertTriangle, Wallet, Info, Sliders, ChevronDown
} from 'lucide-react';
import { api } from '../services/api';

export default function NakedTrader({
  niftySpot,
  sensexSpot,
  ltpCache = {},
  wsClient = null,
  kotakStatus = null,
  onOpenKotakModal = null,
  onOrderPlaced = null
}) {
  // 1. Underlying & Expiry States
  const [underlying, setUnderlying] = useState('NIFTY'); // 'NIFTY' | 'SENSEX'
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [strikes, setStrikes] = useState([]);
  const [optionChain, setOptionChain] = useState([]);
  
  // 2. Trade Configuration
  const [action, setAction] = useState('BUY'); // 'BUY' | 'SELL'
  const [optionType, setOptionType] = useState('CE'); // 'CE' | 'PE'
  const [lots, setLots] = useState(1);
  const [orderType, setOrderType] = useState('MKT'); // 'MKT' | 'L'
  const [limitPrice, setLimitPrice] = useState('');

  // 3. Strike & Distance Selection
  // Distance from ATM: 0 (ATM), +1 (OTM 1), +2 (OTM 2), -1 (ITM 1), etc.
  const [distanceOffset, setDistanceOffset] = useState(0); 
  const [selectedStrike, setSelectedStrike] = useState(0);

  // 4. Stop-Loss Configuration (Immediately placed to broker)
  const [enableSL, setEnableSL] = useState(true);
  const [slOrderType, setSlOrderType] = useState('SL'); // 'SL' (Limit) | 'SL-M' (Market)
  const [slTriggerPrice, setSlTriggerPrice] = useState('');
  const [slLimitPrice, setSlLimitPrice] = useState('');
  const [isSlManuallyEdited, setIsSlManuallyEdited] = useState(false);

  // 5. UI & Execution States
  const [loading, setLoading] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [refreshingMaster, setRefreshingMaster] = useState(false);
  const [error, setError] = useState('');
  const [successResult, setSuccessResult] = useState(null);

  // Underlying metrics
  const isSensex = underlying === 'SENSEX';
  const strikeStep = isSensex ? 100 : 50;
  const lotSize = isSensex ? 20 : 65;
  const totalQty = lots * lotSize;
  const activeSpot = isSensex ? (sensexSpot || 80000) : (niftySpot || 24500);
  const atmStrike = activeSpot ? Math.round(activeSpot / strikeStep) * strikeStep : (isSensex ? 80000 : 24500);

  // Fetch Expiries when underlying changes
  useEffect(() => {
    let isMounted = true;
    const fetchExps = async () => {
      try {
        const data = await api.getExpiries(underlying);
        if (isMounted && data && data.length > 0) {
          setExpiries(data);
          setSelectedExpiry(data[0].code);
        }
      } catch (e) {
        console.error("Error fetching expiries:", e);
      }
    };
    fetchExps();
    return () => { isMounted = false; };
  }, [underlying]);

  // Fetch Option Chain / Strikes when expiry or underlying changes
  useEffect(() => {
    if (!selectedExpiry) return;
    let isMounted = true;
    const fetchChain = async () => {
      setChainLoading(true);
      try {
        const data = await api.getOptionChain(selectedExpiry, underlying);
        if (isMounted && data?.strikes) {
          setOptionChain(data.strikes);
          const stks = data.strikes.map(s => s.strike);
          setStrikes(stks);
        }
      } catch (e) {
        console.error("Error fetching option chain:", e);
      } finally {
        if (isMounted) setChainLoading(false);
      }
    };
    fetchChain();
    return () => { isMounted = false; };
  }, [selectedExpiry, underlying]);

  // Calculate Target Strike from distanceOffset and Option Type
  useEffect(() => {
    if (!atmStrike) return;
    let target = atmStrike;
    if (optionType === 'CE') {
      // For Calls: positive offset is higher strike (OTM), negative is lower strike (ITM)
      target = atmStrike + (distanceOffset * strikeStep);
    } else {
      // For Puts: positive offset is lower strike (OTM), negative is higher strike (ITM)
      target = atmStrike - (distanceOffset * strikeStep);
    }
    setSelectedStrike(target);
  }, [distanceOffset, optionType, atmStrike, strikeStep]);

  // Selected Option Contract Info from Option Chain
  const selectedContract = useMemo(() => {
    if (!optionChain || optionChain.length === 0 || !selectedStrike) return null;
    const row = optionChain.find(r => Math.abs(r.strike - selectedStrike) < (strikeStep / 2));
    if (!row) return null;
    const side = optionType === 'CE' ? row.ce : row.pe;
    return {
      strike: selectedStrike,
      optionType,
      symbol: side?.symbol || `${underlying}${selectedExpiry}${selectedStrike}${optionType}`,
      token: side?.token || '',
      baseLtp: side?.ltp || 0
    };
  }, [optionChain, selectedStrike, optionType, underlying, selectedExpiry, strikeStep]);

  // Real-time live LTP for the selected contract
  const liveLtp = useMemo(() => {
    if (!selectedContract) return 0;
    const sym = selectedContract.symbol;
    const tok = String(selectedContract.token || '');
    if (tok && ltpCache[tok] !== undefined && Number(ltpCache[tok]) > 0) {
      return Number(ltpCache[tok]);
    }
    if (sym && ltpCache[sym] !== undefined && Number(ltpCache[sym]) > 0) {
      return Number(ltpCache[sym]);
    }
    return selectedContract.baseLtp || 0;
  }, [selectedContract, ltpCache]);

  // Stream selected contract live via WebSocket
  useEffect(() => {
    if (!selectedContract || !wsClient) return;
    const legToWatch = [{
      trading_symbol: selectedContract.symbol,
      token: selectedContract.token,
      strike: selectedContract.strike,
      option_type: selectedContract.optionType,
      exchange_segment: isSensex ? 'bse_fo' : 'nse_fo'
    }];
    wsClient.send({
      type: 'WATCH_LEGS',
      legs: legToWatch
    });
  }, [selectedContract, wsClient, isSensex]);

  // Auto-calculate suggested Stop Loss when LTP changes (if not manually edited)
  useEffect(() => {
    if (liveLtp > 0 && !isSlManuallyEdited) {
      if (action === 'BUY') {
        // Buy SL: 20% below entry or 15 pts
        const buffer = Math.max(5, liveLtp * 0.20);
        const autoTrigger = Math.max(0.05, Math.round((liveLtp - buffer) * 20) / 20);
        setSlTriggerPrice(autoTrigger.toFixed(2));
        setSlLimitPrice(Math.max(0.05, autoTrigger - 1.0).toFixed(2));
      } else {
        // Sell SL: 20% above entry or 15 pts
        const buffer = Math.max(5, liveLtp * 0.20);
        const autoTrigger = Math.round((liveLtp + buffer) * 20) / 20;
        setSlTriggerPrice(autoTrigger.toFixed(2));
        setSlLimitPrice((autoTrigger + 1.0).toFixed(2));
      }
    }
  }, [liveLtp, action, isSlManuallyEdited]);

  // Quick SL offset handler (e.g. -20 pts or -20%)
  const handleQuickSL = (type, val) => {
    if (liveLtp <= 0) return;
    setIsSlManuallyEdited(true);
    let newTrigger = 0;
    if (action === 'BUY') {
      if (type === 'PTS') newTrigger = liveLtp - val;
      if (type === 'PCT') newTrigger = liveLtp * (1 - val / 100);
      newTrigger = Math.max(0.05, Math.round(newTrigger * 20) / 20);
      setSlTriggerPrice(newTrigger.toFixed(2));
      setSlLimitPrice(Math.max(0.05, newTrigger - 1.0).toFixed(2));
    } else {
      if (type === 'PTS') newTrigger = liveLtp + val;
      if (type === 'PCT') newTrigger = liveLtp * (1 + val / 100);
      newTrigger = Math.round(newTrigger * 20) / 20;
      setSlTriggerPrice(newTrigger.toFixed(2));
      setSlLimitPrice((newTrigger + 1.0).toFixed(2));
    }
  };

  // Max Risk Calculation
  const maxRisk = useMemo(() => {
    const parsedSL = parseFloat(slTriggerPrice);
    if (!enableSL || isNaN(parsedSL) || liveLtp <= 0) {
      return action === 'BUY' ? liveLtp * totalQty : null;
    }
    const perUnitLoss = Math.abs(liveLtp - parsedSL);
    return perUnitLoss * totalQty;
  }, [enableSL, slTriggerPrice, liveLtp, totalQty, action]);

  // Distance label helper
  const getDistanceLabel = (offset) => {
    if (offset === 0) return 'ATM';
    if (offset > 0) return `OTM ${offset}`;
    return `ITM ${Math.abs(offset)}`;
  };

  // Submit Naked Order
  const handleExecuteOrder = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessResult(null);

    if (!kotakStatus?.is_connected) {
      if (onOpenKotakModal) onOpenKotakModal();
      return;
    }

    if (!selectedContract) {
      setError('Please select a valid option contract.');
      return;
    }

    if (enableSL) {
      const parsedSL = parseFloat(slTriggerPrice);
      if (isNaN(parsedSL) || parsedSL <= 0) {
        setError('Please enter a valid Stop-Loss trigger price (> 0).');
        return;
      }
      if (action === 'BUY' && parsedSL >= liveLtp && liveLtp > 0) {
        setError(`For Option BUY, Stop-Loss price (₹${parsedSL}) must be strictly below current LTP (₹${liveLtp}).`);
        return;
      }
      if (action === 'SELL' && parsedSL <= liveLtp && liveLtp > 0) {
        setError(`For Option SELL, Stop-Loss price (₹${parsedSL}) must be strictly above current LTP (₹${liveLtp}).`);
        return;
      }
    }

    setLoading(true);
    try {
      const payload = {
        underlying,
        expiry_code: selectedExpiry,
        strike: selectedStrike,
        option_type: optionType,
        action,
        lots: parseInt(lots) || 1,
        order_type: orderType,
        limit_price: orderType === 'L' ? parseFloat(limitPrice || liveLtp) : 0.0,
        product: 'NRML',
        enable_sl: enableSL,
        sl_order_type: slOrderType,
        sl_trigger_price: enableSL ? parseFloat(slTriggerPrice) : 0.0,
        sl_limit_price: (enableSL && slOrderType === 'SL') ? parseFloat(slLimitPrice || slTriggerPrice) : 0.0
      };

      const res = await api.placeNakedOrder(payload);
      setSuccessResult(res);
      if (onOrderPlaced) onOrderPlaced();
    } catch (err) {
      setError(err.message || 'Failed to place naked order.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm text-slate-800 space-y-4">
      
      {/* 1. Header with Underlying Selector and Expiry Selector */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-3 border-b border-slate-200 gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-amber-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Zap className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Naked Options Trader
            </h3>
            <p className="text-[11px] text-slate-500 font-medium">
              Single-leg option buying & selling with instant broker Stop-Loss
            </p>
          </div>
        </div>

        {/* Top Selectors: Underlying & Expiry */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {/* Underlying Selector */}
          <div className="flex items-center gap-1 bg-slate-100 border border-slate-200 rounded-lg p-0.5">
            <select
              value={underlying}
              onChange={(e) => {
                setUnderlying(e.target.value);
                setDistanceOffset(0);
                setIsSlManuallyEdited(false);
              }}
              className="bg-white border-0 rounded-md px-2.5 py-1 text-xs font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-amber-500 shadow-xs cursor-pointer"
            >
              <option value="NIFTY">NIFTY 50 (NSE)</option>
              <option value="SENSEX">SENSEX (BSE)</option>
            </select>
          </div>

          {/* Expiry Selector */}
          <div className="flex items-center gap-1.5 flex-1 sm:flex-none">
            <Calendar className="w-4 h-4 text-slate-500 shrink-0" />
            <select
              value={selectedExpiry}
              onChange={(e) => {
                setSelectedExpiry(e.target.value);
                setIsSlManuallyEdited(false);
              }}
              className="w-full sm:w-auto bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500 shadow-sm cursor-pointer"
            >
              {expiries.map(exp => (
                <option key={exp.code} value={exp.code} className="font-medium">
                  {exp.display}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={async () => {
                setRefreshingMaster(true);
                try {
                  await api.refreshMaster();
                  const exps = await api.getExpiries(underlying);
                  setExpiries(exps);
                } catch (e) {
                  console.error(e);
                } finally {
                  setRefreshingMaster(false);
                }
              }}
              disabled={refreshingMaster}
              title="Refresh scrip master from Kotak"
              className="p-1.5 rounded-lg border border-slate-200 hover:border-amber-300 hover:bg-amber-50 text-slate-500 hover:text-amber-600 transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshingMaster ? 'animate-spin text-amber-600' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* 2. Primary Trade Action: BUY vs SELL */}
      <div className="space-y-1.5">
        <label className="text-xs font-bold text-slate-600 uppercase tracking-wider">
          1. Action
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setAction('BUY');
              setIsSlManuallyEdited(false);
            }}
            className={`py-3 px-4 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer border ${
              action === 'BUY'
                ? 'bg-emerald-600 text-white border-emerald-700 shadow-md ring-2 ring-emerald-200'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <ArrowUpRight className="w-4 h-4" />
            <span>BUY OPTION</span>
            <span className="text-[10px] font-normal opacity-80">(Long)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setAction('SELL');
              setIsSlManuallyEdited(false);
            }}
            className={`py-3 px-4 rounded-xl text-xs font-extrabold flex items-center justify-center gap-2 transition-all cursor-pointer border ${
              action === 'SELL'
                ? 'bg-rose-600 text-white border-rose-700 shadow-md ring-2 ring-rose-200'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <ArrowDownRight className="w-4 h-4" />
            <span>SELL OPTION</span>
            <span className="text-[10px] font-normal opacity-80">(Short)</span>
          </button>
        </div>
      </div>

      {/* 3. Option Type: CALL (CE) vs PUT (PE) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider">
            2. Option Type
          </label>
          <span className="text-[11px] font-semibold text-slate-500">
            {action === 'BUY' && optionType === 'CE' && '🟢 Bullish (Profits when Index rises)'}
            {action === 'BUY' && optionType === 'PE' && '🔴 Bearish (Profits when Index falls)'}
            {action === 'SELL' && optionType === 'CE' && '🔴 Bearish / Neutral (Profits if Index stays below strike)'}
            {action === 'SELL' && optionType === 'PE' && '🟢 Bullish / Neutral (Profits if Index stays above strike)'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => {
              setOptionType('CE');
              setIsSlManuallyEdited(false);
            }}
            className={`py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer border ${
              optionType === 'CE'
                ? 'bg-blue-600 text-white border-blue-700 shadow-sm ring-2 ring-blue-100'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>CALL (CE)</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setOptionType('PE');
              setIsSlManuallyEdited(false);
            }}
            className={`py-2.5 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer border ${
              optionType === 'PE'
                ? 'bg-purple-600 text-white border-purple-700 shadow-sm ring-2 ring-purple-100'
                : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
            }`}
          >
            <span>PUT (PE)</span>
          </button>
        </div>
      </div>

      {/* 4. Distance from ATM (Quick Distance Buttons & Strike Dropdown) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider">
            3. Distance from ATM ({getDistanceLabel(distanceOffset)})
          </label>
          <span className="text-[11px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded">
            Spot: ₹{activeSpot.toLocaleString('en-IN', { minimumFractionDigits: 1 })} • ATM: {atmStrike}
          </span>
        </div>

        {/* Quick Horizontal Distance Selector Pills */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none">
          {[-3, -2, -1, 0, 1, 2, 3, 4, 5].map((off) => {
            const isSelected = distanceOffset === off;
            const isAtm = off === 0;
            const isItm = off < 0;
            return (
              <button
                key={off}
                type="button"
                onClick={() => {
                  setDistanceOffset(off);
                  setIsSlManuallyEdited(false);
                }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all cursor-pointer border ${
                  isSelected
                    ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                    : isAtm
                    ? 'bg-amber-50 text-amber-900 border-amber-300 hover:bg-amber-100'
                    : isItm
                    ? 'bg-blue-50 text-blue-800 border-blue-200 hover:bg-blue-100'
                    : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                }`}
              >
                {getDistanceLabel(off)}
              </button>
            );
          })}
        </div>

        {/* Strike Dropdown for Precise Strike Selection */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 font-semibold shrink-0">Selected Strike:</span>
          <select
            value={selectedStrike}
            onChange={(e) => {
              const stk = parseFloat(e.target.value);
              setSelectedStrike(stk);
              // Calculate offset from ATM
              const diffSteps = Math.round((stk - atmStrike) / strikeStep);
              const off = optionType === 'CE' ? diffSteps : -diffSteps;
              setDistanceOffset(off);
              setIsSlManuallyEdited(false);
            }}
            className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 cursor-pointer shadow-xs"
          >
            {strikes.map((stk) => {
              const diffSteps = Math.round((stk - atmStrike) / strikeStep);
              const off = optionType === 'CE' ? diffSteps : -diffSteps;
              const lbl = getDistanceLabel(off);
              return (
                <option key={stk} value={stk}>
                  {stk} {optionType} — {lbl} {stk === atmStrike ? '★ (ATM)' : ''}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      {/* 5. LIVE OPTION LTP CARD (Prominently displays live price before ordering) */}
      <div className="bg-gradient-to-br from-slate-900 to-slate-800 text-white rounded-xl p-3.5 sm:p-4 shadow-md relative overflow-hidden">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-500 text-slate-950 uppercase tracking-wider">
                Live LTP Quote
              </span>
              <span className="text-xs font-medium text-slate-300">
                {isSensex ? 'BSE FO' : 'NSE FO'} • {selectedContract?.symbol || `${underlying} ${selectedStrike} ${optionType}`}
              </span>
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-3xl font-extrabold tracking-tight text-white">
                ₹{liveLtp > 0 ? liveLtp.toFixed(2) : '--.--'}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                LIVE
              </span>
            </div>
          </div>

          <div className="text-right">
            <span className="text-[10px] text-slate-400 font-semibold block uppercase">Strike Distance</span>
            <span className="text-xs font-bold text-slate-200">
              {Math.abs(selectedStrike - activeSpot).toFixed(1)} pts {selectedStrike >= activeSpot ? 'Above' : 'Below'} Spot
            </span>
          </div>
        </div>

        {/* Sub-bar: Trade Value & Margin */}
        <div className="mt-3 pt-2.5 border-t border-slate-700/60 flex items-center justify-between text-xs text-slate-300">
          <div>
            <span className="text-slate-400">Total Qty: </span>
            <span className="font-bold text-white">{totalQty} ({lots} Lot{lots > 1 ? 's' : ''})</span>
          </div>
          <div>
            <span className="text-slate-400">
              {action === 'BUY' ? 'Premium Required: ' : 'Approx. Margin: '}
            </span>
            <span className="font-bold text-amber-300">
              ₹{action === 'BUY' 
                ? (liveLtp * totalQty).toLocaleString('en-IN', { maximumFractionDigits: 2 })
                : (lots * (isSensex ? 150000 : 125000)).toLocaleString('en-IN')
              }
            </span>
          </div>
        </div>
      </div>

      {/* 6. Quantity / Lots & Order Type */}
      <div className="grid grid-cols-2 gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
        {/* Lots Stepper */}
        <div>
          <label className="text-[11px] font-bold text-slate-600 block mb-1">
            Quantity (Lots)
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLots(Math.max(1, lots - 1))}
              className="w-8 h-8 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold flex items-center justify-center cursor-pointer shadow-xs"
            >
              −
            </button>
            <input
              type="number"
              min="1"
              max="50"
              value={lots}
              onChange={(e) => setLots(Math.max(1, parseInt(e.target.value) || 1))}
              className="w-14 text-center py-1 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-500 shadow-xs"
            />
            <button
              type="button"
              onClick={() => setLots(lots + 1)}
              className="w-8 h-8 rounded-lg bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 font-bold flex items-center justify-center cursor-pointer shadow-xs"
            >
              +
            </button>
            <span className="text-[11px] text-slate-500 font-medium ml-1">
              ={totalQty} qty
            </span>
          </div>
        </div>

        {/* Entry Order Type: Market vs Limit */}
        <div>
          <label className="text-[11px] font-bold text-slate-600 block mb-1">
            Order Type
          </label>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOrderType('MKT')}
              className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                orderType === 'MKT'
                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              MKT
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderType('L');
                if (!limitPrice && liveLtp > 0) setLimitPrice(liveLtp.toFixed(2));
              }}
              className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                orderType === 'L'
                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              LIMIT
            </button>
          </div>
          {orderType === 'L' && (
            <input
              type="number"
              step="0.05"
              placeholder="Limit Price"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              className="mt-1.5 w-full py-1 px-2 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-amber-500 shadow-xs"
            />
          )}
        </div>
      </div>

      {/* 7. STOP-LOSS (SL) SECTION (Immediate Broker Placement) */}
      <div className="border border-rose-200 bg-rose-50/40 rounded-xl p-3.5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enableSL"
              checked={enableSL}
              onChange={(e) => setEnableSL(e.target.checked)}
              className="w-4 h-4 text-rose-600 rounded border-slate-300 focus:ring-rose-500 cursor-pointer"
            />
            <label htmlFor="enableSL" className="text-xs font-bold text-slate-900 cursor-pointer flex items-center gap-1.5">
              <span>Place Immediate Broker Stop-Loss (SL)</span>
              <span className="text-[10px] bg-rose-100 text-rose-700 font-bold px-1.5 py-0.2 rounded border border-rose-200">
                RECOMMENDED
              </span>
            </label>
          </div>

          {/* SL Order Type Selector */}
          {enableSL && (
            <div className="flex items-center gap-1 bg-white border border-rose-200 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setSlOrderType('SL')}
                className={`px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer ${
                  slOrderType === 'SL' ? 'bg-rose-600 text-white shadow-xs' : 'text-slate-600'
                }`}
              >
                SL (Limit)
              </button>
              <button
                type="button"
                onClick={() => setSlOrderType('SL-M')}
                className={`px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer ${
                  slOrderType === 'SL-M' ? 'bg-rose-600 text-white shadow-xs' : 'text-slate-600'
                }`}
              >
                SL-M
              </button>
            </div>
          )}
        </div>

        {enableSL && (
          <div className="space-y-2.5 pt-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Trigger Price */}
              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  SL Trigger Price (₹)
                </label>
                <input
                  type="number"
                  step="0.05"
                  value={slTriggerPrice}
                  onChange={(e) => {
                    setSlTriggerPrice(e.target.value);
                    setIsSlManuallyEdited(true);
                  }}
                  className="w-full py-1.5 px-3 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-xs"
                />
              </div>

              {/* Limit Price (if SL limit selected) */}
              {slOrderType === 'SL' && (
                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    SL Limit Price (₹)
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    value={slLimitPrice}
                    onChange={(e) => setSlLimitPrice(e.target.value)}
                    className="w-full py-1.5 px-3 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-xs"
                  />
                </div>
              )}
            </div>

            {/* Quick SL Offset Buttons */}
            <div>
              <span className="text-[10px] font-bold text-slate-500 block mb-1 uppercase">
                Quick Adjust SL:
              </span>
              <div className="flex flex-wrap gap-1">
                {[10, 20, 30].map(pts => (
                  <button
                    key={pts}
                    type="button"
                    onClick={() => handleQuickSL('PTS', pts)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:border-rose-300 hover:bg-rose-50 text-[11px] font-semibold text-slate-700 cursor-pointer shadow-2xs"
                  >
                    {action === 'BUY' ? `−${pts} pts` : `+${pts} pts`}
                  </button>
                ))}
                {[15, 20, 25].map(pct => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => handleQuickSL('PCT', pct)}
                    className="px-2 py-0.5 rounded bg-white border border-slate-200 hover:border-rose-300 hover:bg-rose-50 text-[11px] font-semibold text-slate-700 cursor-pointer shadow-2xs"
                  >
                    {action === 'BUY' ? `−${pct}%` : `+${pct}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* Max Risk Callout */}
            {maxRisk !== null && (
              <div className="text-[11px] font-semibold text-rose-800 bg-white/70 border border-rose-200/80 rounded-lg px-2.5 py-1.5 flex items-center justify-between">
                <span>Max Loss if Stop-Loss Triggers:</span>
                <span className="font-bold text-rose-600">
                  −₹{maxRisk.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Error & Success Feedback Alerts */}
      {error && (
        <div className="bg-rose-50 border border-rose-300 text-rose-800 rounded-lg p-3 text-xs font-semibold flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
        </div>
      )}

      {successResult && (
        <div className="bg-emerald-50 border border-emerald-300 text-emerald-900 rounded-lg p-3 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-bold">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>{successResult.message}</span>
          </div>
          <div className="text-[11px] text-emerald-800 space-y-0.5 font-medium pl-5">
            <div>• Entry Order ID: <span className="font-mono font-bold">{successResult.entry_order_id}</span></div>
            {successResult.sl_order_id && (
              <div>• Broker Stop-Loss Order ID: <span className="font-mono font-bold">{successResult.sl_order_id}</span></div>
            )}
            <div>• Fill/Ref Price: ₹{successResult.fill_price}</div>
          </div>
        </div>
      )}

      {/* 8. EXECUTION ACTION BUTTON */}
      <button
        type="button"
        onClick={handleExecuteOrder}
        disabled={loading}
        className={`w-full py-3.5 px-4 rounded-xl font-extrabold text-sm uppercase tracking-wider text-white shadow-md transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
          action === 'BUY'
            ? 'bg-emerald-600 hover:bg-emerald-700 active:scale-[0.99] border border-emerald-700'
            : 'bg-rose-600 hover:bg-rose-700 active:scale-[0.99] border border-rose-700'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <span className="flex items-center gap-2">
          {loading && <RefreshCw className="w-4 h-4 animate-spin" />}
          <span>
            {action === 'BUY' ? 'BUY' : 'SELL'} {lots} LOT ({totalQty} QTY) {selectedContract?.strike} {selectedContract?.optionType} @ {orderType}
          </span>
        </span>
        <span className="text-[10px] font-normal opacity-90">
          {enableSL
            ? `+ Auto-places Broker Stop-Loss @ ₹${slTriggerPrice || '--'} on fill`
            : 'No broker Stop-Loss attached'
          }
        </span>
      </button>

    </div>
  );
}
