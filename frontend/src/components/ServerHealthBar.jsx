import React, { useState, useEffect } from 'react';
import { 
  Server, Cpu, HardDrive, Database, Activity, Clock, 
  Wifi, ChevronUp, ChevronDown, RefreshCw, CheckCircle2, AlertTriangle, ShieldAlert
} from 'lucide-react';
import { api } from '../services/api';

export default function ServerHealthBar({ liveHealthData, wsConnected }) {
  const [health, setHealth] = useState(liveHealthData || null);
  const [latency, setLatency] = useState(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  // Sync when parent provides live data over WebSocket
  useEffect(() => {
    if (liveHealthData) {
      setHealth(liveHealthData);
      setLastUpdated(new Date());
    }
  }, [liveHealthData]);

  // Periodic fallback polling (every 3 seconds) to ensure metrics are live even if WS pauses
  useEffect(() => {
    let isMounted = true;

    const fetchHealth = async () => {
      const startTime = performance.now();
      try {
        const data = await api.getServerHealth();
        if (isMounted) {
          const rtt = Math.round(performance.now() - startTime);
          setHealth(data);
          setLatency(rtt);
          setLastUpdated(new Date());
        }
      } catch (err) {
        // Silently catch if unauthenticated or network pause
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  if (!health) {
    return (
      <div className="bg-white border-t-2 border-black py-2 px-4 flex items-center justify-between text-xs font-mono font-bold text-neutral-600">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-black" />
          <span>Connecting to server health monitor...</span>
        </div>
      </div>
    );
  }

  const cpuPct = health.cpu_percent || 0;
  const memPct = health.memory?.percent || 0;
  const diskPct = health.disk?.percent || 0;

  // Status colors based on thresholds
  const getStatusBadge = () => {
    if (health.status === 'CRITICAL' || cpuPct >= 95 || memPct >= 95) {
      return {
        bg: 'bg-[#ff6363] text-white',
        border: 'border-black',
        label: 'CRITICAL',
        icon: <ShieldAlert className="w-3.5 h-3.5 text-white" />
      };
    }
    if (health.status === 'WARNING' || cpuPct >= 80 || memPct >= 85) {
      return {
        bg: 'bg-[#ffc900] text-black',
        border: 'border-black',
        label: 'HIGH LOAD',
        icon: <AlertTriangle className="w-3.5 h-3.5 text-black" />
      };
    }
    return {
      bg: 'bg-[#a3e635] text-black',
      border: 'border-black',
      label: 'ONLINE / HEALTHY',
      icon: <CheckCircle2 className="w-3.5 h-3.5 text-black" />
    };
  };

  const statusBadge = getStatusBadge();

  return (
    <div className="bg-white border-t-2 border-black shadow-[0_-3px_0px_0px_#000] text-black select-none transition-all duration-200">
      
      {/* Expanded Details Drawer */}
      {isExpanded && (
        <div className="p-4 sm:p-5 bg-[#f4f4f0] border-b-2 border-black grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 text-xs font-mono">
          
          {/* OS & Architecture */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">Server Environment</span>
            <span className="font-black text-black block mt-0.5">{health.platform} Linux / GCP</span>
            <span className="text-[10px] text-neutral-500 font-sans block">PID: {health.process?.pid || '—'}</span>
          </div>

          {/* Process Memory */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">Trading App RSS</span>
            <span className="font-black text-black block mt-0.5">{health.process?.memory_mb || 0} MB</span>
            <span className="text-[10px] text-neutral-500 font-sans block">{health.process?.threads || 1} active threads</span>
          </div>

          {/* Available Memory */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">RAM Available</span>
            <span className="font-black text-emerald-700 block mt-0.5">{health.memory?.free_gb || 0} GB Free</span>
            <span className="text-[10px] text-neutral-500 font-sans block">of {health.memory?.total_gb || 0} GB total</span>
          </div>

          {/* Free Disk */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">Free Storage</span>
            <span className="font-black text-emerald-700 block mt-0.5">{health.disk?.free_gb || 0} GB Free</span>
            <span className="text-[10px] text-neutral-500 font-sans block">of {health.disk?.total_gb || 0} GB root</span>
          </div>

          {/* Network Latency */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">API Latency / RTT</span>
            <span className="font-black text-black block mt-0.5">{latency !== null ? `${latency} ms` : '—'}</span>
            <span className="text-[10px] text-emerald-700 font-sans font-bold block">HTTP/WS Active</span>
          </div>

          {/* Active Clients */}
          <div className="p-3 bg-white border-2 border-black rounded-xl shadow-[2px_2px_0px_0px_#000]">
            <span className="text-[10px] text-neutral-600 font-bold uppercase block font-sans">WS Active Sessions</span>
            <span className="font-black text-black block mt-0.5">{health.active_clients || 1} connected</span>
            <span className="text-[10px] text-neutral-500 font-sans block">Real-time sync</span>
          </div>

        </div>
      )}

      {/* Main Sticky Bottom Status Bar */}
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        
        {/* Left Section: Live Pulse & System Status Badge */}
        <div className="flex items-center gap-2.5">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border-2 font-mono font-black text-[11px] shadow-[2px_2px_0px_0px_#000] ${statusBadge.bg} ${statusBadge.border}`}>
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-black"></span>
            </span>
            <span>{statusBadge.label}</span>
          </div>

          {/* Server Uptime */}
          <div className="hidden sm:flex items-center gap-1 font-mono text-neutral-700 font-bold text-[11px] bg-[#f4f4f0] px-2 py-0.5 rounded-md border border-black">
            <Activity className="w-3 h-3 text-black" />
            <span>Up: <strong>{health.uptime_formatted || '0s'}</strong></span>
          </div>
        </div>

        {/* Middle Section: Live Resource Gauges (CPU, RAM, Disk) */}
        <div className="flex items-center flex-wrap gap-2.5 sm:gap-4 font-mono text-xs">
          
          {/* CPU Gauge */}
          <div className="flex items-center gap-2 bg-[#f4f4f0] px-2.5 py-1 rounded-xl border border-black shadow-[1px_1px_0px_0px_#000]">
            <div className="flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5 text-black" />
              <span className="font-bold text-[11px] text-neutral-600">CPU:</span>
              <span className={`font-black text-xs ${cpuPct > 80 ? 'text-rose-700' : 'text-black'}`}>
                {cpuPct}%
              </span>
            </div>
            {/* Visual Mini Progress Bar */}
            <div className="w-12 h-2 bg-white rounded-full border border-black overflow-hidden hidden md:block">
              <div 
                className={`h-full transition-all duration-300 ${cpuPct > 80 ? 'bg-[#ff6363]' : (cpuPct > 50 ? 'bg-[#ffc900]' : 'bg-[#a3e635]')}`}
                style={{ width: `${Math.min(100, Math.max(5, cpuPct))}%` }}
              />
            </div>
            <span className="text-[9px] text-neutral-500 hidden lg:inline">({health.cpu_cores}c)</span>
          </div>

          {/* RAM Gauge */}
          <div className="flex items-center gap-2 bg-[#f4f4f0] px-2.5 py-1 rounded-xl border border-black shadow-[1px_1px_0px_0px_#000]">
            <div className="flex items-center gap-1">
              <Server className="w-3.5 h-3.5 text-black" />
              <span className="font-bold text-[11px] text-neutral-600">RAM:</span>
              <span className={`font-black text-xs ${memPct > 85 ? 'text-rose-700' : 'text-black'}`}>
                {health.memory?.used_gb || 0} / {health.memory?.total_gb || 0} GB
              </span>
              <span className="text-[10px] text-neutral-500 font-bold hidden sm:inline">({memPct}%)</span>
            </div>
            {/* Visual Mini Progress Bar */}
            <div className="w-12 h-2 bg-white rounded-full border border-black overflow-hidden hidden md:block">
              <div 
                className={`h-full transition-all duration-300 ${memPct > 85 ? 'bg-[#ff6363]' : (memPct > 60 ? 'bg-[#ffc900]' : 'bg-[#a3e635]')}`}
                style={{ width: `${Math.min(100, Math.max(5, memPct))}%` }}
              />
            </div>
          </div>

          {/* Disk Gauge */}
          <div className="flex items-center gap-2 bg-[#f4f4f0] px-2.5 py-1 rounded-xl border border-black shadow-[1px_1px_0px_0px_#000] hidden sm:flex">
            <div className="flex items-center gap-1">
              <HardDrive className="w-3.5 h-3.5 text-black" />
              <span className="font-bold text-[11px] text-neutral-600">Disk:</span>
              <span className={`font-black text-xs ${diskPct > 90 ? 'text-rose-700' : 'text-black'}`}>
                {diskPct}%
              </span>
            </div>
            <div className="w-10 h-2 bg-white rounded-full border border-black overflow-hidden hidden lg:block">
              <div 
                className={`h-full transition-all duration-300 ${diskPct > 90 ? 'bg-[#ff6363]' : 'bg-[#90e8ff]'}`}
                style={{ width: `${Math.min(100, Math.max(5, diskPct))}%` }}
              />
            </div>
            <span className="text-[9px] text-neutral-500 hidden xl:inline">({health.disk?.used_gb}G/{health.disk?.total_gb}G)</span>
          </div>

        </div>

        {/* Right Section: Live Server Time (IST) & Drawer Toggle */}
        <div className="flex items-center gap-2 ml-auto">
          
          {/* Server Time (IST) */}
          <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-black bg-[#fef9c3] px-2.5 py-1 rounded-lg border border-black shadow-[1px_1px_0px_0px_#000]">
            <Clock className="w-3.5 h-3.5 text-black shrink-0" />
            <span>{health.server_time || 'IST Time'}</span>
          </div>

          {/* Details Toggle Button */}
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white hover:bg-neutral-100 border border-black text-[11px] font-bold shadow-[1px_1px_0px_0px_#000] transition-all cursor-pointer"
            title={isExpanded ? "Collapse server details" : "Expand server details"}
          >
            <span className="hidden sm:inline">{isExpanded ? 'Less' : 'Details'}</span>
            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>

        </div>

      </div>

    </div>
  );
}
