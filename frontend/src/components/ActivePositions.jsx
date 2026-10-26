import React, { useState, useMemo } from 'react';
import { Activity, ShieldAlert, CheckCircle2, AlertOctagon, XCircle, ArrowUpRight, ArrowDownRight, Clock, ChevronDown, ChevronUp, RefreshCw, Edit2, Check, X, Trash2, AlertTriangle, ArrowRight } from 'lucide-react';
import { api } from '../services/api';

export default function ActivePositions({ liveStrategies, historicalStrategies, ltpCache = {}, onRefresh }) {
  const [activeTab, setActiveTab] = useState('ACTIVE'); // 'ACTIVE' or 'HISTORY'
  const [historyFilter, setHistoryFilter] = useState('TODAY'); // 'TODAY' or 'ALL'
  const [closingId, setClosingId] = useState(null);
  const [syncingId, setSyncingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  // Present date string in local format (YYYY-MM-DD)
  const todayStr = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }, []);

  // Filter historical strategies for today
  const todayHistoryStrategies = useMemo(() => {
    if (!Array.isArray(historicalStrategies)) return [];
    return historicalStrategies.filter(strat => {
      const c1 = strat.closed_at || '';
      const c2 = strat.created_at || '';
      return c1.startsWith(todayStr) || c2.startsWith(todayStr);
    });
  }, [historicalStrategies, todayStr]);

  // Displayed historical strategies based on filter
  const displayedHistoricalStrategies = useMemo(() => {
    if (historyFilter === 'ALL') return historicalStrategies || [];
    return todayHistoryStrategies;
  }, [historyFilter, historicalStrategies, todayHistoryStrategies]);

  // Total Realized PnL for Today's closed strategies
  const totalTodayRealizedPnL = useMemo(() => {
    return todayHistoryStrategies.reduce((sum, strat) => {
      const pnl = strat.realized_pnl !== undefined && strat.realized_pnl !== null && strat.realized_pnl !== 0
        ? strat.realized_pnl
        : (() => {
            if (!Array.isArray(strat.legs) || strat.legs.length === 0) return 0;
            let legSum = 0;
            let hasAny = false;
            for (const l of strat.legs) {
              const en = parseFloat(l.entry_price) || 0;
              const ex = parseFloat(l.exit_price) || 0;
              const q = l.quantity || 65;
              const isBuy = String(l.action || '').toUpperCase().startsWith('B');
              if (ex > 0 && en > 0) {
                legSum += isBuy ? (ex - en) * q : (en - ex) * q;
                hasAny = true;
              }
            }
            return hasAny ? legSum : (strat.realized_pnl || 0);
          })();
      return sum + Number(pnl || 0);
    }, 0);
  }, [todayHistoryStrategies]);

  // Helper to compute live leg price and PnL using real-time WebSocket ticks
  const getLegLiveInfo = (leg) => {
    const tokenKey = String(leg.instrument_token || leg.token || "");
    const wsLive = ltpCache ? (ltpCache[leg.trading_symbol] ?? (tokenKey ? ltpCache[tokenKey] : undefined)) : undefined;
    const price = (wsLive !== undefined && wsLive !== null && Number(wsLive) > 0)
      ? Number(wsLive)
      : (leg.current_price || 0);

    const entryP = typeof leg.entry_price === 'number' ? leg.entry_price : (parseFloat(leg.entry_price) || 0);
    const qty = leg.quantity || 65;
    const isBuy = String(leg.action || '').toUpperCase().startsWith('B');
    const pnl = price > 0
      ? (isBuy ? (price - entryP) * qty : (entryP - price) * qty)
      : (leg.pnl || 0);

    return {
      price,
      entryP,
      qty,
      pnl: Math.round(pnl * 100) / 100,
      isLive: price > 0
    };
  };

  // Helper to compute real-time Strategy Combined Net LTP (+1 BUY, -1 SELL)
  const getStrategyLiveLTP = (strat) => {
    if (strat.legs && strat.legs.length > 0) {
      let total = 0;
      for (const leg of strat.legs) {
        const info = getLegLiveInfo(leg);
        const isBuy = String(leg.action || '').toUpperCase().startsWith('B');
        const mult = isBuy ? 1 : -1;
        total += mult * (info.price || info.entryP || 0);
      }
      return Math.round(total * 100) / 100;
    }
    return strat.strategy_ltp !== undefined && strat.strategy_ltp !== null ? strat.strategy_ltp : 0;
  };

  // Stop Loss inline edit states
  const [editingSlId, setEditingSlId] = useState(null);
  const [editSlTargetType, setEditSlTargetType] = useState('INDEX'); // 'INDEX' | 'STRATEGY_LTP'
  const [editSlPrice, setEditSlPrice] = useState('');
  const [editStrategySlValue, setEditStrategySlValue] = useState('');
  const [editSlCondition, setEditSlCondition] = useState('LESS_THAN_OR_EQUAL');
  const [editSlMode, setEditSlMode] = useState('LIVE');
  const [editCandleInterval, setEditCandleInterval] = useState(0);
  const [savingSlId, setSavingSlId] = useState(null);

  const handleStartEdit = (strat) => {
    setEditingSlId(strat.id);
    const targetType = strat.sl_target_type || 'INDEX';
    setEditSlTargetType(targetType);
    setEditSlPrice(strat.index_sl_price !== null && strat.index_sl_price !== undefined ? strat.index_sl_price : '');
    
    // If strategy_sl_value is already set, use it; otherwise prefill with 5% SL from live Strategy LTP
    const currLtp = getStrategyLiveLTP(strat);
    let initStratSL = strat.strategy_sl_value;
    if ((initStratSL === null || initStratSL === undefined || initStratSL === '') && currLtp !== 0) {
      const adverse = (Math.abs(currLtp) * 5) / 100;
      initStratSL = Math.round((currLtp - adverse) * 100) / 100;
    }
    setEditStrategySlValue(initStratSL !== null && initStratSL !== undefined ? initStratSL : '');
    setEditSlCondition(strat.index_sl_condition || 'LESS_THAN_OR_EQUAL');
    setEditSlMode(strat.index_sl_mode || (targetType === 'STRATEGY_LTP' ? 'CANDLE' : 'LIVE'));
    setEditCandleInterval(strat.candle_interval || (targetType === 'STRATEGY_LTP' || strat.index_sl_mode === 'CANDLE' ? 5 : 0));
  };

  const handleCancelEdit = () => {
    setEditingSlId(null);
    setEditSlPrice('');
    setEditStrategySlValue('');
  };

  const handleSaveSL = async (id) => {
    setSavingSlId(id);
    try {
      if (editSlTargetType === 'STRATEGY_LTP') {
        const parsedVal = parseFloat(editStrategySlValue);
        if (isNaN(parsedVal)) {
          alert("Please enter a valid Strategy LTP Stop Loss value.");
          setSavingSlId(null);
          return;
        }
        const payload = {
          sl_target_type: 'STRATEGY_LTP',
          strategy_sl_value: parsedVal,
          index_sl_condition: editSlCondition,
          index_sl_mode: 'CANDLE',
          candle_interval: parseInt(editCandleInterval) || 5
        };
        await api.updateStrategySL(id, payload);
      } else {
        const parsedPrice = parseFloat(editSlPrice);
        if (isNaN(parsedPrice) || parsedPrice <= 0) {
          alert("Please enter a valid Nifty stop-loss price.");
          setSavingSlId(null);
          return;
        }
        const payload = {
          sl_target_type: 'INDEX',
          index_sl_price: parsedPrice,
          index_sl_condition: editSlCondition,
          index_sl_mode: editSlMode,
          candle_interval: editSlMode === 'CANDLE' ? (parseInt(editCandleInterval) || 5) : 0
        };
        await api.updateStrategySL(id, payload);
      }
      setEditingSlId(null);
      if (onRefresh) onRefresh();
    } catch (e) {
      alert("Error updating stop loss: " + e.message);
    } finally {
      setSavingSlId(null);
    }
  };

  const handleClose = async (id) => {
    if (!window.confirm("Are you sure you want to square off all legs of this strategy immediately on Kotak Neo?")) return;
    setClosingId(id);
    try {
      const res = await api.closeStrategy(id);
      alert(res.message || "Strategy squared off successfully on Kotak Neo!");
      if (onRefresh) onRefresh();
    } catch (e) {
      alert("Error closing strategy: " + e.message);
    } finally {
      setClosingId(null);
    }
  };

  const handleSync = async (id) => {
    setSyncingId(id);
    try {
      const res = await api.syncStrategy(id);
      if (onRefresh) onRefresh();
    } catch (e) {
      alert("Error syncing fill prices: " + e.message);
    } finally {
      setSyncingId(null);
    }
  };

  // 2-Level Strategy Delete State & Handlers
  const [deleteModalState, setDeleteModalState] = useState(null);

  const handleInitiateDelete = (strat) => {
    setDeleteModalState({
      strat,
      step: 1,
      confirmText: '',
      isDeleting: false
    });
  };

  const handleProceedToLevel2 = () => {
    setDeleteModalState(prev => prev ? { ...prev, step: 2, confirmText: '' } : null);
  };

  const handleCancelDelete = () => {
    setDeleteModalState(null);
  };

  const handleConfirmDelete = async () => {
    if (!deleteModalState || !deleteModalState.strat) return;
    const stratId = deleteModalState.strat.id;
    setDeleteModalState(prev => ({ ...prev, isDeleting: true }));
    try {
      await api.deleteStrategy(stratId);
      setDeleteModalState(null);
      if (onRefresh) onRefresh();
    } catch (e) {
      alert("Error deleting strategy: " + (e.message || e));
      setDeleteModalState(prev => prev ? ({ ...prev, isDeleting: false }) : null);
    }
  };

  const toggleExpand = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  const totalActivePnL = liveStrategies?.reduce((acc, strat) => {
    let stratPnl = strat.total_pnl || 0;
    if (strat.legs && strat.legs.length > 0) {
      let calcPnl = 0;
      let hasLive = false;
      for (const leg of strat.legs) {
        const info = getLegLiveInfo(leg);
        if (info.isLive) {
          hasLive = true;
          calcPnl += info.pnl;
        }
      }
      if (hasLive) stratPnl = calcPnl;
    }
    return acc + stratPnl;
  }, 0) || 0;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm text-slate-800">
      
      {/* Header with Total PnL & Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3.5 border-b border-slate-200 gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-blue-50 text-blue-600 border border-blue-200">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">Positions & Stop Loss Tracker</h3>
            <p className="text-xs text-slate-500">Live tick-by-tick risk management</p>
          </div>
        </div>

        {/* Tab switcher & PnL Summary */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('ACTIVE')}
              className={`px-3 py-1 rounded-md transition-all cursor-pointer ${
                activeTab === 'ACTIVE'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Active ({liveStrategies?.length || 0})
            </button>
            <button
              onClick={() => setActiveTab('HISTORY')}
              className={`px-3 py-1 rounded-md transition-all cursor-pointer ${
                activeTab === 'HISTORY'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              History ({todayHistoryStrategies?.length || 0})
            </button>
          </div>

          {activeTab === 'ACTIVE' && (
            <div className="px-3 py-1 bg-slate-50 border border-slate-200 rounded-lg text-right shadow-sm">
              <span className="text-[10px] text-slate-500 font-medium uppercase block font-sans">Total P&L</span>
              <span className={`text-sm font-bold font-mono ${
                totalActivePnL >= 0 ? 'text-emerald-600' : 'text-rose-600'
              }`}>
                {totalActivePnL >= 0 ? '+' : ''}₹{totalActivePnL.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {activeTab === 'HISTORY' && (
            <div className="px-3 py-1 bg-slate-50 border border-slate-200 rounded-lg text-right shadow-sm">
              <span className="text-[10px] text-slate-500 font-medium uppercase block font-sans">Today's Realized P&L</span>
              <span className={`text-sm font-bold font-mono ${
                totalTodayRealizedPnL >= 0 ? 'text-emerald-600' : 'text-rose-600'
              }`}>
                {totalTodayRealizedPnL >= 0 ? '+' : ''}₹{totalTodayRealizedPnL.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* --- ACTIVE STRATEGIES LIST --- */}
      {activeTab === 'ACTIVE' && (
        <div className="space-y-3">
          {!liveStrategies || liveStrategies.length === 0 ? (
            <div className="py-10 text-center text-slate-400 font-medium text-xs bg-slate-50 border border-dashed border-slate-200 rounded-lg">
              No active strategies running. Use the strategy builder to deploy a spread.
            </div>
          ) : (
            liveStrategies.map((strat) => {
              let pnl = strat.total_pnl || 0;
              if (strat.legs && strat.legs.length > 0) {
                let calcPnl = 0;
                let hasLive = false;
                for (const leg of strat.legs) {
                  const info = getLegLiveInfo(leg);
                  if (info.isLive) {
                    hasLive = true;
                    calcPnl += info.pnl;
                  }
                }
                if (hasLive) pnl = calcPnl;
              }
              const isProfit = pnl >= 0;
              const isStrategyLtpSl = strat.sl_target_type === 'STRATEGY_LTP';
              const currentStratLtp = getStrategyLiveLTP(strat);
              const isCloseToSL = Math.abs(strat.distance_to_sl || 0) < (isStrategyLtpSl ? 10 : 25);

              return (
                <div
                  key={strat.id}
                  className="rounded-lg border border-slate-200 bg-white p-3.5 shadow-sm relative overflow-hidden transition-all"
                >
                  {/* Top row: Name, Type, Live PnL, Square-off */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-slate-900">{strat.name}</h4>
                        <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                          {strat.strategy_type}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5 font-medium">
                        Entry Spot: <span className="font-mono font-semibold text-slate-800">{strat.entry_index_price || 'N/A'}</span>
                        {strat.hedge_distance ? ` • Hedge: ${strat.hedge_distance} pts` : ''}
                      </p>

                      {/* Payoff Metrics Pills */}
                      {(() => {
                        const hasMaxP = typeof strat.max_profit === 'number' && !isNaN(strat.max_profit);
                        const hasMaxL = typeof strat.max_loss === 'number' && !isNaN(strat.max_loss);
                        const hasBeLow = typeof strat.breakeven_low === 'number' && !isNaN(strat.breakeven_low);
                        const hasBeHigh = typeof strat.breakeven_high === 'number' && !isNaN(strat.breakeven_high);
                        const hasRR = strat.risk_reward && strat.risk_reward !== 'N/A';

                        if (!hasMaxP && !hasMaxL && !hasBeLow && !hasRR) return null;

                        return (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 font-mono text-[10px]">
                            {hasMaxP && (
                              <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200 font-semibold">
                                Max P: +₹{Math.round(strat.max_profit).toLocaleString('en-IN')}
                              </span>
                            )}
                            {hasMaxL && (
                              <span className="bg-rose-50 text-rose-700 px-1.5 py-0.5 rounded border border-rose-200 font-semibold">
                                Max L: -₹{Math.round(Math.abs(strat.max_loss)).toLocaleString('en-IN')}
                              </span>
                            )}
                            {hasBeLow && (
                              <span className="bg-slate-50 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200 font-semibold">
                                BE: {Math.round(strat.breakeven_low)} {hasBeHigh ? `& ${Math.round(strat.breakeven_high)}` : ''}
                              </span>
                            )}
                            {hasRR && (
                              <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200 font-semibold">
                                R:R {strat.risk_reward}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="flex items-center gap-2">
                      {/* PnL */}
                      <div className="text-right px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                        <span className="text-[9px] text-slate-500 font-medium uppercase block">P&L</span>
                        <span className={`text-sm font-bold font-mono ${isProfit ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {isProfit ? '+' : ''}₹{pnl.toFixed(2)}
                        </span>
                      </div>

                      {/* Sync Fill Prices Button */}
                      <button
                        onClick={() => handleSync(strat.id)}
                        disabled={syncingId === strat.id}
                        title="Sync executed entry fill prices directly from Kotak Neo API"
                        className="p-2 rounded-lg bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 text-slate-600 hover:text-blue-700 transition-all cursor-pointer"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${syncingId === strat.id ? 'animate-spin text-blue-600' : ''}`} />
                      </button>

                      {/* Square Off Button */}
                      <button
                        onClick={() => handleClose(strat.id)}
                        disabled={closingId === strat.id}
                        className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white shadow-sm text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
                      >
                        <AlertOctagon className="w-3.5 h-3.5 text-white" />
                        <span>{closingId === strat.id ? 'Exiting...' : 'Square Off'}</span>
                      </button>

                      {/* Delete Strategy Record Button */}
                      <button
                        onClick={() => handleInitiateDelete(strat)}
                        title="Delete strategy record (Requires 2-level confirmation)"
                        className="p-2 rounded-lg bg-slate-50 hover:bg-rose-50 border border-slate-200 hover:border-rose-300 text-slate-400 hover:text-rose-600 transition-all cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>

                      {/* Expand Legs Chevron */}
                      <button
                        onClick={() => toggleExpand(strat.id)}
                        className="p-1.5 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 cursor-pointer"
                      >
                        {expandedId === strat.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  {/* Stop-Loss Status Banner & Editable Controls (Supports Nifty Index SL and Strategy LTP Candle Close SL) */}
                  <div className={`mt-2.5 p-2.5 rounded-lg border text-xs flex flex-wrap items-center justify-between gap-2.5 font-mono ${
                    isCloseToSL 
                      ? 'bg-rose-50 border-rose-200 text-rose-900' 
                      : (isStrategyLtpSl ? 'bg-purple-50/70 border-purple-200 text-slate-800' : 'bg-amber-50/70 border-amber-200 text-slate-800')
                  }`}>
                    {/* Left: SL Condition, Value, and Mode */}
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="relative flex h-2 w-2">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-600"></span>
                        </span>
                        <span className="font-sans font-semibold text-slate-700">
                          {isStrategyLtpSl ? 'Strat LTP SL:' : 'Index SL:'}
                        </span>
                      </div>

                      {editingSlId === strat.id ? (
                        /* Editing Form */
                        <div className="flex flex-col gap-2 font-sans w-full bg-white/90 p-2.5 rounded-lg border border-slate-300">
                          {/* Radio Selector: Nifty Index SL vs Strategy LTP SL */}
                          <div className="flex items-center gap-4 border-b border-slate-200 pb-2">
                            <label className="flex items-center gap-1.5 cursor-pointer text-xs font-semibold text-slate-800">
                              <input
                                type="radio"
                                name={`slType_${strat.id}`}
                                value="INDEX"
                                checked={editSlTargetType === 'INDEX'}
                                onChange={() => setEditSlTargetType('INDEX')}
                                className="w-3.5 h-3.5 text-blue-600"
                              />
                              <span>Nifty Spot SL</span>
                            </label>
                            <label className="flex items-center gap-1.5 cursor-pointer text-xs font-semibold text-slate-800">
                              <input
                                type="radio"
                                name={`slType_${strat.id}`}
                                value="STRATEGY_LTP"
                                checked={editSlTargetType === 'STRATEGY_LTP'}
                                onChange={() => {
                                  setEditSlTargetType('STRATEGY_LTP');
                                  if (!editCandleInterval || editCandleInterval === 0) setEditCandleInterval(5);
                                  if (!editStrategySlValue && currentStratLtp !== 0) {
                                    const adverse = (Math.abs(currentStratLtp) * 5) / 100;
                                    setEditStrategySlValue(Math.round((currentStratLtp - adverse) * 100) / 100);
                                    setEditSlCondition('LESS_THAN_OR_EQUAL');
                                  }
                                }}
                                className="w-3.5 h-3.5 text-blue-600"
                              />
                              <span>Strategy LTP Candle SL</span>
                            </label>
                          </div>

                          {/* Inputs Row */}
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Condition */}
                            <select
                              value={editSlCondition}
                              onChange={(e) => setEditSlCondition(e.target.value)}
                              className="bg-white border border-slate-300 rounded px-1.5 py-1 text-xs font-bold text-slate-800 shadow-xs focus:outline-none"
                            >
                              <option value="LESS_THAN_OR_EQUAL">≤</option>
                              <option value="GREATER_THAN_OR_EQUAL">≥</option>
                            </select>

                            {editSlTargetType === 'STRATEGY_LTP' ? (
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="number"
                                  step="0.05"
                                  value={editStrategySlValue}
                                  onChange={(e) => setEditStrategySlValue(e.target.value)}
                                  className="w-24 bg-white border border-slate-300 rounded px-2 py-1 font-mono text-xs font-bold text-rose-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                                  placeholder="Strat SL"
                                />

                                <span className="text-[11px] text-slate-500 font-medium">Candle:</span>
                                <select
                                  value={editCandleInterval || 5}
                                  onChange={(e) => setEditCandleInterval(parseInt(e.target.value))}
                                  className="bg-white border border-slate-300 rounded px-1.5 py-1 text-xs font-semibold text-slate-800 shadow-xs focus:outline-none"
                                >
                                  <option value={1}>1 min</option>
                                  <option value={3}>3 min</option>
                                  <option value={5}>5 min</option>
                                  <option value={15}>15 min</option>
                                  <option value={30}>30 min</option>
                                  <option value={60}>60 min</option>
                                </select>

                                {/* Quick % SL Buttons */}
                                <div className="flex items-center gap-1">
                                  <span className="text-[10px] text-slate-400 font-semibold">Quick:</span>
                                  {[5, 10, 15, 20].map((pct) => (
                                    <button
                                      key={pct}
                                      type="button"
                                      onClick={() => {
                                        const adverse = (Math.abs(currentStratLtp) * pct) / 100;
                                        setEditStrategySlValue(Math.round((currentStratLtp - adverse) * 100) / 100);
                                        setEditSlCondition('LESS_THAN_OR_EQUAL');
                                      }}
                                      className="px-1.5 py-0.5 rounded text-[10px] font-bold border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 cursor-pointer"
                                    >
                                      {pct}%
                                    </button>
                                  ))}
                                </div>
                              </div>
                            ) : (
                              <>
                                <input
                                  type="number"
                                  step="0.05"
                                  value={editSlPrice}
                                  onChange={(e) => setEditSlPrice(e.target.value)}
                                  className="w-24 bg-white border border-slate-300 rounded px-2 py-1 font-mono text-xs font-bold text-rose-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                                  placeholder="Nifty SL"
                                />

                                <select
                                  value={editSlMode}
                                  onChange={(e) => {
                                    const newMode = e.target.value;
                                    setEditSlMode(newMode);
                                    if (newMode === 'LIVE') setEditCandleInterval(0);
                                    else if (!editCandleInterval || editCandleInterval === 0) setEditCandleInterval(5);
                                  }}
                                  className="bg-white border border-slate-300 rounded px-1.5 py-1 text-xs font-semibold text-slate-800 shadow-xs focus:outline-none"
                                >
                                  <option value="LIVE">Live Tick</option>
                                  <option value="CANDLE">Candle Close</option>
                                </select>

                                {editSlMode === 'CANDLE' && (
                                  <select
                                    value={editCandleInterval}
                                    onChange={(e) => setEditCandleInterval(parseInt(e.target.value))}
                                    className="bg-white border border-slate-300 rounded px-1.5 py-1 text-xs font-semibold text-slate-800 shadow-xs focus:outline-none"
                                  >
                                    <option value={1}>1 min</option>
                                    <option value={3}>3 min</option>
                                    <option value={5}>5 min</option>
                                    <option value={15}>15 min</option>
                                    <option value={30}>30 min</option>
                                    <option value={60}>60 min</option>
                                  </select>
                                )}
                              </>
                            )}

                            {/* Save & Cancel Buttons */}
                            <div className="flex items-center gap-1.5 ml-auto">
                              <button
                                type="button"
                                onClick={() => handleSaveSL(strat.id)}
                                disabled={savingSlId === strat.id}
                                title="Save SL Settings"
                                className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold cursor-pointer transition-colors shadow-xs flex items-center gap-1 text-xs"
                              >
                                <Check className="w-3.5 h-3.5" />
                                <span>Save</span>
                              </button>
                              <button
                                type="button"
                                onClick={handleCancelEdit}
                                disabled={savingSlId === strat.id}
                                title="Cancel"
                                className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold cursor-pointer transition-colors shadow-xs flex items-center gap-1 text-xs"
                              >
                                <X className="w-3.5 h-3.5" />
                                <span>Cancel</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      ) : (
                        /* Normal Display with Edit Pencil */
                        <div className="flex items-center gap-2 flex-wrap">
                          {isStrategyLtpSl ? (
                            <>
                              <strong className="text-slate-900 bg-white px-2 py-0.5 rounded border border-purple-200">
                                {strat.index_sl_condition === 'LESS_THAN_OR_EQUAL' ? '≤' : '≥'} ₹{strat.strategy_sl_value}
                              </strong>
                              <span className="text-[9px] font-sans font-semibold px-1.5 py-0.5 rounded border bg-purple-100 text-purple-800 border-purple-300">
                                STRAT LTP CANDLE {strat.candle_interval || 5}m
                              </span>
                            </>
                          ) : (
                            <>
                              <strong className="text-slate-900 bg-white px-2 py-0.5 rounded border border-amber-200">
                                {strat.index_sl_condition === 'LESS_THAN_OR_EQUAL' ? '≤' : '≥'} {strat.index_sl_price}
                              </strong>
                              <span className={`text-[9px] font-sans font-semibold px-1.5 py-0.5 rounded border ${
                                strat.index_sl_mode === 'CANDLE' 
                                  ? 'bg-amber-100 text-amber-800 border-amber-300' 
                                  : 'bg-blue-50 text-blue-700 border-blue-200'
                              }`}>
                                {strat.index_sl_mode === 'CANDLE' ? `CANDLE ${strat.candle_interval}m` : 'LIVE TICK'}
                              </span>
                            </>
                          )}

                          <button
                            type="button"
                            onClick={() => handleStartEdit(strat)}
                            title="Edit Stop Loss mechanism, price, or timeframe"
                            className="p-1 rounded hover:bg-white/80 text-slate-600 hover:text-blue-700 transition-colors cursor-pointer"
                          >
                            <Edit2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Middle: Live Tracking & Buffer */}
                    <div className="flex items-center gap-2.5">
                      {isStrategyLtpSl ? (
                        <span>Strat LTP: <strong className={currentStratLtp >= 0 ? 'text-emerald-700' : 'text-rose-600'}>
                          {currentStratLtp >= 0 ? '+' : ''}₹{currentStratLtp.toFixed(2)}
                        </strong></span>
                      ) : (
                        <span>Nifty: <strong className="text-slate-900">{strat.current_index_price?.toFixed(2)}</strong></span>
                      )}

                      <span className={`px-2 py-0.5 rounded font-semibold border ${
                        isCloseToSL 
                          ? 'bg-rose-600 text-white border-rose-600' 
                          : (isStrategyLtpSl ? 'bg-white text-slate-800 border-purple-200' : 'bg-white text-slate-800 border-amber-200')
                      }`}>
                        Buffer: {strat.distance_to_sl > 0 ? '+' : ''}{strat.distance_to_sl} {isStrategyLtpSl ? '₹' : 'pts'}
                      </span>
                    </div>

                    {/* Right: Candle Countdown Timer (if in CANDLE mode or STRATEGY_LTP) */}
                    {(isStrategyLtpSl || strat.index_sl_mode === 'CANDLE') && (strat.candle_interval > 0 || isStrategyLtpSl) && (
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3 h-3 text-amber-600" />
                        <span className="font-sans font-semibold text-slate-700">Candle:</span>
                        <span className="font-bold text-slate-900 bg-white px-2 py-0.5 rounded border border-amber-200">
                          {strat.candle_interval || 5}min
                        </span>
                        <span className={`px-2 py-0.5 rounded font-semibold border ${
                          (strat.candle_time_remaining_sec || 0) < 30 ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-slate-800 border-amber-200'
                        }`}>
                          ⏱ {Math.floor((strat.candle_time_remaining_sec || 0) / 60)}:{String((strat.candle_time_remaining_sec || 0) % 60).padStart(2, '0')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Collapsible Legs Table */}
                  {expandedId === strat.id && strat.legs && (
                    <div className="mt-3 pt-3 border-t border-slate-200">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                          Individual Legs Execution (Kotak Neo)
                        </div>
                        <button
                          onClick={() => handleSync(strat.id)}
                          disabled={syncingId === strat.id}
                          className="text-[11px] text-blue-600 hover:text-blue-800 font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <RefreshCw className={`w-3 h-3 ${syncingId === strat.id ? 'animate-spin' : ''}`} />
                          <span>Sync Fill Prices</span>
                        </button>
                      </div>
                      <div className="overflow-x-auto border border-slate-200 rounded-lg">
                        <table className="w-full text-xs text-left">
                          <thead className="text-[10px] text-slate-500 font-semibold uppercase bg-slate-50 border-b border-slate-200">
                            <tr>
                              <th className="py-1.5 px-3">Side</th>
                              <th className="py-1.5 px-3">Symbol</th>
                              <th className="py-1.5 px-3">Order ID</th>
                              <th className="py-1.5 px-3 text-right">Entry (Broker)</th>
                              <th className="py-1.5 px-3 text-right">LTP</th>
                              <th className="py-1.5 px-3 text-right">Qty</th>
                              <th className="py-1.5 px-3 text-right">PnL</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 font-mono bg-white font-medium">
                            {strat.legs.map((leg, idx) => {
                              const info = getLegLiveInfo(leg);
                              return (
                                <tr key={idx} className="hover:bg-slate-50/50">
                                  <td className="py-1.5 px-3">
                                    <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${
                                      leg.action === 'BUY' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                                    }`}>
                                      {leg.action}
                                    </span>
                                  </td>
                                  <td className="py-1.5 px-3 text-slate-800 font-sans font-semibold">{leg.trading_symbol}</td>
                                  <td className="py-1.5 px-3 text-slate-500 font-mono text-[10px]">
                                    {leg.order_id ? `#${leg.order_id}` : '—'}
                                  </td>
                                  <td className="py-1.5 px-3 text-right text-slate-900 font-semibold">
                                    ₹{info.entryP.toFixed(2)}
                                  </td>
                                  <td className="py-1.5 px-3 text-right text-slate-800 font-bold">
                                    <div className="inline-flex items-center justify-end gap-1">
                                      <span>₹{info.price.toFixed(2)}</span>
                                      {info.isLive && (
                                        <span className="flex h-1.5 w-1.5 relative" title="Live WS Price">
                                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="py-1.5 px-3 text-right text-slate-700">{info.qty}</td>
                                  <td className={`py-1.5 px-3 text-right font-bold ${info.pnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                    {info.pnl >= 0 ? '+' : ''}₹{info.pnl.toFixed(2)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                </div>
              );
            })
          )}
        </div>
      )}

      {/* --- HISTORICAL STRATEGIES LIST --- */}
      {activeTab === 'HISTORY' && (
        <div className="space-y-3.5">
          {/* History Header Filter & Total PnL Banner */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
            <div className="flex items-center gap-1.5 font-sans">
              <span className="text-slate-500 font-semibold text-[11px] mr-1">View:</span>
              <button
                type="button"
                onClick={() => setHistoryFilter('TODAY')}
                className={`px-2.5 py-1 rounded-lg font-bold text-xs transition-all cursor-pointer ${
                  historyFilter === 'TODAY'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                Today ({todayHistoryStrategies.length})
              </button>
              <button
                type="button"
                onClick={() => setHistoryFilter('ALL')}
                className={`px-2.5 py-1 rounded-lg font-bold text-xs transition-all cursor-pointer ${
                  historyFilter === 'ALL'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                All History ({historicalStrategies?.length || 0})
              </button>
            </div>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-slate-500 font-sans text-[11px]">Today's Total Realized P&L:</span>
              <strong className={`font-bold ${
                totalTodayRealizedPnL >= 0 ? 'text-emerald-600' : 'text-rose-600'
              }`}>
                {totalTodayRealizedPnL >= 0 ? '+' : ''}₹{totalTodayRealizedPnL.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </strong>
            </div>
          </div>

          {!displayedHistoricalStrategies || displayedHistoricalStrategies.length === 0 ? (
            <div className="py-12 text-center text-slate-400 font-medium text-xs bg-slate-50 border border-dashed border-slate-200 rounded-xl">
              {historyFilter === 'TODAY'
                ? "No closed or triggered strategies today yet. Closed strategies from today will appear here."
                : "No closed or triggered strategies yet. Past strategies with entry, exit, and P&L will appear here."}
            </div>
          ) : (
            displayedHistoricalStrategies.map((strat) => {
              const stratPnL = strat.realized_pnl !== undefined && strat.realized_pnl !== null && strat.realized_pnl !== 0
                ? strat.realized_pnl
                : (() => {
                    if (!Array.isArray(strat.legs) || strat.legs.length === 0) return 0;
                    let sum = 0;
                    let hasAny = false;
                    for (const l of strat.legs) {
                      const en = parseFloat(l.entry_price) || 0;
                      const ex = parseFloat(l.exit_price) || 0;
                      const q = l.quantity || 65;
                      const isBuy = String(l.action || '').toUpperCase().startsWith('B');
                      if (ex > 0 && en > 0) {
                        sum += isBuy ? (ex - en) * q : (en - ex) * q;
                        hasAny = true;
                      }
                    }
                    return hasAny ? Math.round(sum * 100) / 100 : (strat.realized_pnl || 0);
                  })();

              const isProfit = stratPnL > 0;
              const isLoss = stratPnL < 0;

              // Combined Strategy Entry Price (per unit)
              const stratEntryPrice = (() => {
                if (!Array.isArray(strat.legs) || strat.legs.length === 0) return null;
                let net = 0;
                for (const l of strat.legs) {
                  const p = parseFloat(l.entry_price) || 0;
                  const isBuy = String(l.action || '').toUpperCase().startsWith('B');
                  net += (isBuy ? 1 : -1) * p;
                }
                return Math.round(net * 100) / 100;
              })();

              // Combined Strategy Exit Price (per unit)
              const stratExitPrice = (() => {
                if (!Array.isArray(strat.legs) || strat.legs.length === 0) return null;
                let net = 0;
                let hasExit = false;
                for (const l of strat.legs) {
                  const p = parseFloat(l.exit_price) || 0;
                  const isBuy = String(l.action || '').toUpperCase().startsWith('B');
                  if (p > 0) {
                    net += (isBuy ? 1 : -1) * p;
                    hasExit = true;
                  }
                }
                return hasExit ? Math.round(net * 100) / 100 : null;
              })();

              // Format date times
              const entryTime = strat.created_at ? strat.created_at.replace('T', ' ').split('.')[0] : '—';
              const exitTime = strat.closed_at ? strat.closed_at.replace('T', ' ').split('.')[0] : '—';

              // Duration
              let durationStr = null;
              if (strat.created_at && strat.closed_at) {
                const start = new Date(strat.created_at.replace(' ', 'T'));
                const end = new Date(strat.closed_at.replace(' ', 'T'));
                const diffMs = end - start;
                if (!isNaN(diffMs) && diffMs > 0) {
                  const mins = Math.floor(diffMs / 60000);
                  const secs = Math.floor((diffMs % 60000) / 1000);
                  durationStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m ${secs}s`;
                }
              }

              return (
                <div
                  key={strat.id}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3.5 transition-all hover:border-slate-300"
                >
                  {/* Top Header: Name, Status Badge, Realized PnL */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-100">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-extrabold text-slate-900 text-sm">
                          #{strat.id} {strat.name}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${
                          strat.status === 'TRIGGERED_SL'
                            ? 'bg-rose-50 text-rose-700 border-rose-200'
                            : 'bg-slate-100 text-slate-700 border-slate-200'
                        }`}>
                          {strat.status === 'TRIGGERED_SL' ? 'STOP LOSS HIT' : strat.status}
                        </span>
                        {strat.close_reason && (
                          <span className="text-[10px] font-medium text-slate-600 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-md">
                            {strat.close_reason}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-medium flex items-center gap-2.5 flex-wrap">
                        <span>Type: <strong className="text-slate-700">{strat.strategy_type}</strong></span>
                        <span>Entry Spot: <strong className="font-mono text-slate-800">₹{strat.entry_index_price}</strong></span>
                        <span className="bg-blue-50/90 border border-blue-200/90 px-2 py-0.5 rounded text-blue-900 font-mono text-[10px] sm:text-[11px]">
                          Strategy Entry: <strong>{stratEntryPrice !== null ? `₹${stratEntryPrice.toFixed(2)}` : '—'}</strong>
                        </span>
                        <span className="bg-indigo-50/90 border border-indigo-200/90 px-2 py-0.5 rounded text-indigo-900 font-mono text-[10px] sm:text-[11px]">
                          Strategy Exit: <strong>{stratExitPrice !== null ? `₹${stratExitPrice.toFixed(2)}` : '—'}</strong>
                        </span>
                        <span>Stop Loss: <strong className="font-mono text-rose-600">{strat.index_sl_condition === 'LESS_THAN_OR_EQUAL' ? '≤' : '≥'} ₹{strat.index_sl_price}</strong></span>
                        <span>Net Premium: <strong className="font-mono text-slate-800">₹{strat.net_premium}</strong></span>
                      </div>
                    </div>

                    {/* Realized PnL Display */}
                    {/* Realized PnL & Delete Action Display */}
                    <div className="flex flex-col sm:items-end gap-1">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">Realized P&L</span>
                      <div className="flex items-center gap-2">
                        <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg border font-mono font-extrabold text-sm sm:text-base ${
                          isProfit 
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200' 
                            : isLoss 
                            ? 'bg-rose-50 text-rose-700 border-rose-200' 
                            : 'bg-slate-50 text-slate-700 border-slate-200'
                        }`}>
                          {isProfit ? <ArrowUpRight className="w-4 h-4 text-emerald-600" /> : isLoss ? <ArrowDownRight className="w-4 h-4 text-rose-600" /> : null}
                          <span>{stratPnL >= 0 ? '+' : ''}₹{Number(stratPnL).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>

                        {/* Delete Strategy History Record Button */}
                        <button
                          onClick={() => handleInitiateDelete(strat)}
                          title="Permanently delete historical strategy record (Requires 2-level confirmation)"
                          className="p-1.5 rounded-lg bg-slate-50 hover:bg-rose-50 border border-slate-200 hover:border-rose-300 text-slate-400 hover:text-rose-600 transition-all cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Timestamps Row: Entry DateTime & Exit DateTime */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 py-2 px-3 bg-slate-50/70 border border-slate-200/60 rounded-lg text-xs font-mono">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Clock className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                      <span>Entry: <strong className="text-slate-800">{entryTime}</strong></span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Clock className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                      <span>Exit: <strong className="text-slate-800">{exitTime}</strong></span>
                    </div>
                    {durationStr && (
                      <div className="flex items-center sm:justify-end gap-1.5 text-slate-500">
                        <span>Duration: <strong className="text-slate-700">{durationStr}</strong></span>
                      </div>
                    )}
                  </div>

                  {/* Legs Table with Entry, Exit & Leg PnL (Order IDs column removed) */}
                  {Array.isArray(strat.legs) && strat.legs.length > 0 && (
                    <div className="overflow-x-auto border border-slate-200 rounded-lg">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          <tr className="text-[11px] font-bold">
                            <th className="py-1.5 px-2.5">Side</th>
                            <th className="py-1.5 px-2">Symbol</th>
                            <th className="py-1.5 px-2 text-center">Qty</th>
                            <th className="py-1.5 px-2 text-right">Entry Price</th>
                            <th className="py-1.5 px-2 text-right">Exit Price</th>
                            <th className="py-1.5 px-2 text-right">Leg P&L</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {strat.legs.map((leg) => {
                            const en = parseFloat(leg.entry_price) || 0;
                            const ex = parseFloat(leg.exit_price) || 0;
                            const q = leg.quantity || 65;
                            const isBuy = String(leg.action || '').toUpperCase().startsWith('B');
                            const legPnl = (ex > 0 && en > 0)
                              ? Math.round((isBuy ? (ex - en) * q : (en - ex) * q) * 100) / 100
                              : (leg.realized_pnl ?? null);

                            return (
                              <tr key={leg.id} className="hover:bg-slate-50/50">
                                <td className="py-1.5 px-2.5">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    isBuy ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                                  }`}>
                                    {leg.action}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2 font-bold text-slate-800">
                                  {leg.trading_symbol}
                                </td>
                                <td className="py-1.5 px-2 text-center text-slate-600 font-semibold">
                                  {leg.quantity}
                                </td>
                                <td className="py-1.5 px-2 text-right font-bold text-slate-800">
                                  ₹{en.toFixed(2)}
                                </td>
                                <td className="py-1.5 px-2 text-right font-bold text-slate-800">
                                  {ex > 0 ? `₹${ex.toFixed(2)}` : '—'}
                                </td>
                                <td className="py-1.5 px-2 text-right font-bold">
                                  {legPnl !== null ? (
                                    <span className={legPnl >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                                      {legPnl >= 0 ? '+' : ''}₹{Number(legPnl).toFixed(2)}
                                    </span>
                                  ) : (
                                    <span className="text-slate-400">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* 2-LEVEL STRATEGY DELETION MODAL                                           */}
      {/* ========================================================================= */}
      {deleteModalState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl border-2 border-black shadow-[6px_6px_0px_0px_#000] w-full max-w-md p-5 space-y-4">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-3 border-b-2 border-black">
              <div className="flex items-center gap-2 text-rose-600 font-black text-sm uppercase tracking-wide">
                <Trash2 className="w-5 h-5 shrink-0" />
                <span>
                  {deleteModalState.step === 1 ? "Confirm Delete (Step 1 of 2)" : "Final Confirmation (Step 2 of 2)"}
                </span>
              </div>
              <button
                onClick={handleCancelDelete}
                disabled={deleteModalState.isDeleting}
                className="p-1 rounded-lg hover:bg-slate-100 border border-transparent hover:border-black transition-all cursor-pointer"
              >
                <X className="w-4 h-4 text-slate-700" />
              </button>
            </div>

            {/* Target Strategy Info Card */}
            <div className="p-3 bg-amber-50/80 border-2 border-amber-300 rounded-xl text-xs space-y-1">
              <div className="font-extrabold text-slate-900 text-sm flex items-center justify-between">
                <span>#{deleteModalState.strat.id} {deleteModalState.strat.name}</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-white border border-amber-300 font-bold uppercase">
                  {deleteModalState.strat.status}
                </span>
              </div>
              <div className="text-slate-600 font-mono text-[11px] flex items-center gap-3">
                <span>Type: {deleteModalState.strat.strategy_type}</span>
                <span>Legs: {deleteModalState.strat.legs?.length || 0}</span>
                <span>Created: {deleteModalState.strat.created_at?.split('T')[0] || '—'}</span>
              </div>
            </div>

            {/* LEVEL 1: Intent Warning & Impact Explanation */}
            {deleteModalState.step === 1 && (
              <div className="space-y-4">
                <div className="text-xs text-slate-700 space-y-2">
                  <p className="font-semibold text-slate-900 text-sm">
                    Are you sure you want to delete this strategy?
                  </p>
                  <p className="text-slate-600">
                    This will permanently remove Strategy <strong className="text-black">#{deleteModalState.strat.id}</strong> and all of its legs from the database and terminal book.
                  </p>
                  <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-[11px] font-medium leading-relaxed">
                    ⚠️ <strong>Important:</strong> If any legs are currently live or active on your Kotak Neo broker account, deleting the strategy here will <em>not</em> cancel them with the broker. Use <strong>"Square Off"</strong> first if you wish to exit broker positions.
                  </div>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleCancelDelete}
                    className="flex-1 py-2.5 px-4 rounded-xl border-2 border-black font-bold text-xs uppercase tracking-wider bg-slate-100 hover:bg-slate-200 text-slate-800 transition-all cursor-pointer shadow-[2px_2px_0px_0px_#000]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleProceedToLevel2}
                    className="flex-1 py-2.5 px-4 rounded-xl border-2 border-black font-black text-xs uppercase tracking-wider bg-[#ffc900] hover:bg-[#ffb700] text-black transition-all cursor-pointer shadow-[2px_2px_0px_0px_#000] flex items-center justify-center gap-1.5"
                  >
                    <span>Proceed to Step 2</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* LEVEL 2: Strict Security Check - Type DELETE to Confirm */}
            {deleteModalState.step === 2 && (
              <div className="space-y-4">
                <div className="space-y-2 text-xs">
                  <p className="font-black text-rose-700 uppercase tracking-wide flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0 text-rose-600" />
                    Irreversible Confirmation
                  </p>
                  <p className="text-slate-700">
                    To prevent accidental loss of data, please type <strong className="font-mono text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200">DELETE</strong> in the box below:
                  </p>
                  <input
                    type="text"
                    value={deleteModalState.confirmText || ''}
                    onChange={(e) => setDeleteModalState(prev => ({ ...prev, confirmText: e.target.value }))}
                    placeholder="Type DELETE to confirm"
                    className="w-full px-3 py-2.5 border-2 border-black rounded-xl font-mono text-sm uppercase tracking-wider focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-[2px_2px_0px_0px_#000]"
                    autoFocus
                  />
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setDeleteModalState(prev => ({ ...prev, step: 1, confirmText: '' }))}
                    disabled={deleteModalState.isDeleting}
                    className="flex-1 py-2.5 px-4 rounded-xl border-2 border-black font-bold text-xs uppercase tracking-wider bg-slate-100 hover:bg-slate-200 text-slate-800 transition-all cursor-pointer shadow-[2px_2px_0px_0px_#000]"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmDelete}
                    disabled={deleteModalState.confirmText?.trim().toUpperCase() !== 'DELETE' || deleteModalState.isDeleting}
                    className="flex-1 py-2.5 px-4 rounded-xl border-2 border-black font-black text-xs uppercase tracking-wider bg-rose-600 hover:bg-rose-700 text-white transition-all cursor-pointer shadow-[2px_2px_0px_0px_#000] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                  >
                    {deleteModalState.isDeleting ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        <span>Deleting...</span>
                      </>
                    ) : (
                      <>
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Permanently Delete</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
}
