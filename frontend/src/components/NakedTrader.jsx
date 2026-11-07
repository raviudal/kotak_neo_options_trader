import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Zap, ArrowUpRight, ArrowDownRight, ShieldAlert, CheckCircle2, 
  Calendar, RefreshCw, AlertTriangle, Wallet, Info, Sliders, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Settings, Clock, Crosshair, ArrowRight
} from 'lucide-react';
import { api } from '../services/api';

const SETTINGS_STORAGE_KEY = 'neotrader_naked_settings_v3';

const DEFAULT_SETTINGS = {
  bullishAction: 'BUY_CE',       // 'BUY_CE' (Buy Call) or 'SELL_PE' (Sell Put)
  bullishOffset: 0,              // 0: ATM, 1: OTM 1, 2: OTM 2, -1: ITM 1
  bearishAction: 'BUY_PE',       // 'BUY_PE' (Buy Put) or 'SELL_CE' (Sell Call)
  bearishOffset: 0,              // 0: ATM, 1: OTM 1, 2: OTM 2, -1: ITM 1
  expiryPreference: 'CURRENT_WEEK', // 'CURRENT_WEEK' | 'NEXT_WEEK' | 'MONTHLY' | 'CUSTOM'
  defaultLots: 1,
  slPoints: 15,                  // Default points away from entry for SL
  slBuffer: 2,                   // Trigger to limit buffer in points
  slOrderType: 'SL'              // 'SL' (Limit) or 'SL-M' (Market)
};

