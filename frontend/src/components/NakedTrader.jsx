import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Zap, ArrowUpRight, ArrowDownRight, ShieldAlert, CheckCircle2, 
  Calendar, RefreshCw, AlertTriangle, Wallet, Info, Sliders, ChevronDown, ChevronUp,
  TrendingUp, TrendingDown, Settings, Clock, Crosshair
} from 'lucide-react';
import { api } from '../services/api';

const SETTINGS_STORAGE_KEY = 'neotrader_naked_settings_v2';

const DEFAULT_SETTINGS = {
  bullishAction: 'BUY_CE',       // 'BUY_CE' (Buy Call) or 'SELL_PE' (Sell Put)
  bullishOffset: 0,              // 0: ATM, 1: OTM 1, 2: OTM 2, -1: ITM 1
  bearishAction: 'BUY_PE',       // 'BUY_PE' (Buy Put) or 'SELL_CE' (Sell Call)
  bearishOffset: 0,              // 0: ATM, 1: OTM 1, 2: OTM 2, -1: ITM 1
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

  // 2. Underlying & Expiry
  const [underlying, setUnderlying] = useState('NIFTY'); // 'NIFTY' | 'SENSEX'
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [strikes, setStrikes] = useState([]);

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
  const lotSize = underlying === 'NIFTY' ? 75 : 20;

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
        offset: Number(settings.bullishOffset || 0)
      };
    } else {
      const isBuyPe = settings.bearishAction === 'BUY_PE';
      return {
        action: isBuyPe ? 'BUY' : 'SELL',
        optionType: isBuyPe ? 'PE' : 'CE',
        offset: Number(settings.bearishOffset || 0)
      };
    }
  }, [bias, settings]);

  // Compute Target Strike based on Offset and Option Type
  // Offset: 0 = ATM, +1 = OTM 1, +2 = OTM 2, -1 = ITM 1, -2 = ITM 2
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

  // Fetch Expiries when underlying changes
  useEffect(() => {
    let isMounted = true;
    async function loadExpiries() {
      try {
        const data = await api.getExpiries(underlying);
        if (isMounted && data?.expiries?.length) {
          setExpiries(data.expiries);
          if (!selectedExpiry || !data.expiries.includes(selectedExpiry)) {
            setSelectedExpiry(data.expiries[0]);
          }
        }
      } catch (err) {
        console.error('Failed to load expiries:', err);
      }
    }
    loadExpiries();
    return () => { isMounted = false; };
  }, [underlying]);

  // Fetch Strikes when expiry changes
  useEffect(() => {
    let isMounted = true;
    async function loadStrikes() {
      if (!selectedExpiry) return;
      try {
        const data = await api.getStrikes(underlying, selectedExpiry);
        if (isMounted && data?.strikes?.length) {
          setStrikes(data.strikes);
        }
      } catch (err) {
        console.error('Failed to load strikes:', err);
      }
    }
    loadStrikes();
    return () => { isMounted = false; };
  }, [underlying, selectedExpiry]);

  // Dedicated Option Quote fetcher for accurate live LTP
  const fetchLiveQuote = async () => {
    if (!selectedExpiry || !computedStrike || computedStrike <= 0) return;
    setQuoteLoading(true);
    setQuoteError('');
    try {
      const res = await api.getOptionQuote(underlying, selectedExpiry, computedStrike, optionType);
      if (res && res.status === 'success') {
        setLiveQuote(res);
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

  // Subscribe to symbol in WS Client if available
  useEffect(() => {
    if (wsClient && liveQuote?.trading_symbol) {
      wsClient.send({
        action: 'WATCH_LEGS',
        symbols: [liveQuote.trading_symbol]
      });
    }
  }, [wsClient, liveQuote?.trading_symbol]);

  // Get active LTP (from ws/ltpCache or fallback to liveQuote.ltp)
  const currentLtp = useMemo(() => {
    if (liveQuote?.trading_symbol && ltpCache[liveQuote.trading_symbol]) {
      const cached = ltpCache[liveQuote.trading_symbol];
      return typeof cached === 'object' ? cached.ltp : cached;
    }
    return liveQuote?.ltp || 0;
  }, [liveQuote, ltpCache]);

  // Auto-calculate Stop Loss Trigger & Limit Prices
  useEffect(() => {
    if (isSlManuallyEdited || !currentLtp || currentLtp <= 0) return;

    const points = Number(settings.slPoints) || 15;
    const buffer = Number(settings.slBuffer) || 2;

    if (action === 'BUY') {
      // For BUY: SL is BELOW entry price
      const rawTrigger = Math.max(0.05, currentLtp - points);
      const roundedTrigger = Math.round(rawTrigger * 20) / 20;
      const rawLimit = Math.max(0.05, roundedTrigger - buffer);
      const roundedLimit = Math.round(rawLimit * 20) / 20;
      setSlTriggerPrice(roundedTrigger.toFixed(2));
      setSlLimitPrice(roundedLimit.toFixed(2));
    } else {
      // For SELL: SL is ABOVE entry price
      const rawTrigger = currentLtp + points;
      const roundedTrigger = Math.round(rawTrigger * 20) / 20;
      const rawLimit = roundedTrigger + buffer;
      const roundedLimit = Math.round(rawLimit * 20) / 20;
      setSlTriggerPrice(roundedTrigger.toFixed(2));
      setSlLimitPrice(roundedLimit.toFixed(2));
    }
  }, [currentLtp, action, settings.slPoints, settings.slBuffer, isSlManuallyEdited]);

  // Handle Order Execution
  const handleExecute = async () => {
    setError('');
    setSuccessResult(null);

    if (!kotakStatus?.connected) {
      if (onOpenKotakModal) onOpenKotakModal();
      return;
    }

    if (!computedStrike || !selectedExpiry) {
      setError('Please select an expiry and strike.');
      return;
    }

    if (orderType === 'L' && (!limitPrice || Number(limitPrice) <= 0)) {
      setError('Please specify a valid limit price.');
      return;
    }

    if (enableSL) {
      const trig = parseFloat(slTriggerPrice);
      if (isNaN(trig) || trig <= 0) {
        setError('Please enter a valid Stop-Loss trigger price.');
        return;
      }
      if (action === 'BUY' && currentLtp > 0 && trig >= currentLtp) {
        setError(`For BUY, Stop Loss (${trig}) must be below current price (${currentLtp}).`);
        return;
      }
      if (action === 'SELL' && currentLtp > 0 && trig <= currentLtp) {
        setError(`For SELL, Stop Loss (${trig}) must be above current price (${currentLtp}).`);
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
        product: 'MIS', // Intraday order
        order_type: orderType,
        price: orderType === 'L' ? parseFloat(limitPrice) : 0,
        limit_price: orderType === 'L' ? parseFloat(limitPrice) : 0,
        quantity: lots * lotSize,
        enable_sl: enableSL,
        sl_order_type: settings.slOrderType || 'SL',
        sl_trigger_price: enableSL ? parseFloat(slTriggerPrice) : null,
        sl_limit_price: (enableSL && (settings.slOrderType === 'SL')) ? parseFloat(slLimitPrice) : null
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
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-xl text-slate-100 space-y-5">
      {/* 1. TOP HEADER & UNDERLYING / EXPIRY BAR */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
            {['NIFTY', 'SENSEX'].map((und) => (
              <button
                key={und}
                onClick={() => setUnderlying(und)}
                className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all ${
                  underlying === und 
                    ? 'bg-blue-600 text-white shadow' 
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {und}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800">
            <span className="text-xs text-slate-400 font-medium">Spot:</span>
            <span className="text-sm font-bold text-amber-400 font-mono">
              ₹{currentSpot ? currentSpot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '--.--'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-950 px-2.5 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-400">
            <span>Lot:</span>
            <span className="font-semibold text-slate-200">{lotSize}</span>
          </div>
        </div>

        {/* Expiry Selector & Refresh */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 bg-slate-950 px-2.5 py-1 rounded-lg border border-slate-800">
            <Calendar className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={selectedExpiry}
              onChange={(e) => setSelectedExpiry(e.target.value)}
              className="bg-transparent text-xs font-semibold text-slate-200 focus:outline-none cursor-pointer"
            >
              {expiries.map((exp) => (
                <option key={exp} value={exp} className="bg-slate-900 text-slate-100">
                  {exp}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => fetchLiveQuote()}
            disabled={quoteLoading}
            title="Refresh Live Option Quote"
            className="p-1.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${quoteLoading ? 'animate-spin text-blue-400' : ''}`} />
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showSettings 
                ? 'bg-blue-950 border-blue-700 text-blue-300' 
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
            {showSettings ? <ChevronUp className="w-3 h-3 ml-0.5" /> : <ChevronDown className="w-3 h-3 ml-0.5" />}
          </button>
        </div>
      </div>

      {/* 2. PERSISTENT SETTINGS DRAWER */}
      {showSettings && (
        <div className="bg-slate-950 border border-blue-900/50 rounded-xl p-4 space-y-4 animate-in fade-in duration-200">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <div className="flex items-center gap-2 text-blue-400 font-semibold text-xs tracking-wider uppercase">
              <Sliders className="w-4 h-4" />
              <span>Naked Execution Preferences (Auto-Saved)</span>
            </div>
            <span className="text-[11px] text-slate-500">Saved to browser storage</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Bullish Preferences */}
            <div className="bg-emerald-950/20 border border-emerald-900/40 p-3 rounded-lg space-y-2.5">
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs uppercase">
                <TrendingUp className="w-4 h-4" />
                <span>When Bullish</span>
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Action & Contract</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateSettings({ bullishAction: 'BUY_CE' })}
                    className={`py-1.5 px-2 text-xs font-semibold rounded border transition-all ${
                      settings.bullishAction === 'BUY_CE'
                        ? 'bg-emerald-600 border-emerald-500 text-white shadow'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Buy Call (CE)
                  </button>
                  <button
                    onClick={() => updateSettings({ bullishAction: 'SELL_PE' })}
                    className={`py-1.5 px-2 text-xs font-semibold rounded border transition-all ${
                      settings.bullishAction === 'SELL_PE'
                        ? 'bg-emerald-700 border-emerald-600 text-white shadow'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Sell Put (PE)
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Default Strike Distance</label>
                <div className="grid grid-cols-6 gap-1">
                  {offsetLabels.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => updateSettings({ bullishOffset: item.value })}
                      className={`py-1 text-[11px] font-medium rounded border ${
                        settings.bullishOffset === item.value
                          ? 'bg-emerald-600 border-emerald-400 text-white'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Bearish Preferences */}
            <div className="bg-rose-950/20 border border-rose-900/40 p-3 rounded-lg space-y-2.5">
              <div className="flex items-center gap-2 text-rose-400 font-bold text-xs uppercase">
                <TrendingDown className="w-4 h-4" />
                <span>When Bearish</span>
              </div>
              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Action & Contract</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateSettings({ bearishAction: 'BUY_PE' })}
                    className={`py-1.5 px-2 text-xs font-semibold rounded border transition-all ${
                      settings.bearishAction === 'BUY_PE'
                        ? 'bg-rose-600 border-rose-500 text-white shadow'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Buy Put (PE)
                  </button>
                  <button
                    onClick={() => updateSettings({ bearishAction: 'SELL_CE' })}
                    className={`py-1.5 px-2 text-xs font-semibold rounded border transition-all ${
                      settings.bearishAction === 'SELL_CE'
                        ? 'bg-rose-700 border-rose-600 text-white shadow'
                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Sell Call (CE)
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] text-slate-400 block mb-1">Default Strike Distance</label>
                <div className="grid grid-cols-6 gap-1">
                  {offsetLabels.map((item) => (
                    <button
                      key={item.value}
                      onClick={() => updateSettings({ bearishOffset: item.value })}
                      className={`py-1 text-[11px] font-medium rounded border ${
                        settings.bearishOffset === item.value
                          ? 'bg-rose-600 border-rose-400 text-white'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:bg-slate-800'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Global Defaults */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800 text-xs">
            <div>
              <label className="text-slate-400 block mb-1">Default SL Distance (pts)</label>
              <input
                type="number"
                min="1"
                step="1"
                value={settings.slPoints}
                onChange={(e) => updateSettings({ slPoints: Number(e.target.value) })}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-slate-400 block mb-1">SL Trigger Buffer (pts)</label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={settings.slBuffer}
                onChange={(e) => updateSettings({ slBuffer: Number(e.target.value) })}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-slate-100 font-mono"
              />
            </div>
            <div>
              <label className="text-slate-400 block mb-1">Broker SL Order Type</label>
              <select
                value={settings.slOrderType}
                onChange={(e) => updateSettings({ slOrderType: e.target.value })}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-100"
              >
                <option value="SL">SL (Limit Protection)</option>
                <option value="SL-M">SL-M (Stop Market)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 3. PRIMARY DIRECTION BUTTONS: BULLISH VS BEARISH */}
      <div className="grid grid-cols-2 gap-4">
        {/* Bullish Button */}
        <button
          onClick={() => setBias('BULLISH')}
          className={`relative p-4 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition-all transform active:scale-[0.99] ${
            bias === 'BULLISH'
              ? 'bg-gradient-to-b from-emerald-900/60 to-emerald-950 border-emerald-500 ring-2 ring-emerald-500/30 shadow-lg shadow-emerald-950/50'
              : 'bg-slate-950/60 border-slate-800 hover:border-emerald-800/50 opacity-60 hover:opacity-100'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">🐂</span>
            <span className="text-lg font-black tracking-wider text-emerald-400">BULLISH</span>
          </div>
          <span className="text-xs font-semibold text-emerald-300">
            {settings.bullishAction === 'BUY_CE' ? 'Buy Call (CE)' : 'Sell Put (PE)'} • {
              offsetLabels.find(o => o.value === settings.bullishOffset)?.label || 'ATM'
            }
          </span>
          {bias === 'BULLISH' && (
            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          )}
        </button>

        {/* Bearish Button */}
        <button
          onClick={() => setBias('BEARISH')}
          className={`relative p-4 rounded-xl border flex flex-col items-center justify-center gap-1.5 transition-all transform active:scale-[0.99] ${
            bias === 'BEARISH'
              ? 'bg-gradient-to-b from-rose-900/60 to-rose-950 border-rose-500 ring-2 ring-rose-500/30 shadow-lg shadow-rose-950/50'
              : 'bg-slate-950/60 border-slate-800 hover:border-rose-800/50 opacity-60 hover:opacity-100'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl">🐻</span>
            <span className="text-lg font-black tracking-wider text-rose-400">BEARISH</span>
          </div>
          <span className="text-xs font-semibold text-rose-300">
            {settings.bearishAction === 'BUY_PE' ? 'Buy Put (PE)' : 'Sell Call (CE)'} • {
              offsetLabels.find(o => o.value === settings.bearishOffset)?.label || 'ATM'
            }
          </span>
          {bias === 'BEARISH' && (
            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-rose-400 animate-ping" />
          )}
        </button>
      </div>

      {/* 4. AUTOMATICALLY RESOLVED CONTRACT & LIVE PRICE CARD */}
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 text-xs font-black rounded ${
              action === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
            }`}>
              {action}
            </span>
            <span className="text-base font-bold text-slate-100 tracking-wide">
              {underlying} {computedStrike} {optionType}
            </span>
            <span className="text-xs text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
              {selectedExpiry}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30">
              INTRADAY (MIS)
            </span>
          </div>

          {/* Quick strike override if user desires */}
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>Distance:</span>
            <select
              value={offset}
              onChange={(e) => {
                const val = Number(e.target.value);
                if (bias === 'BULLISH') updateSettings({ bullishOffset: val });
                else updateSettings({ bearishOffset: val });
              }}
              className="bg-slate-900 text-slate-200 border border-slate-700 rounded px-2 py-1 font-medium focus:outline-none"
            >
              {offsetLabels.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label} ({item.value === 0 ? 'ATM' : item.value > 0 ? `+${item.value}` : item.value})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Live LTP Banner */}
        <div className="bg-slate-900/90 border border-slate-800 rounded-lg p-3 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-[11px] text-slate-400 font-medium flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>LIVE OPTION LTP</span>
              {quoteLoading && <span className="text-blue-400 text-[10px]">(updating...)</span>}
            </div>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black text-amber-400 font-mono">
                ₹{currentLtp > 0 ? currentLtp.toFixed(2) : '--.--'}
              </span>
              {liveQuote?.trading_symbol && (
                <span className="text-xs text-slate-500 font-mono">
                  {liveQuote.trading_symbol}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs font-mono">
            {liveQuote?.intrinsic_value !== undefined && (
              <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800">
                <span className="text-slate-500 block text-[10px]">Intrinsic Val</span>
                <span className="text-slate-300 font-semibold">₹{Number(liveQuote.intrinsic_value).toFixed(2)}</span>
              </div>
            )}
            {liveQuote?.time_value !== undefined && (
              <div className="bg-slate-950 px-2.5 py-1.5 rounded border border-slate-800">
                <span className="text-slate-500 block text-[10px]">Time Val (Theta)</span>
                <span className="text-slate-300 font-semibold">₹{Number(liveQuote.time_value).toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {quoteError && (
          <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-900/40 p-2 rounded flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>{quoteError}</span>
          </div>
        )}
      </div>

      {/* 5. ORDER QUANTITY & BROKER STOP-LOSS CONTROLS */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Quantity & Order Type */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-3">
          <div className="text-xs font-bold text-slate-300 flex items-center justify-between">
            <span>POSITION SIZING</span>
            <span className="text-slate-500 font-normal">Product: MIS</span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <label className="text-[11px] text-slate-400 block mb-1">Lots ({lotSize} Qty/Lot)</label>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() => setLots(Math.max(1, lots - 1))}
                  className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-l border border-slate-700 font-bold"
                >
                  -
                </button>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={lots}
                  onChange={(e) => setLots(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-14 h-8 bg-slate-900 border-y border-slate-700 text-center text-sm font-bold text-slate-100 font-mono focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setLots(lots + 1)}
                  className="w-8 h-8 flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-r border border-slate-700 font-bold"
                >
                  +
                </button>
                <span className="ml-3 text-xs text-slate-400 font-mono">
                  = <strong className="text-slate-200">{lots * lotSize}</strong> Qty
                </span>
              </div>
            </div>

            <div className="w-28">
              <label className="text-[11px] text-slate-400 block mb-1">Entry Execution</label>
              <div className="flex bg-slate-900 rounded border border-slate-800 p-0.5">
                {['MKT', 'L'].map(type => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setOrderType(type)}
                    className={`flex-1 py-1 text-xs font-bold rounded ${
                      orderType === type ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
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
              <label className="text-[11px] text-slate-400 block mb-1">Limit Price (₹)</label>
              <input
                type="number"
                step="0.05"
                placeholder={currentLtp ? currentLtp.toFixed(2) : '0.00'}
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-sm font-bold text-amber-400 font-mono focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* Immediate Broker Stop-Loss (MIS) */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ShieldAlert className="w-4 h-4 text-rose-400" />
              <span className="text-xs font-bold text-slate-300">BROKER STOP-LOSS (MIS)</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enableSL}
                onChange={(e) => setEnableSL(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-8 h-4 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-rose-600"></div>
            </label>
          </div>

          {enableSL ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">SL Trigger (₹)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={slTriggerPrice}
                    onChange={(e) => {
                      setSlTriggerPrice(e.target.value);
                      setIsSlManuallyEdited(true);
                    }}
                    className="w-full bg-slate-900 border border-rose-900/60 focus:border-rose-500 rounded px-2 py-1 text-xs font-bold text-rose-400 font-mono"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">SL Limit (₹)</label>
                  <input
                    type="number"
                    step="0.05"
                    value={slLimitPrice}
                    onChange={(e) => {
                      setSlLimitPrice(e.target.value);
                      setIsSlManuallyEdited(true);
                    }}
                    className="w-full bg-slate-900 border border-rose-900/60 focus:border-rose-500 rounded px-2 py-1 text-xs font-bold text-rose-400 font-mono"
                  />
                </div>
              </div>

              {/* Quick +/- 5 pts buttons */}
              <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
                <span>Quick Adjust:</span>
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
                      className="px-1.5 py-0.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded font-mono text-[10px]"
                    >
                      {adj > 0 ? `+${adj}` : adj}
                    </button>
                  ))}
                </div>
              </div>

              <div className="text-[11px] text-slate-500">
                Placed immediately to Kotak Neo as an exit SL order.
              </div>
            </div>
          ) : (
            <div className="text-xs text-amber-500/80 bg-amber-950/20 border border-amber-900/30 p-2 rounded">
              Warning: Trading naked options without a broker Stop-Loss carries unbounded risk.
            </div>
          )}
        </div>
      </div>

      {/* 6. STATUS / ERRORS / SUCCESS TOASTS */}
      {error && (
        <div className="p-3 bg-rose-950/50 border border-rose-700/60 rounded-xl text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 font-medium">{error}</div>
        </div>
      )}

      {successResult && (
        <div className="p-3 bg-emerald-950/50 border border-emerald-700/60 rounded-xl text-xs text-emerald-200 space-y-1">
          <div className="flex items-center gap-2 font-bold text-emerald-400">
            <CheckCircle2 className="w-4 h-4" />
            <span>Order Placed Successfully! (Intraday MIS)</span>
          </div>
          <div className="font-mono text-[11px] text-slate-300">
            Entry Order ID: <strong className="text-emerald-300">{successResult.order_id}</strong>
            {successResult.exit_order_id && (
              <> | Broker SL Order ID: <strong className="text-rose-300">{successResult.exit_order_id}</strong></>
            )}
          </div>
        </div>
      )}

      {/* 7. BIG EXECUTION BUTTON */}
      <div>
        <button
          type="button"
          onClick={handleExecute}
          disabled={loading || !currentLtp || currentLtp <= 0}
          className={`w-full py-4 rounded-xl font-black text-base tracking-wider uppercase flex items-center justify-center gap-2 shadow-xl transition-all transform active:scale-[0.99] ${
            action === 'BUY'
              ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-950/50'
              : 'bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white shadow-rose-950/50'
          } ${loading || !currentLtp ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                @ {orderType === 'MKT' ? `MKT (₹${currentLtp.toFixed(2)})` : `₹${limitPrice}`}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
