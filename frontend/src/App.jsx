import React, { useState, useEffect, useRef } from 'react';
import Navbar from './components/Navbar';
import LoginModal from './components/LoginModal';
import Setup2FAModal from './components/Setup2FAModal';
import KotakModal from './components/KotakModal';
import NiftyBanner from './components/NiftyBanner';
import StrategyBuilder from './components/StrategyBuilder';
import ActivePositions from './components/ActivePositions';
import OptionChain from './components/OptionChain';
import OrderBookModal from './components/OrderBookModal';
import ServerInfoModal from './components/ServerInfoModal';
import { MarketWebSocket } from './services/websocket';
import { api } from './services/api';
import { AlertTriangle, Table, Layers, Activity, Lock, BookOpen } from 'lucide-react';

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("user");
    return saved ? JSON.parse(saved) : null;
  });

  const [wsConnected, setWsConnected] = useState(false);
  const [kotakStatus, setKotakStatus] = useState(null);
  const [niftyData, setNiftyData] = useState(null);
  const [sensexData, setSensexData] = useState(null);
  const [liveStrategies, setLiveStrategies] = useState([]);
  const [historicalStrategies, setHistoricalStrategies] = useState([]);
  const [serverHealth, setServerHealth] = useState(null);
  const [ltpCache, setLtpCache] = useState({});
  
  // Modals
  const [kotakModalOpen, setKotakModalOpen] = useState(false);
  const [twoFAModalOpen, setTwoFAModalOpen] = useState(false);
  const [optionChainOpen, setOptionChainOpen] = useState(false);
  const [orderBookOpen, setOrderBookOpen] = useState(false);
  const [serverInfoOpen, setServerInfoOpen] = useState(false);

  // Mobile Active Tab: 'DASHBOARD' | 'BUILDER'
  const [mobileTab, setMobileTab] = useState('DASHBOARD');

  // Real-time Stop Loss Alert Banner
  const [activeAlert, setActiveAlert] = useState(null);

  const wsRef = useRef(null);

  // Single-session multi-device termination listener
  useEffect(() => {
    const onSessionTerminated = (e) => {
      alert(e.detail || "Your session has expired or was opened on another device.");
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      setUser(null);
    };
    window.addEventListener("session_terminated", onSessionTerminated);
    return () => window.removeEventListener("session_terminated", onSessionTerminated);
  }, []);

  // Load user status and data
  useEffect(() => {
    if (!user) return;

    fetchKotakStatus();

    // Setup Market WebSocket
    const ws = new MarketWebSocket(
      (data) => {
        if (data.type === 'MARKET_TICK') {
          if (data.nifty) setNiftyData(data.nifty);
          if (data.sensex) setSensexData(data.sensex);
          if (data.strategies) setLiveStrategies(data.strategies);
          if (data.server_health) setServerHealth(data.server_health);
          if (data.ltp_cache) setLtpCache(data.ltp_cache);
        } else if (data.type === 'STOP_LOSS_ALERT') {
          setActiveAlert(data);
          fetchStrategies(); // Refresh history
          setTimeout(() => setActiveAlert(null), 8000);
        }
      },
      (isConnected) => {
        setWsConnected(isConnected);
      }
    );

    ws.connect();
    wsRef.current = ws;

    return () => {
      ws.disconnect();
    };
  }, [user]);

  // Dynamic Tab Title with live Nifty Spot
  useEffect(() => {
    if (niftyData?.spot) {
      document.title = `${niftyData.spot.toFixed(1)} | NEOTRADER PRO`;
    } else {
      document.title = "NEOTRADER PRO | Kotak Neo Options Terminal";
    }
  }, [niftyData?.spot]);

  // When Kotak connects, fetch active strategies
  useEffect(() => {
    if (kotakStatus?.is_connected) {
      fetchStrategies();
    }
  }, [kotakStatus?.is_connected]);

  const fetchKotakStatus = async () => {
    try {
      const res = await api.getKotakStatus();
      setKotakStatus(res);
      // If not connected, immediately show gatekeeper Kotak login modal
      if (!res.is_connected) {
        setKotakModalOpen(true);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchStrategies = async () => {
    try {
      const all = await api.getStrategies();
      setHistoricalStrategies(all.filter(s => s.status !== 'ACTIVE'));
      const active = all.filter(s => s.status === 'ACTIVE');
      setLiveStrategies(active);
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
  };

  // If not authenticated into main app, show Google Authenticator Login modal
  if (!user) {
    return <LoginModal onLoginSuccess={(u) => setUser(u)} />;
  }

  const isKotakLocked = !kotakStatus?.is_connected;

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-800 flex flex-col font-sans relative selection:bg-blue-100">
      
      {/* Top Navigation */}
      <Navbar
        user={user}
        wsConnected={wsConnected}
        kotakStatus={kotakStatus}
        niftyData={niftyData}
        serverHealth={serverHealth}
        onOpenKotakModal={() => setKotakModalOpen(true)}
        onOpen2FAModal={() => setTwoFAModalOpen(true)}
        onOpenOrderBook={() => setOrderBookOpen(true)}
        onOpenServerInfo={() => setServerInfoOpen(true)}
        onLogout={handleLogout}
      />

      {/* Stop Loss Breach Emergency Alert Banner */}
      {activeAlert && (
        <div className="bg-rose-500 text-white px-4 py-2.5 border-b border-rose-600 shadow-sm flex items-center justify-between">
          <div className="max-w-7xl mx-auto flex items-center gap-3 w-full">
            <AlertTriangle className="w-5 h-5 shrink-0 text-white" />
            <div className="flex-1">
              <span className="font-bold text-xs uppercase tracking-wide">Stop Loss Executed</span>
              <p className="text-xs text-rose-100 font-medium">{activeAlert.message}</p>
            </div>
            <button 
              onClick={() => setActiveAlert(null)}
              className="text-xs font-semibold bg-white text-rose-700 border border-white/40 px-3 py-1 rounded-md shadow-sm hover:bg-rose-50"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Container */}
      <main className="max-w-7xl mx-auto w-full px-4 py-4 sm:py-6 pb-8 flex-1 space-y-5 relative">
        
        {/* Top Nifty 50 Overview */}
        <NiftyBanner 
          niftyData={niftyData} 
          isConnected={kotakStatus?.is_connected} 
        />

        {/* Mobile Navigation Tabs (visible only on mobile) */}
        <div className="flex lg:hidden bg-white border-2 border-black p-1.5 rounded-2xl shadow-[3px_3px_0px_0px_#000] text-xs font-bold gap-1">
          <button
            onClick={() => setMobileTab('DASHBOARD')}
            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all ${
              mobileTab === 'DASHBOARD' ? 'bg-black text-white shadow-sm' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Dashboard</span>
          </button>
          <button
            onClick={() => setMobileTab('BUILDER')}
            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all ${
              mobileTab === 'BUILDER' ? 'bg-black text-white shadow-sm' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Builder</span>
          </button>
          <button
            onClick={() => setOptionChainOpen(true)}
            className="flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 text-neutral-700 hover:bg-neutral-100"
          >
            <Table className="w-3.5 h-3.5" />
            <span>Chain</span>
          </button>
          <button
            onClick={() => setOrderBookOpen(true)}
            className="flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 text-neutral-700 hover:bg-neutral-100"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>Book</span>
          </button>
        </div>

        {/* Desktop 2-Column Layout / Mobile Switcher */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 relative">
          
          {/* Left Column: Strategy Builder */}
          <div className={`lg:col-span-5 space-y-5 ${mobileTab === 'POSITIONS' ? 'hidden lg:block' : ''}`}>
            <StrategyBuilder
              niftySpot={niftyData?.spot}
              sensexSpot={sensexData?.spot}
              ltpCache={ltpCache}
              wsClient={wsRef.current}
              kotakStatus={kotakStatus}
              onOpenKotakModal={() => setShowKotakModal(true)}
              onStrategyCreated={() => {
                fetchStrategies();
                setMobileTab('DASHBOARD');
              }}
            />
          </div>

          {/* Right Column: Active Positions & SL Monitor */}
          <div className={`lg:col-span-7 space-y-5 ${mobileTab === 'BUILDER' ? 'hidden lg:block' : ''}`}>
            <ActivePositions
              liveStrategies={liveStrategies}
              historicalStrategies={historicalStrategies}
              ltpCache={ltpCache}
              onRefresh={fetchStrategies}
            />
          </div>

        </div>

        {/* GATEKEEPER OVERLAY (If Kotak Neo is not logged in, block all trading interactions) */}
        {isKotakLocked && (
          <div className="absolute inset-0 bg-neutral-900/60 backdrop-blur-sm z-30 flex items-center justify-center p-4 rounded-2xl">
            <div className="text-center p-6 sm:p-8 bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] max-w-md">
              <div className="inline-flex p-3 rounded-2xl bg-[#ffc900] text-black border-2 border-black shadow-[2px_2px_0px_0px_#000] mb-3">
                <Lock className="w-7 h-7" />
              </div>
              <h3 className="text-lg font-extrabold text-black">Trading Terminal Locked</h3>
              <p className="text-xs text-neutral-600 font-medium mt-1 mb-5">
                Please complete the Kotak Neo API login to activate market data streams, order placement, and index stop loss tracking.
              </p>
              <button
                onClick={() => setKotakModalOpen(true)}
                className="w-full py-3 px-5 rounded-xl font-extrabold text-xs uppercase tracking-wider bg-[#ff90e8] hover:bg-[#ff7be5] text-black border-2 border-black shadow-[3px_3px_0px_0px_#000] hover:translate-x-[1px] hover:translate-y-[1px] transition-all cursor-pointer"
              >
                Open Kotak Neo Login Window
              </button>
            </div>
          </div>
        )}

      </main>

      {/* Floating Option Chain Button (Desktop bottom-right) */}
      <div className="fixed bottom-6 right-6 hidden sm:block z-20">
        <button
          onClick={() => setOptionChainOpen(true)}
          disabled={isKotakLocked}
          className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 border border-slate-200 shadow-sm text-xs font-semibold transition-all cursor-pointer"
        >
          <Table className="w-4 h-4 text-blue-600" />
          <span>Nifty Option Chain</span>
        </button>
      </div>

      {/* Modals */}
      <KotakModal
        isOpen={kotakModalOpen}
        onClose={() => setKotakModalOpen(false)}
        currentStatus={kotakStatus}
        onStatusUpdated={fetchKotakStatus}
        isGatekeeper={isKotakLocked}
      />

      <Setup2FAModal
        isOpen={twoFAModalOpen}
        onClose={() => setTwoFAModalOpen(false)}
      />

      <OptionChain
        isOpen={optionChainOpen}
        onClose={() => setOptionChainOpen(false)}
        niftySpot={niftyData?.spot}
      />

      <OrderBookModal
        isOpen={orderBookOpen}
        onClose={() => setOrderBookOpen(false)}
      />

      <ServerInfoModal
        isOpen={serverInfoOpen}
        onClose={() => setServerInfoOpen(false)}
        liveHealthData={serverHealth}
        wsConnected={wsConnected}
      />

      {/* Footer */}
      <footer className="border-t border-slate-200 py-3.5 text-center text-slate-400 text-xs font-medium bg-white mt-8">
        Kotak Neo Option Spread & Index SL Terminal • Single Active Session Enforced
      </footer>

    </div>
  );
}
