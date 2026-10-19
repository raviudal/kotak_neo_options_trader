import React, { useState, useEffect } from 'react';
import { X, BookOpen, FileText, CheckCircle2, AlertCircle, RefreshCw, ChevronDown, ChevronRight, Clock, ShieldCheck, Hash } from 'lucide-react';
import { api } from '../services/api';

export default function OrderBookModal({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('STRATEGY_BOOK'); // 'STRATEGY_BOOK' | 'ORDER_LOGS'
  const [strategies, setStrategies] = useState([]);
  const [orderLogs, setOrderLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [testingItc, setTestingItc] = useState(false);
  const [itcNotice, setItcNotice] = useState(null);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, activeTab]);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      if (activeTab === 'STRATEGY_BOOK') {
        const data = await api.getStrategyBook();
        setStrategies(Array.isArray(data) ? data : []);
      } else {
        const logs = await api.getOrderLogs(150);
        setOrderLogs(Array.isArray(logs) ? logs : []);
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch book records');
    } finally {
      setLoading(false);
    }
  };

  const handleTestItc = async () => {
    setTestingItc(true);
    setItcNotice(null);
    try {
      const res = await api.testItcOrder();
      setItcNotice({
        type: 'success',
        text: `Test ITC Order Placed: Order #${res.order_id || 'PROCESSED'} (${res.trading_symbol} ${res.action} ${res.quantity} @ ${res.price})`
      });
      loadData();
    } catch (err) {
      setItcNotice({
        type: 'error',
        text: `ITC Test Order Error: ${err.message}`
      });
      loadData();
    } finally {
      setTestingItc(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-sm overflow-hidden">
      <div className="w-full max-w-5xl h-[88vh] bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] flex flex-col relative overflow-hidden text-black">
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b-2 border-black bg-[#f4f4f0]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-[#ff90e8] border-2 border-black text-black shadow-[2px_2px_0px_0px_#000]">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-black flex items-center gap-2">
                <span>Trading Records & Audit Book</span>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg bg-[#a3e635] text-black border border-black">
                  SEBI Compliant
                </span>
              </h3>
              <p className="text-xs font-medium text-black/70">
                Live broker order numbers, strategy executions, and full payload logs
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleTestItc}
              disabled={testingItc}
              className="gum-btn-yellow flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
              title="Test order routing with 1 share of ITC (ITC-EQ, Token 1660)"
            >
              {testingItc ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Sending ITC...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-3.5 h-3.5 text-black" />
                  <span>Test 1 Share ITC</span>
                </>
              )}
            </button>

            <button
              onClick={loadData}
              disabled={loading}
              className="p-1.5 rounded-xl border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[2px_2px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[2px_2px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {itcNotice && (
          <div className={`px-5 py-2.5 text-xs font-bold border-b-2 border-black flex items-center justify-between ${
            itcNotice.type === 'success' 
              ? 'bg-[#a3e635]/30 text-black' 
              : 'bg-[#ff4d4d]/20 text-black'
          }`}>
            <span>{itcNotice.text}</span>
            <button 
              onClick={() => setItcNotice(null)}
              className="text-[10px] uppercase font-black underline ml-3 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Tab Switcher */}
        <div className="flex border-b-2 border-black px-5 bg-white text-xs font-black gap-6">
          <button
            onClick={() => setActiveTab('STRATEGY_BOOK')}
            className={`py-3.5 border-b-4 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'STRATEGY_BOOK'
                ? 'border-black text-black font-black'
                : 'border-transparent text-black/50 hover:text-black font-bold'
            }`}
          >
            <BookOpen className="w-4 h-4" />
            <span>Strategy Execution Book ({strategies.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('ORDER_LOGS')}
            className={`py-3.5 border-b-4 flex items-center gap-2 transition-all cursor-pointer ${
              activeTab === 'ORDER_LOGS'
                ? 'border-black text-black font-black'
                : 'border-transparent text-black/50 hover:text-black font-bold'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>SEBI Order Audit Trail ({orderLogs.length})</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 font-sans text-black bg-[#f4f4f0]">
          
          {error && (
            <div className="p-3 rounded-xl bg-[#ff4d4d]/15 border-2 border-black text-black font-bold text-xs flex items-center gap-2 shadow-[2px_2px_0px_0px_#000]">
              <AlertCircle className="w-4 h-4 shrink-0 text-[#ff4d4d]" />
              <span>{error}</span>
            </div>
          )}

          {loading && (
            <div className="py-12 text-center text-black/60 flex flex-col items-center gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-black" />
              <span className="text-xs font-bold">Loading records from database...</span>
            </div>
          )}

          {/* TAB 1: STRATEGY BOOK */}
          {!loading && activeTab === 'STRATEGY_BOOK' && (
            <div className="space-y-4">
              {strategies.length === 0 ? (
                <div className="text-center py-16 text-black/50 text-xs font-semibold">
                  No strategies deployed yet. Deployed strategies and leg order IDs will be recorded here.
                </div>
              ) : (
                strategies.map((strat) => (
                  <div key={strat.id} className="bg-white border-2 border-black rounded-xl p-4 space-y-3 shadow-[3px_3px_0px_0px_#000]">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b-2 border-black/10 pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-black text-sm text-black">#{strat.id} {strat.name}</span>
                          <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-black uppercase border border-black ${
                            strat.status === 'ACTIVE'
                              ? 'bg-[#a3e635] text-black'
                              : strat.status === 'TRIGGERED_SL'
                              ? 'bg-[#ff4d4d] text-white'
                              : 'bg-black/10 text-black'
                          }`}>
                            {strat.status}
                          </span>
                          <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-black uppercase border border-black ${
                            strat.order_status === 'ALL_PLACED'
                              ? 'bg-[#90e8ff] text-black'
                              : strat.order_status === 'PARTIAL_PLACED'
                              ? 'bg-[#ffc900] text-black'
                              : 'bg-[#ff4d4d]/30 text-black'
                          }`}>
                            Broker: {strat.order_status || 'PLACED'}
                          </span>
                          {strat.status !== 'ACTIVE' && (
                            <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-black border border-black shadow-[1px_1px_0px_0px_#000] ${
                              (strat.realized_pnl || 0) > 0
                                ? 'bg-[#a3e635] text-black'
                                : (strat.realized_pnl || 0) < 0
                                ? 'bg-[#ff4d4d] text-white'
                                : 'bg-black/10 text-black'
                            }`}>
                              {(strat.realized_pnl || 0) >= 0 ? '+' : ''}₹{Number(strat.realized_pnl || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} P&L
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] font-medium text-black/70 mt-1">
                          Type: <span className="font-bold text-black">{strat.strategy_type}</span> • 
                          Entry Spot: <span className="text-black font-mono font-bold">{strat.entry_index_price}</span> • 
                          SL: <span className="text-red-600 font-mono font-black">{strat.index_sl_price}</span> • 
                          Net Premium: <span className="text-black font-mono font-bold bg-[#ff90e8]/25 px-1 rounded border border-black">₹{strat.net_premium}</span>
                        </p>

                        {/* Payoff Metrics Badge Row */}
                        {(strat.max_profit !== null || strat.max_loss !== null || strat.breakeven_low !== null) && (
                          <div className="flex flex-wrap items-center gap-1.5 mt-2 font-mono text-[10px]">
                            {strat.max_profit !== null && (
                              <span className="bg-[#a3e635]/30 text-black px-1.5 py-0.5 rounded border border-black font-bold shadow-[1px_1px_0px_0px_#000]">
                                Max P: +₹{strat.max_profit?.toLocaleString('en-IN')}
                              </span>
                            )}
                            {strat.max_loss !== null && (
                              <span className="bg-[#ff4d4d]/20 text-black px-1.5 py-0.5 rounded border border-black font-bold shadow-[1px_1px_0px_0px_#000]">
                                Max L: -₹{Math.abs(strat.max_loss)?.toLocaleString('en-IN')}
                              </span>
                            )}
                            {strat.breakeven_low !== null && (
                              <span className="bg-white text-black px-1.5 py-0.5 rounded border border-black font-bold shadow-[1px_1px_0px_0px_#000]">
                                BE: {strat.breakeven_low} {strat.breakeven_high ? `& ${strat.breakeven_high}` : ''}
                              </span>
                            )}
                            {strat.risk_reward && strat.risk_reward !== 'N/A' && (
                              <span className="bg-[#ffc900]/30 text-black px-1.5 py-0.5 rounded border border-black font-bold shadow-[1px_1px_0px_0px_#000]">
                                R:R {strat.risk_reward}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="text-[11px] text-black/70 font-mono text-right font-medium">
                        <p><span className="font-bold text-black">Entry:</span> {strat.created_at ? strat.created_at.replace('T', ' ').slice(0, 19) : '—'}</p>
                        {strat.closed_at && (
                          <p className="text-red-600 font-bold"><span className="text-black">Exit:</span> {strat.closed_at.replace('T', ' ').slice(0, 19)}</p>
                        )}
                      </div>
                    </div>

                    {/* Legs Table */}
                    <div className="overflow-x-auto border-2 border-black rounded-lg">
                      <table className="w-full text-left text-xs font-mono">
                        <thead className="bg-[#f4f4f0] border-b-2 border-black text-black">
                          <tr className="text-[11px] font-black">
                            <th className="py-2 px-2.5">Leg</th>
                            <th className="py-2 px-2">Side</th>
                            <th className="py-2 px-2">Symbol</th>
                            <th className="py-2 px-2">Qty</th>
                            <th className="py-2 px-2">Entry Price</th>
                            <th className="py-2 px-2">Exit Price</th>
                            <th className="py-2 px-2">Leg P&L</th>
                            <th className="py-2 px-2">Broker Order ID</th>
                            <th className="py-2 px-2">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-black/10 bg-white">
                          {strat.legs?.map((leg) => (
                            <tr key={leg.id} className="hover:bg-[#ff90e8]/10 transition-colors">
                              <td className="py-2 px-2.5 text-black font-bold">#{leg.id}</td>
                              <td className="py-2 px-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-black border border-black ${
                                  leg.action === 'BUY' ? 'bg-[#90e8ff] text-black' : 'bg-[#ff90e8] text-black'
                                }`}>
                                  {leg.action}
                                </span>
                              </td>
                              <td className="py-2 px-2 font-bold text-black">{leg.trading_symbol}</td>
                              <td className="py-2 px-2 text-black font-bold">{leg.quantity}</td>
                              <td className="py-2 px-2 font-mono font-bold text-black">
                                ₹{Number(leg.entry_price || 0).toFixed(2)}
                              </td>
                              <td className="py-2 px-2 font-mono font-bold text-black">
                                {leg.exit_price ? `₹${Number(leg.exit_price).toFixed(2)}` : '—'}
                              </td>
                              <td className="py-2 px-2 font-mono font-bold">
                                {leg.realized_pnl !== undefined && leg.realized_pnl !== null ? (
                                  <span className={leg.realized_pnl >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                                    {leg.realized_pnl >= 0 ? '+' : ''}₹{Number(leg.realized_pnl).toFixed(2)}
                                  </span>
                                ) : (
                                  <span className="text-black/40">—</span>
                                )}
                              </td>
                              <td className="py-2 px-2">
                                <div className="space-y-1">
                                  {leg.order_id ? (
                                    <div className="flex items-center gap-1">
                                      <span className="text-[9px] font-black text-black/60 uppercase">Entry:</span>
                                      <span className="text-black font-black bg-[#a3e635]/40 px-1.5 py-0.5 rounded border border-black shadow-[1px_1px_0px_0px_#000]">
                                        {leg.order_id}
                                      </span>
                                    </div>
                                  ) : (
                                    <span className="text-black/40 italic font-medium">Pending / Rejected</span>
                                  )}
                                  {leg.exit_order_id && (
                                    <div className="flex items-center gap-1">
                                      <span className="text-[9px] font-black text-red-600 uppercase">Exit:</span>
                                      <span className="text-black font-black bg-[#ff90e8]/40 px-1.5 py-0.5 rounded border border-black shadow-[1px_1px_0px_0px_#000]">
                                        {leg.exit_order_id}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 px-2">
                                <span className={`text-[11px] font-bold ${
                                  leg.order_id ? 'text-emerald-700' : 'text-red-600'
                                }`}>
                                  {leg.exit_order_id ? 'Squared Off' : (leg.order_id ? (leg.execution_message || 'Executed') : (leg.execution_message || 'Failed'))}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {strat.close_reason && (
                      <p className="text-[11px] text-black bg-[#ff4d4d]/15 border-2 border-black p-2 rounded-lg font-medium shadow-[2px_2px_0px_0px_#000]">
                        <strong className="font-black text-red-600">Exit Note:</strong> {strat.close_reason}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 2: SEBI ORDER AUDIT TRAIL */}
          {!loading && activeTab === 'ORDER_LOGS' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-black/70 pb-2">
                <span>SEBI Mandated Record: Timestamp, Sent Payload, Broker Order Number & RMS Response</span>
                <span className="font-mono font-black text-black bg-white px-2 py-0.5 rounded border border-black">{orderLogs.length} logs recorded</span>
              </div>

              {orderLogs.length === 0 ? (
                <div className="text-center py-16 text-black/50 text-xs font-semibold">
                  No order logs recorded in database yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {orderLogs.map((log) => {
                    const isExpanded = expandedLogId === log.id;
                    const isSuccess = log.status === 'SUCCESS';
                    return (
                      <div key={log.id} className="bg-white border-2 border-black rounded-xl overflow-hidden transition-all text-xs shadow-[2px_2px_0px_0px_#000]">
                        <div 
                          onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                          className="p-3 flex flex-wrap items-center justify-between gap-2 cursor-pointer hover:bg-[#ff90e8]/10 transition-colors"
                        >
                          <div className="flex items-center gap-2.5">
                            <span className={`p-1 rounded-lg border border-black ${isSuccess ? 'bg-[#a3e635] text-black' : 'bg-[#ff4d4d] text-white'}`}>
                              {isSuccess ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                            </span>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-black font-mono border border-black ${
                                  log.transaction_type === 'B' ? 'bg-[#90e8ff] text-black' : 'bg-[#ff90e8] text-black'
                                }`}>
                                  {log.transaction_type === 'B' ? 'BUY' : 'SELL'}
                                </span>
                                <span className="font-black text-black font-mono">{log.trading_symbol}</span>
                                <span className="text-[11px] text-black/80 font-mono font-bold">Qty: {log.quantity} @ {log.price > 0 ? `₹${log.price}` : 'MKT'}</span>
                                {log.is_amo === 'YES' && (
                                  <span className="text-[10px] bg-[#ffc900] text-black border border-black px-1.5 py-0.2 rounded font-mono font-bold">
                                    AMO
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-black/60 font-mono mt-0.5 font-medium">
                                {log.timestamp ? log.timestamp.replace('T', ' ').slice(0, 19) : ''} • Segment: {log.exchange_segment} • Product: {log.product}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-3">
                            {log.order_id ? (
                              <div className="text-right">
                                <span className="text-[10px] text-black/60 block font-mono font-semibold">Kotak Order ID</span>
                                <span className="text-black font-black font-mono bg-[#a3e635]/40 px-1.5 rounded border border-black">{log.order_id}</span>
                              </div>
                            ) : (
                              <span className="text-red-600 font-black font-mono text-[11px] bg-[#ff4d4d]/10 px-1.5 rounded border border-red-600">REJECTED</span>
                            )}
                            <span className="text-[10px] text-black/70 font-mono font-bold">{log.latency_ms} ms</span>
                            {isExpanded ? <ChevronDown className="w-4 h-4 text-black" /> : <ChevronRight className="w-4 h-4 text-black" />}
                          </div>
                        </div>

                        {/* Expanded Payload & Response Audit Details */}
                        {isExpanded && (
                          <div className="p-3 border-t-2 border-black bg-[#f4f4f0] space-y-3 font-mono text-[11px]">
                            {log.error_message && (
                              <div className="p-2 rounded-lg bg-[#ff4d4d]/15 border-2 border-black text-red-700 font-bold">
                                <strong>Rejection Reason:</strong> {log.error_message}
                              </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <span className="text-black text-[10px] font-black uppercase block mb-1">
                                  Raw Sent Payload (jData):
                                </span>
                                <pre className="p-2.5 rounded-xl bg-white border-2 border-black text-black overflow-x-auto text-[10px] leading-relaxed shadow-[2px_2px_0px_0px_#000]">
                                  {log.sent_payload}
                                </pre>
                              </div>
                              <div>
                                <span className="text-black text-[10px] font-black uppercase block mb-1">
                                  Raw Broker Response (HTTP {log.http_status}):
                                </span>
                                <pre className="p-2.5 rounded-xl bg-white border-2 border-black text-black overflow-x-auto text-[10px] leading-relaxed shadow-[2px_2px_0px_0px_#000]">
                                  {log.received_response}
                                </pre>
                              </div>
                            </div>
                          </div>
                        )}

                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t-2 border-black bg-white flex items-center justify-between text-xs font-bold text-black/70">
          <span>All order entries and broker acknowledgments are recorded to SQLite database.</span>
          <button
            onClick={onClose}
            className="gum-btn-black py-1 px-3 rounded-lg text-xs cursor-pointer"
          >
            Close
          </button>
        </div>

      </div>
    </div>
  );
}