export default function NakedTrader({
  niftySpot,
  sensexSpot,
  ltpCache = {},
  wsClient = null,
  kotakStatus = null,
  onOpenKotakModal = null,
  onOrderPlaced = null
}) {
  // 1. Persistent User Settings
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const [showSettings, setShowSettings] = useState(false);

  // Save settings when changed
  const updateSettings = (partial) => {
    setSettings((prev) => {
      const updated = { ...prev, ...partial };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save settings:', e);
      }
      return updated;
    });
  };

  // 2. Underlying & Dynamic Token Master Lot Size
  const [underlying, setUnderlying] = useState('NIFTY'); // 'NIFTY' | 'SENSEX'
  const [lotSize, setLotSize] = useState(underlying === 'SENSEX' ? 20 : 65);
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');

  // 3. User Direction Bias: 'BULLISH' | 'BEARISH'
  const [bias, setBias] = useState('BULLISH');

  // Trade Specific Inputs
  const [lots, setLots] = useState(settings.defaultLots || 1);
  const [orderType, setOrderType] = useState('MKT'); // 'MKT' | 'L'
  const [limitPrice, setLimitPrice] = useState('');

  // Stop Loss Specific Inputs
  const [enableSL, setEnableSL] = useState(true);
  const [slTriggerPrice, setSlTriggerPrice] = useState('');
  const [slLimitPrice, setSlLimitPrice] = useState('');
  const [isSlManuallyEdited, setIsSlManuallyEdited] = useState(false);

  // Quote & State
  const [liveQuote, setLiveQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successResult, setSuccessResult] = useState(null);

  // Spot price & strike step
  const currentSpot = underlying === 'NIFTY' ? niftySpot : sensexSpot;
  const strikeStep = underlying === 'NIFTY' ? 50 : 100;

  // Compute ATM strike
  const atmStrike = useMemo(() => {
    if (!currentSpot || currentSpot <= 0) return 0;
    return Math.round(currentSpot / strikeStep) * strikeStep;
  }, [currentSpot, strikeStep]);

  // Determine current active Action & Option Type based on Bias & Settings
  const { action, optionType, offset } = useMemo(() => {
    if (bias === 'BULLISH') {
      const isBuyCe = settings.bullishAction === 'BUY_CE';
      return {
        action: isBuyCe ? 'BUY' : 'SELL',
        optionType: isBuyCe ? 'CE' : 'PE',
        offset: Number(settings.bullishOffset ?? 0)
      };
    } else {
      const isBuyPe = settings.bearishAction === 'BUY_PE';
      return {
        action: isBuyPe ? 'BUY' : 'SELL',
        optionType: isBuyPe ? 'PE' : 'CE',
        offset: Number(settings.bearishOffset ?? 0)
      };
    }
  }, [bias, settings]);

  // Compute Target Strike based on Offset and Option Type
  const computedStrike = useMemo(() => {
    if (!atmStrike) return 0;
    if (offset === 0) return atmStrike;

    // For Call (CE): higher strike is OTM (+), lower strike is ITM (-)
    // For Put (PE): lower strike is OTM (+), higher strike is ITM (-)
    if (optionType === 'CE') {
      return atmStrike + (offset * strikeStep);
    } else {
      return atmStrike - (offset * strikeStep);
    }
  }, [atmStrike, offset, strikeStep, optionType]);

  // Fetch Expiries when underlying changes or setting preference changes
  useEffect(() => {
    let isMounted = true;
    async function loadExpiries() {
      try {
        const data = await api.getExpiries(underlying);
        const list = Array.isArray(data) ? data : (data?.expiries || []);
        if (isMounted && list.length > 0) {
          setExpiries(list);

          // Resolve expiry code by user preference
          let targetCode = list[0]?.code;
          if (settings.expiryPreference === 'NEXT_WEEK' && list.length > 1) {
            targetCode = list[1]?.code;
          } else if (settings.expiryPreference === 'MONTHLY') {
            const monthlyExp = list.find(e => (e.display || '').toLowerCase().includes('monthly'));
            targetCode = monthlyExp ? monthlyExp.code : list[list.length - 1]?.code;
          } else if (settings.expiryPreference === 'CUSTOM') {
            if (selectedExpiry && list.some(e => e.code === selectedExpiry)) {
              targetCode = selectedExpiry;
            }
          }

          setSelectedExpiry(targetCode);
        }
      } catch (err) {
        console.error('Failed to load expiries:', err);
      }
    }
    loadExpiries();
    return () => { isMounted = false; };
  }, [underlying, settings.expiryPreference]);

  // Dedicated Option Quote fetcher for accurate live LTP & token master lot size
  const fetchLiveQuote = async () => {
    if (!selectedExpiry || !computedStrike || computedStrike <= 0) return;
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const res = await api.getOptionQuote(underlying, selectedExpiry, computedStrike, optionType);
      if (res && (res.status === 'success' || res.symbol || res.trading_symbol)) {
        setLiveQuote(res);

        // 1. Take true lot size dynamically from token master!
        if (res.lot_size && Number(res.lot_size) > 0) {
          setLotSize(Number(res.lot_size));
        }

        // 2. Stream quote continuously via WebSocket
        if (wsClient && res.trading_symbol) {
          wsClient.send({
            type: 'WATCH_LEGS',
            legs: [{
              trading_symbol: res.trading_symbol,
              token: String(res.token || ''),
              strike: res.strike,
              option_type: res.option_type,
              exchange_segment: res.exchange_segment || (underlying === 'SENSEX' ? 'bse_fo' : 'nse_fo')
            }]
          });
        }
      } else {
        setQuoteError(res?.message || 'Failed to fetch quote');
      }
    } catch (e) {
      console.error('Quote fetch error:', e);
      setQuoteError(e.response?.data?.detail || e.message);
    } finally {
      setQuoteLoading(false);
    }
  };

  // Re-fetch quote whenever contract parameters change
  useEffect(() => {
    fetchLiveQuote();
    setIsSlManuallyEdited(false);
  }, [underlying, selectedExpiry, computedStrike, optionType, action]);

  // Active LTP: checks real-time websocket ltpCache first, falls back to REST quote ltp
  const currentLtp = useMemo(() => {
    if (liveQuote?.trading_symbol && ltpCache[liveQuote.trading_symbol] !== undefined) {
      const cached = ltpCache[liveQuote.trading_symbol];
      const val = typeof cached === 'object' ? cached.ltp : cached;
      if (Number(val) > 0) return Number(val);
    }
    if (liveQuote?.token && ltpCache[liveQuote.token] !== undefined) {
      const cached = ltpCache[liveQuote.token];
      const val = typeof cached === 'object' ? cached.ltp : cached;
      if (Number(val) > 0) return Number(val);
    }
    return liveQuote?.ltp || 0;
  }, [liveQuote, ltpCache]);

  // Auto-fill limit price placeholder or initial value when user selects Limit order
  useEffect(() => {
    if (orderType === 'L' && !limitPrice && currentLtp > 0) {
      setLimitPrice(currentLtp.toFixed(2));
    }
  }, [orderType, currentLtp]);

  // Auto-calculate Stop Loss Trigger & Limit Prices
  useEffect(() => {
    if (isSlManuallyEdited) return;

    // Use current LTP or limit price as baseline
    const basePrice = (currentLtp > 0 ? currentLtp : parseFloat(limitPrice)) || 0;
    if (basePrice <= 0) return;

    const points = Number(settings.slPoints) || 15;
    const buffer = Number(settings.slBuffer) || 2;

    if (action === 'BUY') {
      // For BUY: SL is BELOW entry price
      const rawTrigger = Math.max(0.05, basePrice - points);
      const roundedTrigger = Math.round(rawTrigger * 20) / 20;
      const rawLimit = Math.max(0.05, roundedTrigger - buffer);
      const roundedLimit = Math.round(rawLimit * 20) / 20;
      setSlTriggerPrice(roundedTrigger.toFixed(2));
      setSlLimitPrice(roundedLimit.toFixed(2));
    } else {
      // For SELL: SL is ABOVE entry price
      const rawTrigger = basePrice + points;
      const roundedTrigger = Math.round(rawTrigger * 20) / 20;
      const rawLimit = roundedTrigger + buffer;
      const roundedLimit = Math.round(rawLimit * 20) / 20;
      setSlTriggerPrice(roundedTrigger.toFixed(2));
      setSlLimitPrice(roundedLimit.toFixed(2));
    }
  }, [currentLtp, limitPrice, action, settings.slPoints, settings.slBuffer, isSlManuallyEdited]);

  // Validate whether final execution button should be active
  const canExecute = useMemo(() => {
    if (loading) return false;
    if (!selectedExpiry || !computedStrike || computedStrike <= 0) return false;
    if (orderType === 'MKT') {
      return currentLtp > 0;
    } else {
      return Number(limitPrice) > 0;
    }
  }, [loading, selectedExpiry, computedStrike, orderType, currentLtp, limitPrice]);

  // Handle Order Execution
  const handleExecute = async () => {
    setError('');
    setSuccessResult(null);

    if (!kotakStatus?.is_connected) {
      if (onOpenKotakModal) onOpenKotakModal();
      return;
    }

    if (!computedStrike || !selectedExpiry) {
      setError('Please select a valid expiry and strike.');
      return;
    }

    if (orderType === 'L' && (!limitPrice || Number(limitPrice) <= 0)) {
      setError('Please specify a valid limit price.');
      return;
    }

    const effectiveEntryPrice = orderType === 'L' ? parseFloat(limitPrice) : currentLtp;

    if (enableSL) {
      const trig = parseFloat(slTriggerPrice);
      if (isNaN(trig) || trig <= 0) {
        setError('Please enter a valid Stop-Loss trigger price.');
        return;
      }
      if (action === 'BUY' && effectiveEntryPrice > 0 && trig >= effectiveEntryPrice) {
        setError(`For BUY, Stop Loss (${trig}) must be strictly below entry price (${effectiveEntryPrice}).`);
        return;
      }
      if (action === 'SELL' && effectiveEntryPrice > 0 && trig <= effectiveEntryPrice) {
        setError(`For SELL, Stop Loss (${trig}) must be strictly above entry price (${effectiveEntryPrice}).`);
        return;
      }
    }

    setLoading(true);
    try {
      const payload = {
        underlying,
        expiry: selectedExpiry,
        expiry_code: selectedExpiry,
        strike: computedStrike,
        option_type: optionType,
        action,
        lots,
        quantity: lots * lotSize,
        product: 'MIS', // Strict intraday order
        order_type: orderType,
        price: orderType === 'L' ? parseFloat(limitPrice) : 0,
        limit_price: orderType === 'L' ? parseFloat(limitPrice) : 0,
        enable_sl: enableSL,
        sl_order_type: settings.slOrderType || 'SL',
        sl_trigger_price: enableSL ? parseFloat(slTriggerPrice) : 0,
        sl_limit_price: (enableSL && (settings.slOrderType === 'SL')) ? parseFloat(slLimitPrice) : 0
      };

      const result = await api.placeNakedOrder(payload);

      if (result.status === 'success') {
        setSuccessResult(result);
        if (onOrderPlaced) onOrderPlaced(result);
      } else {
        setError(result.message || 'Order failed on Kotak Neo.');
      }
    } catch (err) {
      console.error('Order execution error:', err);
      setError(err.response?.data?.detail || err.message || 'Execution error');
    } finally {
      setLoading(false);
    }
  };

  const offsetLabels = [
    { value: -2, label: 'ITM 2' },
    { value: -1, label: 'ITM 1' },
    { value: 0, label: 'ATM' },
    { value: 1, label: 'OTM 1' },
    { value: 2, label: 'OTM 2' },
    { value: 3, label: 'OTM 3' }
  ];

  return (
    <div className="bg-white border border-slate-200/80 rounded-2xl p-5 shadow-sm text-slate-800 space-y-5">
      {/* 1. TOP HEADER & UNDERLYING / EXPIRY BAR (LIGHT THEME) */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-3">
          {/* Underlying Tabs */}
          <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200/80">
            {['NIFTY', 'SENSEX'].map((und) => (
              <button
                key={und}
                onClick={() => setUnderlying(und)}
                className={`px-3.5 py-1.5 text-xs font-bold rounded-lg transition-all ${
                  underlying === und 
                    ? 'bg-white text-blue-700 shadow-sm border border-slate-200/60' 
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {und}
              </button>
            ))}
          </div>

          {/* Spot Price Badge */}
          <div className="flex items-center gap-2 bg-amber-50/70 border border-amber-200 px-3 py-1.5 rounded-xl">
            <span className="text-xs text-amber-800 font-semibold">Spot:</span>
            <span className="text-sm font-black text-amber-900 font-mono">
              ₹{currentSpot ? currentSpot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '--.--'}
            </span>
          </div>

          {/* Token Master Lot Size Badge */}
          <div className="flex items-center gap-1.5 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-xl text-xs text-slate-600">
            <span>Lot Size:</span>
            <span className="font-bold text-slate-900 font-mono">{lotSize}</span>
            <span className="text-[10px] text-slate-400 font-normal">(token master)</span>
          </div>
        </div>

        {/* Expiry Selector & Settings Button */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl">
            <Calendar className="w-4 h-4 text-slate-500" />
            <select
              value={selectedExpiry}
              onChange={(e) => {
                setSelectedExpiry(e.target.value);
                updateSettings({ expiryPreference: 'CUSTOM' });
              }}
              className="bg-transparent text-xs font-bold text-slate-800 focus:outline-none cursor-pointer"
            >
              {expiries.map((exp) => {
                const code = typeof exp === 'object' ? exp.code : exp;
                const label = typeof exp === 'object' ? (exp.display || exp.code) : exp;
                return (
                  <option key={code} value={code} className="text-slate-800 bg-white">
                    {label}
                  </option>
                );
              })}
            </select>
          </div>

          <button
            onClick={() => fetchLiveQuote()}
            disabled={quoteLoading}
            title="Refresh Live Option Quote"
            className="p-2 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-xl text-slate-600 hover:text-slate-900 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${quoteLoading ? 'animate-spin text-blue-600' : ''}`} />
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl border transition-colors ${
              showSettings 
                ? 'bg-blue-50 border-blue-300 text-blue-700 shadow-sm' 
                : 'bg-slate-100 border-slate-200 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
            {showSettings ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* 2. PERSISTENT SETTINGS DRAWER (LIGHT MODE) */}
      {showSettings && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-4 shadow-sm animate-in fade-in duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-slate-200">
            <div className="flex items-center gap-2 text-blue-700 font-bold text-xs tracking-wider uppercase">
              <Sliders className="w-4 h-4" />
              <span>Naked Execution Preferences (Auto-Saved)</span>
            </div>
            <span className="text-[11px] text-slate-500 font-medium">Saved to browser storage</span>
          </div>

          {/* Expiry Preference Selector */}
          <div className="bg-white border border-slate-200 p-3.5 rounded-xl space-y-2">
            <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
              <Calendar className="w-4 h-4 text-blue-600" />
              <span>Default Expiry Selection</span>
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { id: 'CURRENT_WEEK', label: 'Current Week' },
                { id: 'NEXT_WEEK', label: 'Next Week' },
                { id: 'MONTHLY', label: 'Monthly' },
                { id: 'CUSTOM', label: 'Manual Dropdown' }
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => updateSettings({ expiryPreference: opt.id })}
                  className={`py-2 px-3 text-xs font-bold rounded-lg border transition-all ${
                    settings.expiryPreference === opt.id
                      ? 'bg-blue-600 border-blue-600 text-white shadow-sm'
                      : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Bullish Preferences */}
            <div className="bg-emerald-50/60 border border-emerald-200 p-3.5 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-emerald-800 font-bold text-xs uppercase tracking-wide">
                <TrendingUp className="w-4 h-4 text-emerald-600" />
                <span>When Bullish</span>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">Contract Action</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateSettings({ bullishAction: 'BUY_CE' })}
                    className={`py-2 px-2 text-xs font-bold rounded-lg border transition-all ${
                      settings.bullishAction === 'BUY_CE'
                        ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Buy Call (CE)
                  </button>
                  <button
                    onClick={() => updateSettings({ bullishAction: 'SELL_PE' })}
                    className={`py-2 px-2 text-xs font-bold rounded-lg border transition-all ${
                      settings.bullishAction === 'SELL_PE'
                        ? 'bg-emerald-700 border-emerald-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Sell Put (PE)
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">Default Strike Distance</label>
                <div className="grid grid-cols-6 gap-1">
                  {offsetLabels.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => updateSettings({ bullishOffset: item.value })}
                      className={`py-1.5 text-[11px] font-bold rounded-lg border ${
                        settings.bullishOffset === item.value
                          ? 'bg-emerald-600 border-emerald-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Bearish Preferences */}
            <div className="bg-rose-50/60 border border-rose-200 p-3.5 rounded-xl space-y-3">
              <div className="flex items-center gap-2 text-rose-800 font-bold text-xs uppercase tracking-wide">
                <TrendingDown className="w-4 h-4 text-rose-600" />
                <span>When Bearish</span>
              </div>
              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">Contract Action</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateSettings({ bearishAction: 'BUY_PE' })}
                    className={`py-2 px-2 text-xs font-bold rounded-lg border transition-all ${
                      settings.bearishAction === 'BUY_PE'
                        ? 'bg-rose-600 border-rose-600 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Buy Put (PE)
                  </button>
                  <button
                    onClick={() => updateSettings({ bearishAction: 'SELL_CE' })}
                    className={`py-2 px-2 text-xs font-bold rounded-lg border transition-all ${
                      settings.bearishAction === 'SELL_CE'
                        ? 'bg-rose-700 border-rose-700 text-white shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    Sell Call (CE)
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-600 block mb-1">Default Strike Distance</label>
                <div className="grid grid-cols-6 gap-1">
                  {offsetLabels.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => updateSettings({ bearishOffset: item.value })}
                      className={`py-1.5 text-[11px] font-bold rounded-lg border ${
                        settings.bearishOffset === item.value
                          ? 'bg-rose-600 border-rose-600 text-white'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Global Stop Loss Defaults */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200 text-xs">
            <div>
              <label className="text-slate-600 font-semibold block mb-1">Default SL Distance (pts)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={settings.slPoints}
                onChange={(e) => updateSettings({ slPoints: Number(e.target.value) })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-slate-800 font-mono font-bold"
              />
            </div>
            <div>
              <label className="text-slate-600 font-semibold block mb-1">SL Trigger Buffer (pts)</label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={settings.slBuffer}
                onChange={(e) => updateSettings({ slBuffer: Number(e.target.value) })}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-slate-800 font-mono font-bold"
              />
            </div>
            <div>
              <label className="text-slate-600 font-semibold block mb-1">Broker SL Order Type</label>
              <select
                value={settings.slOrderType}
                onChange={(e) => updateSettings({ slOrderType: e.target.value })}
                className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 font-bold"
              >
                <option value="SL">SL (Limit Protection)</option>
                <option value="SL-M">SL-M (Stop Market)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 3. PRIMARY DIRECTION BUTTONS: BULLISH VS BEARISH (LIGHT THEME) */}
      <div className="grid grid-cols-2 gap-4">
        {/* Bullish Button */}
        <button
          onClick={() => setBias('BULLISH')}
          className={`relative p-5 rounded-2xl border-2 flex flex-col items-center justify-center gap-1.5 transition-all transform active:scale-[0.99] cursor-pointer ${
            bias === 'BULLISH'
              ? 'bg-gradient-to-b from-emerald-50 to-teal-50/70 border-emerald-500 shadow-md shadow-emerald-100 ring-2 ring-emerald-500/20'
              : 'bg-white border-slate-200 hover:border-emerald-300 text-slate-600 hover:text-slate-900'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-3xl">🐂</span>
            <span className="text-xl font-black tracking-wider text-emerald-700">BULLISH</span>
          </div>
          <span className="text-xs font-bold text-emerald-800">
            {settings.bullishAction === 'BUY_CE' ? 'Buy Call (CE)' : 'Sell Put (PE)'} • {
              offsetLabels.find(o => o.value === settings.bullishOffset)?.label || 'ATM'
            }
          </span>
          {bias === 'BULLISH' && (
            <span className="absolute top-3 right-3 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-4 ring-emerald-100" />
          )}
        </button>

        {/* Bearish Button */}
        <button
          onClick={() => setBias('BEARISH')}
          className={`relative p-5 rounded-2xl border-2 flex flex-col items-center justify-center gap-1.5 transition-all transform active:scale-[0.99] cursor-pointer ${
            bias === 'BEARISH'
              ? 'bg-gradient-to-b from-rose-50 to-red-50/70 border-rose-500 shadow-md shadow-rose-100 ring-2 ring-rose-500/20'
              : 'bg-white border-slate-200 hover:border-rose-300 text-slate-600 hover:text-slate-900'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-3xl">🐻</span>
            <span className="text-xl font-black tracking-wider text-rose-700">BEARISH</span>
          </div>
          <span className="text-xs font-bold text-rose-800">
            {settings.bearishAction === 'BUY_PE' ? 'Buy Put (PE)' : 'Sell Call (CE)'} • {
              offsetLabels.find(o => o.value === settings.bearishOffset)?.label || 'ATM'
            }
          </span>
          {bias === 'BEARISH' && (
            <span className="absolute top-3 right-3 w-2.5 h-2.5 rounded-full bg-rose-500 ring-4 ring-rose-100" />
          )}
        </button>
      </div>

      {/* 4. AUTOMATICALLY RESOLVED CONTRACT & LIVE PRICE CARD (LIGHT THEME) */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 text-xs font-black rounded-lg border ${
              action === 'BUY' 
                ? 'bg-emerald-100 text-emerald-800 border-emerald-300' 
                : 'bg-rose-100 text-rose-800 border-rose-300'
            }`}>
              {action}
            </span>
            <span className="text-lg font-black text-slate-900 tracking-wide font-mono">
              {underlying} {computedStrike} {optionType}
            </span>
            <span className="text-xs font-bold text-slate-700 bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-2xs">
              {selectedExpiry || '--'}
            </span>
            <span className="text-[11px] font-black uppercase tracking-wider bg-amber-100 text-amber-900 px-2.5 py-1 rounded-lg border border-amber-300">
              INTRADAY (MIS)
            </span>
          </div>

          {/* Quick strike override */}
          <div className="flex items-center gap-2 text-xs text-slate-600 font-semibold">
            <span>Distance:</span>
            <select
              value={offset}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (bias === 'BULLISH') updateSettings({ bullishOffset: val });
                else updateSettings({ bearishOffset: val });
              }}
              className="bg-white text-slate-800 border border-slate-300 rounded-lg px-2.5 py-1 font-bold focus:outline-none shadow-2xs"
            >
              {offsetLabels.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label} ({item.value === 0 ? 'ATM' : item.value > 0 ? `+${item.value}` : item.value})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Live LTP Display Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          <div>
            <div className="text-xs text-slate-500 font-bold flex items-center gap-1.5 uppercase tracking-wide">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${currentLtp > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
              <span>Live Option LTP</span>
              {quoteLoading && <span className="text-blue-600 text-[11px] font-normal normal-case">(fetching...)</span>}
            </div>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={`text-3xl font-black font-mono ${currentLtp > 0 ? 'text-slate-900' : 'text-slate-400'}`}>
                ₹{currentLtp > 0 ? currentLtp.toFixed(2) : '--.--'}
              </span>
              {liveQuote?.trading_symbol && (
                <span className="text-xs text-slate-500 font-mono font-medium">
                  {liveQuote.trading_symbol}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs font-mono">
            {liveQuote?.intrinsic_value !== undefined && (
              <div className="bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Intrinsic</span>
                <span className="text-slate-900 font-bold">₹{Number(liveQuote.intrinsic_value).toFixed(2)}</span>
              </div>
            )}
            {liveQuote?.time_value !== undefined && (
              <div className="bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
                <span className="text-slate-500 block text-[10px] uppercase font-bold">Time Val (Theta)</span>
                <span className="text-slate-900 font-bold">₹{Number(liveQuote.time_value).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {quoteError && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 p-2.5 rounded-lg flex items-center gap-2 font-medium">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
            <span>{quoteError}</span>
          </div>
        )}
      </div>

      {/* 5. ORDER QUANTITY & BROKER STOP-LOSS CONTROLS (LIGHT THEME) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Quantity & Order Type */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="text-xs font-bold text-slate-700 flex items-center justify-between uppercase tracking-wide">
            <span>Position Sizing</span>
            <span className="text-slate-500 font-semibold normal-case">Product: MIS (Intraday)</span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <label className="text-[11px] font-bold text-slate-600 block mb-1">
                Lots ({lotSize} Qty/Lot)
              </label>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setLots(Math.max(1, lots - 1))}
                  className="w-9 h-9 flex items-center justify-center bg-white hover:bg-slate-100 text-slate-800 rounded-l-lg border border-slate-300 font-bold cursor-pointer"
                >
                  -
                </button>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={lots}
                  onChange={(e) => setLots(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-16 h-9 bg-white border-y border-slate-300 text-center text-sm font-black text-slate-900 font-mono focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setLots(lots + 1)}
                  className="w-9 h-9 flex items-center justify-center bg-white hover:bg-slate-100 text-slate-800 rounded-r-lg border border-slate-300 font-bold cursor-pointer"
                >
                  +
                </button>
                <span className="ml-3 text-xs text-slate-600 font-mono">
                  = <strong className="text-slate-900 font-black">{lots * lotSize}</strong> Qty
                </span>
              </div>
            </div>

            <div className="w-32">
              <label className="text-[11px] font-bold text-slate-600 block mb-1">Entry Execution</label>
              <div className="flex bg-white rounded-lg border border-slate-300 p-0.5">
                {['MKT', 'L'].map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setOrderType(type)}
                    className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                      orderType === type 
                        ? 'bg-blue-600 text-white shadow-2xs' 
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {orderType === 'L' && (
            <div>
              <label className="text-[11px] font-bold text-slate-600 block mb-1">Limit Price (₹)</label>
              <input
                type="number"
                step="0.05"
                placeholder={currentLtp > 0 ? currentLtp.toFixed(2) : '0.00'}
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                className="w-full bg-white border border-slate-300 focus:border-blue-500 rounded-lg px-3 py-1.5 text-sm font-black text-slate-900 font-mono focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Immediate Broker Stop-Loss (MIS) */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-rose-600" />
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">Broker Stop-Loss (MIS)</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enableSL}
                onChange={(e) => setEnableSL(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-rose-600"></div>
            </label>
          </div>

          {enableSL ? (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] font-bold text-slate-600 block mb-0.5">SL Trigger (₹)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={slTriggerPrice}
                    onChange={(e) => {
                      setSlTriggerPrice(e.target.value);
                      setIsSlManuallyEdited(true);
                    }}
                    className="w-full bg-white border border-rose-300 focus:border-rose-600 rounded-lg px-3 py-1.5 text-xs font-bold text-rose-700 font-mono focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold text-slate-600 block mb-0.5">SL Limit (₹)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={slLimitPrice}
                    onChange={(e) => {
                      setSlLimitPrice(e.target.value);
                      setIsSlManuallyEdited(true);
                    }}
                    className="w-full bg-white border border-rose-300 focus:border-rose-600 rounded-lg px-3 py-1.5 text-xs font-bold text-rose-700 font-mono focus:outline-none"
                  />
                </div>
              </div>

              {/* Quick +/- adjust buttons */}
              <div className="flex items-center justify-between text-xs text-slate-600 pt-0.5">
                <span className="font-semibold">Quick Adjust:</span>
                <div className="flex items-center gap-1">
                  {[-10, -5, +5, +10].map((adj) => (
                    <button
                      key={adj}
                      type="button"
                      onClick={() => {
                        const cur = parseFloat(slTriggerPrice) || currentLtp;
                        const nextTrig = Math.max(0.05, Math.round((cur + adj) * 20) / 20);
                        const nextLim = action === 'BUY' 
                          ? Math.max(0.05, Math.round((nextTrig - Number(settings.slBuffer || 2)) * 20) / 20)
                          : Math.round((nextTrig + Number(settings.slBuffer || 2)) * 20) / 20;
                        setSlTriggerPrice(nextTrig.toFixed(2));
                        setSlLimitPrice(nextLim.toFixed(2));
                        setIsSlManuallyEdited(true);
                      }}
                      className="px-2 py-0.5 bg-white hover:bg-slate-100 border border-slate-300 rounded font-mono font-bold text-[11px] text-slate-700 cursor-pointer"
                    >
                      {adj > 0 ? `+${adj}` : adj}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-[11px] text-slate-500">
                Stop-Loss order is submitted directly to Kotak Neo RMS immediately after entry fills.
              </div>
            </div>
          ) : (
            <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 p-2.5 rounded-lg font-medium">
              Warning: Trading naked options without a broker Stop-Loss carries unbounded risk.
            </div>
          )}
        </div>
      </div>

      {/* 6. STATUS / ERRORS / SUCCESS TOASTS */}
      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-800 flex items-start gap-2.5 font-medium shadow-2xs">
          <AlertTriangle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1">{error}</div>
        </div>
      )}

      {successResult && (
        <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 space-y-1 shadow-2xs">
          <div className="flex items-center gap-2 font-bold text-emerald-700 text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Order Placed Successfully! (Intraday MIS)</span>
          </div>
          <div className="font-mono text-xs text-slate-700">
            Entry Order ID: <strong className="text-emerald-700">{successResult.order_id}</strong>
            {successResult.exit_order_id && (
              <> • Broker SL Order ID: <strong className="text-rose-700">{successResult.exit_order_id}</strong></>
            )}
          </div>
        </div>
      )}

      {/* 7. FINAL EXECUTION BUTTON (LIGHT MODE WITH HIGH VISIBILITY & ACTIVE STATE) */}
      <div>
        <button
          type="button"
          onClick={handleExecute}
          disabled={!canExecute}
          className={`w-full py-4 rounded-2xl font-black text-base tracking-wider uppercase flex items-center justify-center gap-2 shadow-md transition-all transform active:scale-[0.99] cursor-pointer ${
            action === 'BUY'
              ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-600/20'
              : 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white shadow-rose-600/20'
          } ${!canExecute ? 'opacity-40 cursor-not-allowed shadow-none' : ''}`}
        >
          {loading ? (
            <>
              <RefreshCw className="w-5 h-5 animate-spin" />
              <span>Routing Order to Kotak Neo...</span>
            </>
          ) : (
            <>
              <Zap className="w-5 h-5" />
              <span>
                {action} {underlying} {computedStrike} {optionType} • {lots * lotSize} Qty (MIS)
              </span>
              <span className="text-xs font-mono font-normal opacity-90 ml-1">
                @ {orderType === 'MKT' ? `MKT (₹${currentLtp > 0 ? currentLtp.toFixed(2) : '--.--'})` : `₹${limitPrice || '0.00'}`}
              </span>
            </>
          )}
        </button>
        {!canExecute && (
          <p className="text-[11px] text-center text-slate-500 mt-2 font-medium">
            {!selectedExpiry 
              ? 'Loading expiries...' 
              : orderType === 'L' && !limitPrice 
                ? 'Enter a valid limit price to enable execution' 
                : currentLtp <= 0 
                  ? 'Waiting for quote or switch to Limit (L) order to set entry price' 
                  : ''}
          </p>
        )}
      </div>
    </div>
  );
}
