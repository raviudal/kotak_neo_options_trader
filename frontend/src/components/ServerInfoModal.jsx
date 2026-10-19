import React, { useState, useEffect } from 'react';
import { 
  Server, Cpu, HardDrive, Database, Activity, Clock, 
  Wifi, RefreshCw, CheckCircle2, AlertTriangle, ShieldAlert, 
  X, Power, RotateCw, AlertOctagon, Check
} from 'lucide-react';
import { api } from '../services/api';

export default function ServerInfoModal({ 
  isOpen, 
  onClose, 
  liveHealthData, 
  wsConnected 
}) {
  const [health, setHealth] = useState(liveHealthData || null);
  const [latency, setLatency] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  // Restart & Reboot confirmation state
  // null | { type: 'RESTART_SERVICE' | 'REBOOT_SERVER', step: 1 | 2 }
  const [confirmAction, setConfirmAction] = useState(null);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionMessage, setExecutionMessage] = useState(null);
  const [reconnectCountdown, setReconnectCountdown] = useState(null);

  // Update whenever liveHealthData arrives from WebSocket
  useEffect(() => {
    if (liveHealthData) {
      setHealth(liveHealthData);
      setLastRefreshed(new Date());
    }
  }, [liveHealthData]);

  // Periodic polling when modal is open
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    const fetchHealth = async () => {
      const startTime = performance.now();
      try {
        const data = await api.getServerHealth();
        if (isMounted) {
          const rtt = Math.round(performance.now() - startTime);
          setHealth(data);
          setLatency(rtt);
          setLastRefreshed(new Date());
        }
      } catch (err) {
        // server might be restarting
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 2500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [isOpen]);

  // Handle countdown & auto-reconnect polling after restart/reboot
  useEffect(() => {
    if (reconnectCountdown === null || reconnectCountdown <= 0) return;

    const timer = setInterval(() => {
      setReconnectCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          // Attempt reload
          window.location.reload();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [reconnectCountdown]);

  if (!isOpen) return null;

  const cpuPct = health?.cpu_percent || 0;
  const memPct = health?.memory?.percent || 0;
  const diskPct = health?.disk?.percent || 0;

  const getStatusBadge = () => {
    if (!health) return { bg: 'bg-[#ffc900] text-black', label: 'CONNECTING...' };
    if (health.status === 'CRITICAL' || cpuPct >= 95 || memPct >= 95) {
      return { bg: 'bg-[#ff6363] text-white', label: 'CRITICAL LOAD' };
    }
    if (health.status === 'WARNING' || cpuPct >= 80 || memPct >= 85) {
      return { bg: 'bg-[#ffc900] text-black', label: 'ELEVATED LOAD' };
    }
    return { bg: 'bg-[#a3e635] text-black', label: 'HEALTHY / ONLINE' };
  };

  const statusBadge = getStatusBadge();

  // Execute Action after Double Confirmation
  const handleFinalConfirm = async () => {
    if (!confirmAction) return;
    setIsExecuting(true);
    setExecutionMessage('Sending instruction to host...');

    try {
      if (confirmAction.type === 'RESTART_SERVICE') {
        const res = await api.restartService();
        setExecutionMessage(res.message || 'Service restart initiated.');
        setReconnectCountdown(6);
      } else if (confirmAction.type === 'REBOOT_SERVER') {
        const res = await api.rebootServer();
        setExecutionMessage(res.message || 'Server reboot initiated.');
        setReconnectCountdown(35);
      }
    } catch (err) {
      // If server closed connection immediately, that indicates success
      setExecutionMessage('Restart triggered. Waiting for host to reconnect...');
      setReconnectCountdown(confirmAction.type === 'RESTART_SERVICE' ? 6 : 35);
    } finally {
      setIsExecuting(false);
    }
  };

  const cancelConfirmation = () => {
    setConfirmAction(null);
    setTypedConfirm('');
    setExecutionMessage(null);
  };

  return (
    <div className="fixed inset-0 bg-neutral-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white border-2 border-black rounded-2xl p-5 sm:p-6 shadow-[6px_6px_0px_0px_#000] w-full max-w-2xl max-h-[90vh] overflow-y-auto text-black">
        
        {/* Header */}
        <div className="flex items-center justify-between pb-3.5 border-b-2 border-black mb-5">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#ff90e8] text-black border-2 border-black shadow-[2px_2px_0px_0px_#000]">
              <Server className="w-5 h-5 text-black" />
            </div>
            <div>
              <h3 className="text-base font-black text-black flex items-center gap-2">
                <span>Server Health & Host Controls</span>
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg border border-black shadow-[1px_1px_0px_0px_#000] ${statusBadge.bg}`}>
                  {statusBadge.label}
                </span>
              </h3>
              <p className="text-xs text-neutral-600 font-medium">Real-time resources, system statistics & power controls</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl hover:bg-neutral-100 border-2 border-black shadow-[2px_2px_0px_0px_#000] text-black cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Reconnect / Action Countdown Banner */}
        {reconnectCountdown !== null ? (
          <div className="p-6 rounded-2xl bg-[#fef9c3] border-2 border-black shadow-[3px_3px_0px_0px_#000] text-center space-y-3 mb-5">
            <RefreshCw className="w-8 h-8 text-black animate-spin mx-auto" />
            <h4 className="font-black text-base text-black">
              {confirmAction?.type === 'REBOOT_SERVER' ? 'Virtual Machine Rebooting...' : 'Restarting Trading Engine Service...'}
            </h4>
            <p className="text-xs font-bold text-neutral-700">{executionMessage}</p>
            <div className="text-2xl font-mono font-black text-black bg-white px-4 py-2 rounded-xl border-2 border-black inline-block shadow-[2px_2px_0px_0px_#000]">
              Reconnecting in {reconnectCountdown}s
            </div>
          </div>
        ) : (
          <>
            {/* Top Status & Live Clock Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
              
              {/* Live Status */}
              <div className="p-3 bg-[#f4f4f0] border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000] flex items-center gap-2.5">
                <span className="relative flex h-3 w-3 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-black"></span>
                </span>
                <div>
                  <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">System Status</span>
                  <span className="text-xs font-black font-mono text-black">{statusBadge.label}</span>
                </div>
              </div>

              {/* Server Time (IST) */}
              <div className="p-3 bg-[#fef9c3] border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000] flex items-center gap-2">
                <Clock className="w-4 h-4 text-black shrink-0" />
                <div>
                  <span className="text-[10px] text-neutral-700 font-bold uppercase block font-sans">Server Time (IST)</span>
                  <span className="text-xs font-black font-mono text-black">{health?.server_time || 'IST Time'}</span>
                </div>
              </div>

              {/* Uptime */}
              <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000] flex items-center gap-2">
                <Activity className="w-4 h-4 text-black shrink-0" />
                <div>
                  <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">System Uptime</span>
                  <span className="text-xs font-black font-mono text-black">{health?.uptime_formatted || '—'}</span>
                </div>
              </div>

            </div>

            {/* Core Resource Gauges */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-5 font-mono">
              
              {/* CPU Gauge */}
              <div className="p-4 bg-white border-2 border-black rounded-xl shadow-[3px_3px_0px_0px_#000]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-black text-black flex items-center gap-1 font-sans">
                    <Cpu className="w-4 h-4 text-black" />
                    <span>CPU Usage</span>
                  </span>
                  <span className="text-[10px] font-bold bg-[#f4f4f0] px-1.5 py-0.5 rounded border border-black">
                    {health?.cpu_cores || 1} Cores
                  </span>
                </div>
                <div className="text-2xl font-black text-black mb-2">
                  {cpuPct}%
                </div>
                {/* Progress Bar */}
                <div className="w-full h-3 bg-[#f4f4f0] rounded-full border-2 border-black overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-300 ${cpuPct > 80 ? 'bg-[#ff6363]' : (cpuPct > 50 ? 'bg-[#ffc900]' : 'bg-[#a3e635]')}`}
                    style={{ width: `${Math.min(100, Math.max(3, cpuPct))}%` }}
                  />
                </div>
              </div>

              {/* RAM (Memory) Gauge */}
              <div className="p-4 bg-white border-2 border-black rounded-xl shadow-[3px_3px_0px_0px_#000]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-black text-black flex items-center gap-1 font-sans">
                    <Server className="w-4 h-4 text-black" />
                    <span>RAM (Memory)</span>
                  </span>
                  <span className="text-[10px] font-bold bg-[#f4f4f0] px-1.5 py-0.5 rounded border border-black">
                    {memPct}%
                  </span>
                </div>
                <div className="text-lg font-black text-black mb-0.5">
                  {health?.memory?.used_gb || 0} / {health?.memory?.total_gb || 0} GB
                </div>
                <span className="text-[10px] text-neutral-500 font-sans block mb-2 font-bold">
                  Free: {health?.memory?.free_gb || 0} GB available
                </span>
                {/* Progress Bar */}
                <div className="w-full h-3 bg-[#f4f4f0] rounded-full border-2 border-black overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-300 ${memPct > 85 ? 'bg-[#ff6363]' : (memPct > 60 ? 'bg-[#ffc900]' : 'bg-[#a3e635]')}`}
                    style={{ width: `${Math.min(100, Math.max(3, memPct))}%` }}
                  />
                </div>
              </div>

              {/* Disk Storage Gauge */}
              <div className="p-4 bg-white border-2 border-black rounded-xl shadow-[3px_3px_0px_0px_#000]">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-black text-black flex items-center gap-1 font-sans">
                    <HardDrive className="w-4 h-4 text-black" />
                    <span>Disk Storage</span>
                  </span>
                  <span className="text-[10px] font-bold bg-[#f4f4f0] px-1.5 py-0.5 rounded border border-black">
                    {diskPct}%
                  </span>
                </div>
                <div className="text-lg font-black text-black mb-0.5">
                  {health?.disk?.used_gb || 0} / {health?.disk?.total_gb || 0} GB
                </div>
                <span className="text-[10px] text-neutral-500 font-sans block mb-2 font-bold">
                  Free: {health?.disk?.free_gb || 0} GB root
                </span>
                {/* Progress Bar */}
                <div className="w-full h-3 bg-[#f4f4f0] rounded-full border-2 border-black overflow-hidden">
                  <div 
                    className={`h-full transition-all duration-300 ${diskPct > 90 ? 'bg-[#ff6363]' : 'bg-[#90e8ff]'}`}
                    style={{ width: `${Math.min(100, Math.max(3, diskPct))}%` }}
                  />
                </div>
              </div>

            </div>

            {/* Extended Host Diagnostics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-6 text-xs font-mono">
              <div className="p-3 bg-[#f4f4f0] rounded-xl border border-black">
                <span className="text-[10px] text-neutral-600 uppercase font-sans font-bold block">App Process RSS</span>
                <span className="font-black text-black">{health?.process?.memory_mb || 0} MB</span>
              </div>

              <div className="p-3 bg-[#f4f4f0] rounded-xl border border-black">
                <span className="text-[10px] text-neutral-600 uppercase font-sans font-bold block">App Threads / PID</span>
                <span className="font-black text-black">{health?.process?.threads || 1} th / #{health?.process?.pid || '—'}</span>
              </div>

              <div className="p-3 bg-[#f4f4f0] rounded-xl border border-black">
                <span className="text-[10px] text-neutral-600 uppercase font-sans font-bold block">API Latency / RTT</span>
                <span className="font-black text-black">{latency !== null ? `${latency} ms` : '—'}</span>
              </div>

              <div className="p-3 bg-[#f4f4f0] rounded-xl border border-black">
                <span className="text-[10px] text-neutral-600 uppercase font-sans font-bold block">Connected Clients</span>
                <span className="font-black text-black">{health?.active_clients || 1} WS active</span>
              </div>
            </div>

            {/* Host Controls & Double Confirmation Section */}
            <div className="p-4 sm:p-5 rounded-2xl bg-white border-2 border-black shadow-[4px_4px_0px_0px_#000] space-y-4">
              
              <div className="flex items-center justify-between pb-2 border-b-2 border-black">
                <div className="flex items-center gap-2">
                  <AlertOctagon className="w-4 h-4 text-black" />
                  <span className="font-black text-xs uppercase tracking-wider text-black">
                    Server Power & Restart Controls
                  </span>
                </div>
                <span className="text-[10px] font-mono font-bold bg-[#fee2e2] text-rose-900 px-2 py-0.5 rounded border border-black">
                  Protected Actions
                </span>
              </div>

              {/* No Action Selected: Show Initial Restart & Reboot Buttons */}
              {!confirmAction && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  
                  {/* Option 1: Restart Service */}
                  <div className="p-3.5 bg-[#fef9c3] rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] flex flex-col justify-between space-y-3">
                    <div>
                      <h5 className="font-black text-xs text-black flex items-center gap-1.5">
                        <RotateCw className="w-4 h-4 text-black" />
                        <span>Restart Trading Service</span>
                      </h5>
                      <p className="text-[11px] text-neutral-700 font-medium mt-1">
                        Restarts <code>neotrader.service</code>. Reconnects in 3–5 seconds without rebooting the OS.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmAction({ type: 'RESTART_SERVICE', step: 1 });
                        setTypedConfirm('');
                      }}
                      className="w-full py-2.5 px-3 bg-[#ffc900] hover:bg-[#ffbe00] text-black font-black text-xs uppercase tracking-wider rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] active:translate-x-[1px] active:translate-y-[1px] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      <RotateCw className="w-3.5 h-3.5 text-black" />
                      <span>Restart Service</span>
                    </button>
                  </div>

                  {/* Option 2: Reboot Virtual Machine */}
                  <div className="p-3.5 bg-[#fee2e2] rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] flex flex-col justify-between space-y-3">
                    <div>
                      <h5 className="font-black text-xs text-rose-950 flex items-center gap-1.5">
                        <Power className="w-4 h-4 text-rose-900" />
                        <span>Reboot Host VM</span>
                      </h5>
                      <p className="text-[11px] text-neutral-700 font-medium mt-1">
                        Reboots the entire Google Cloud VM host. The server will be offline for ~35 seconds.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmAction({ type: 'REBOOT_SERVER', step: 1 });
                        setTypedConfirm('');
                      }}
                      className="w-full py-2.5 px-3 bg-[#ff6363] hover:bg-[#ff4d4d] text-white font-black text-xs uppercase tracking-wider rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] active:translate-x-[1px] active:translate-y-[1px] transition-all cursor-pointer flex items-center justify-center gap-1.5"
                    >
                      <Power className="w-3.5 h-3.5 text-white" />
                      <span>Reboot Server VM</span>
                    </button>
                  </div>

                </div>
              )}

              {/* Step 1 Confirmation */}
              {confirmAction && confirmAction.step === 1 && (
                <div className="p-4 bg-[#f4f4f0] rounded-xl border-2 border-black shadow-[3px_3px_0px_0px_#000] space-y-3 animate-in fade-in duration-150">
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <h5 className="font-black text-xs text-black uppercase">
                        Step 1: Confirm {confirmAction.type === 'RESTART_SERVICE' ? 'Trading Service Restart' : 'Full Server Reboot'}
                      </h5>
                      <p className="text-xs text-neutral-700 mt-1">
                        {confirmAction.type === 'RESTART_SERVICE'
                          ? 'Are you sure you want to restart the background trading engine? Real-time feeds and WebSocket connections will temporarily reload.'
                          : 'Are you sure you want to reboot the entire Google Cloud virtual machine? All active connections will disconnect until reboot finishes (~35s).'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-neutral-300">
                    <button
                      type="button"
                      onClick={cancelConfirmation}
                      className="px-3.5 py-1.5 bg-white hover:bg-neutral-100 text-black font-bold text-xs rounded-xl border-2 border-black shadow-[1px_1px_0px_0px_#000] cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmAction({ ...confirmAction, step: 2 })}
                      className="px-4 py-1.5 bg-[#ff90e8] hover:bg-[#ff7be5] text-black font-black text-xs uppercase rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] cursor-pointer"
                    >
                      Continue to Final Confirmation →
                    </button>
                  </div>
                </div>
              )}

              {/* Step 2 Double Confirmation (Require typing exact word) */}
              {confirmAction && confirmAction.step === 2 && (
                <div className="p-4 bg-[#fee2e2] rounded-xl border-2 border-black shadow-[3px_3px_0px_0px_#000] space-y-3 animate-in fade-in duration-150">
                  <div className="flex items-start gap-2.5">
                    <ShieldAlert className="w-5 h-5 text-rose-700 shrink-0 mt-0.5" />
                    <div className="w-full">
                      <h5 className="font-black text-xs text-rose-950 uppercase">
                        Step 2 (Double Confirmation): Type "{confirmAction.type === 'RESTART_SERVICE' ? 'RESTART' : 'REBOOT'}" to Proceed
                      </h5>
                      <p className="text-xs text-rose-900 mt-1">
                        To prevent accidental clicks, please type{' '}
                        <strong className="underline decoration-black underline-offset-2">
                          {confirmAction.type === 'RESTART_SERVICE' ? 'RESTART' : 'REBOOT'}
                        </strong>{' '}
                        in the field below:
                      </p>

                      <div className="mt-2.5">
                        <input
                          type="text"
                          value={typedConfirm}
                          onChange={(e) => setTypedConfirm(e.target.value.toUpperCase())}
                          placeholder={`Type ${confirmAction.type === 'RESTART_SERVICE' ? 'RESTART' : 'REBOOT'}`}
                          autoFocus
                          className="w-full bg-white border-2 border-black rounded-xl px-3 py-2 text-xs font-mono font-black text-black placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-rose-500 shadow-[2px_2px_0px_0px_#000]"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-rose-300">
                    <button
                      type="button"
                      onClick={cancelConfirmation}
                      disabled={isExecuting}
                      className="px-3.5 py-1.5 bg-white hover:bg-neutral-100 text-black font-bold text-xs rounded-xl border-2 border-black shadow-[1px_1px_0px_0px_#000] cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleFinalConfirm}
                      disabled={
                        isExecuting || 
                        typedConfirm !== (confirmAction.type === 'RESTART_SERVICE' ? 'RESTART' : 'REBOOT')
                      }
                      className="px-4 py-1.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white font-black text-xs uppercase tracking-wider rounded-xl border-2 border-black shadow-[2px_2px_0px_0px_#000] cursor-pointer disabled:cursor-not-allowed flex items-center gap-1.5"
                    >
                      {isExecuting ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Initiating...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>
                            {confirmAction.type === 'RESTART_SERVICE' ? 'Confirm Service Restart' : 'Confirm Host Reboot'}
                          </span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

            </div>
          </>
        )}

      </div>
    </div>
  );
}
