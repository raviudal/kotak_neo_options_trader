import React from 'react';
import { TrendingUp, TrendingDown, Radio } from 'lucide-react';

export default function NiftyBanner({ niftyData, isConnected }) {
  if (!niftyData) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-4 text-center text-slate-500 font-semibold text-xs shadow-sm">
        Connecting to Kotak Neo live feed...
      </div>
    );
  }

  const isUp = niftyData.change >= 0;
  const isLive = niftyData.is_live && niftyData.spot > 0;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm relative overflow-hidden">
      
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        
        {/* Spot & Overview */}
        <div className="flex items-center gap-3.5">
          <div className={`p-2.5 rounded-xl border ${isUp ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-rose-50 text-rose-600 border-rose-200'}`}>
            {isUp ? <TrendingUp className="w-6 h-6" /> : <TrendingDown className="w-6 h-6" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900 font-mono">
                {isLive ? niftyData.spot?.toFixed(2) : 'Awaiting Ticks'}
              </h2>
              {isLive && (
                <span className={`text-xs sm:text-sm font-bold px-2 py-0.5 rounded-md border ${
                  isUp ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}>
                  {isUp ? '+' : ''}{niftyData.change?.toFixed(2)} ({isUp ? '+' : ''}{niftyData.pct_change?.toFixed(2)}%)
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs font-semibold text-slate-600">NSE Nifty 50 Index Spot</p>
              <span className={`flex items-center gap-1.5 text-[10px] font-bold font-mono px-2 py-0.5 rounded-full border ${
                isLive 
                  ? 'bg-blue-50 text-blue-700 border-blue-200' 
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}>
                <Radio className={`w-3 h-3 ${isLive ? 'animate-pulse text-blue-600' : 'text-amber-600'}`} />
                <span>{isLive ? 'LIVE WEBSOCKET' : 'CONNECTING FEED'}</span>
              </span>
            </div>
          </div>
        </div>

        {/* OHLC Mini-Stats */}
        <div className="grid grid-cols-4 gap-2 sm:gap-2.5 w-full lg:w-auto font-mono text-xs">
          <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 text-center">
            <span className="text-[10px] font-semibold text-slate-500 block uppercase font-sans">Open</span>
            <span className="font-bold text-slate-800 text-xs sm:text-sm">{niftyData.open > 0 ? niftyData.open?.toFixed(2) : '--'}</span>
          </div>
          <div className="p-2 rounded-lg bg-emerald-50/50 border border-emerald-200 text-center">
            <span className="text-[10px] font-semibold text-emerald-800 block uppercase font-sans">High</span>
            <span className="font-bold text-emerald-700 text-xs sm:text-sm">{niftyData.high > 0 ? niftyData.high?.toFixed(2) : '--'}</span>
          </div>
          <div className="p-2 rounded-lg bg-rose-50/50 border border-rose-200 text-center">
            <span className="text-[10px] font-semibold text-rose-800 block uppercase font-sans">Low</span>
            <span className="font-bold text-rose-700 text-xs sm:text-sm">{niftyData.low > 0 ? niftyData.low?.toFixed(2) : '--'}</span>
          </div>
          <div className="p-2 rounded-lg bg-slate-50 border border-slate-200 text-center">
            <span className="text-[10px] font-semibold text-slate-500 block uppercase font-sans">Prev Close</span>
            <span className="font-bold text-slate-800 text-xs sm:text-sm">{niftyData.prev_close > 0 ? niftyData.prev_close?.toFixed(2) : '--'}</span>
          </div>
        </div>

      </div>

    </div>
  );
}
