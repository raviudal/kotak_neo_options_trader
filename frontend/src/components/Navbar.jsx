import React from 'react';
import { ShieldCheck, Activity, Key, LogOut, Smartphone, CheckCircle2, AlertTriangle, RefreshCw, BookOpen, Server } from 'lucide-react';

export default function Navbar({ 
  user, 
  wsConnected, 
  kotakStatus, 
  niftyData, 
  serverHealth,
  onOpenKotakModal, 
  onOpen2FAModal, 
  onOpenOrderBook,
  onOpenServerInfo,
  onLogout 
}) {
  const isUp = niftyData?.change >= 0;

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 px-4 py-2.5 shadow-sm">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
        
        {/* Logo & App Name */}
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold text-base shadow-sm">
            N
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold tracking-tight text-slate-900 text-base">
                NEO<span className="bg-blue-50 text-blue-700 px-1 py-0.5 rounded ml-0.5 border border-blue-200 text-xs font-semibold">TRADER</span>
              </span>
              <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                PRO
              </span>
            </div>
            <p className="text-[11px] font-medium text-slate-500 hidden sm:block">Kotak Neo Options & Index SL Engine</p>
          </div>
        </div>

        {/* Nifty 50 Live Spot Ticker */}
        {niftyData && (
          <div className="flex items-center gap-2.5 px-3 py-1 rounded-lg bg-slate-50 border border-slate-200 shadow-sm font-mono">
            <div className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${wsConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${wsConnected ? 'bg-emerald-600' : 'bg-rose-600'}`}></span>
              </span>
              <span className="text-xs text-slate-600 font-sans font-bold">NIFTY 50</span>
            </div>
            <span className="text-sm font-bold text-slate-900">
              {niftyData.spot?.toFixed(2)}
            </span>
            <span className={`text-xs font-semibold px-1.5 py-0.2 rounded ${isUp ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'}`}>
              {isUp ? '+' : ''}{niftyData.change?.toFixed(2)} ({isUp ? '+' : ''}{niftyData.pct_change?.toFixed(2)}%)
            </span>
          </div>
        )}

        {/* Action Controls & Badges */}
        <div className="flex items-center gap-2">
          
          {/* Kotak Neo Broker Status Pill */}
          <button 
            onClick={onOpenKotakModal}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border shadow-sm transition-all cursor-pointer ${
              kotakStatus?.is_connected 
                ? (kotakStatus.is_simulation 
                    ? 'bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100' 
                    : 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100')
                : 'bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100'
            }`}
          >
            {kotakStatus?.is_connected ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span className="hidden sm:inline">Kotak:</span>
                <span>{kotakStatus.is_simulation ? 'Paper' : 'Live'}</span>
              </>
            ) : (
              <>
                <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                <span className="hidden sm:inline">Kotak:</span>
                <span>Connect</span>
              </>
            )}
          </button>

          {/* Order Book Button */}
          <button
            onClick={onOpenOrderBook}
            title="Order & Strategy Execution Book"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-sm transition-all text-xs font-medium cursor-pointer"
          >
            <BookOpen className="w-3.5 h-3.5 text-slate-600" />
            <span className="hidden sm:inline">Order Book</span>
          </button>

          {/* Server Info Button */}
          <button
            onClick={onOpenServerInfo}
            title="Server Health & Host Controls"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-sm transition-all text-xs font-medium cursor-pointer"
          >
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                serverHealth?.status === 'CRITICAL' ? 'bg-rose-500' : (serverHealth?.status === 'WARNING' ? 'bg-amber-500' : 'bg-emerald-500')
              }`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${
                serverHealth?.status === 'CRITICAL' ? 'bg-rose-600' : (serverHealth?.status === 'WARNING' ? 'bg-amber-600' : 'bg-emerald-600')
              }`}></span>
            </span>
            <Server className="w-3.5 h-3.5 text-slate-600" />
            <span className="hidden sm:inline">Server Info</span>
          </button>

          {/* 2FA Authenticator Button */}
          <button 
            onClick={onOpen2FAModal}
            title="Google Authenticator 2FA Key"
            className="p-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 shadow-sm transition-all cursor-pointer"
          >
            <ShieldCheck className="w-4 h-4 text-slate-600" />
          </button>

          {/* User & Logout */}
          <div className="flex items-center gap-1.5 pl-1.5 border-l border-slate-200">
            <span className="text-xs text-slate-700 font-semibold hidden md:inline px-1">
              {user?.username}
            </span>
            <button 
              onClick={onLogout}
              title="Logout"
              className="p-1.5 rounded-lg hover:bg-rose-50 text-slate-500 hover:text-rose-600 transition-all cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>

        </div>

      </div>
    </header>
  );
}
