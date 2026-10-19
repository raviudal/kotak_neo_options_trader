import React, { useState, useEffect, useRef } from 'react';
import { X, CheckCircle, AlertCircle, Key, Smartphone, Lock, Shield, Sparkles, HelpCircle, ArrowRight, ExternalLink } from 'lucide-react';
import { api } from '../services/api';

export default function KotakModal({ isOpen, onClose, currentStatus, onStatusUpdated, isGatekeeper = false }) {
  const [consumerKey, setConsumerKey] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [ucc, setUcc] = useState('');
  const [clientName, setClientName] = useState('');
  const [mpin, setMpin] = useState('');
  const [totp, setTotp] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [hasSavedConfig, setHasSavedConfig] = useState(false);
  const [showDetailsEdit, setShowDetailsEdit] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const totpInputRef = useRef(null);

  // Auto-fill saved credentials on mount
  useEffect(() => {
    if (isOpen) {
      api.getSavedKotakConfig()
        .then((config) => {
          if (config) {
            if (config.consumer_key) setConsumerKey(config.consumer_key);
            if (config.mobile_number) setMobileNumber(config.mobile_number);
            if (config.ucc) setUcc(config.ucc);
            if (config.client_name) setClientName(config.client_name);
            if (config.mpin) setMpin(config.mpin);
            
            const isConfigured = Boolean(config.consumer_key && config.ucc && config.mobile_number);
            setHasSavedConfig(isConfigured);
            if (!isConfigured) {
              setShowDetailsEdit(true);
            }
          } else {
            setShowDetailsEdit(true);
          }
        })
        .catch((e) => {
          console.error(e);
          setShowDetailsEdit(true);
        });

      // Auto-focus TOTP
      setTimeout(() => {
        if (totpInputRef.current) {
          totpInputRef.current.focus();
        }
      }, 250);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConnect = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const payload = {
        consumer_key: consumerKey.trim(),
        mobile_number: mobileNumber.trim(),
        ucc: ucc.trim().toUpperCase(),
        mpin: mpin.trim(),
        totp: totp.trim() || null,
        totp_secret: totpSecret.trim() || null
      };

      const res = await api.loginKotak(payload);
      if (res.status === 'success') {
        setSuccess(res.message);
        if (onStatusUpdated) onStatusUpdated();
        setTimeout(() => {
          if (onClose) onClose();
        }, 1000);
      } else {
        setError(res.message || 'Authentication failed');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setLoading(true);
    try {
      await api.disconnectKotak();
      if (onStatusUpdated) onStatusUpdated();
      if (onClose && !isGatekeeper) onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const isAlreadyActive = currentStatus?.is_connected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-lg bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] p-6 relative my-8 text-black">
        
        {/* Close Button (Hidden if in Gatekeeper mode and not active) */}
        {!isGatekeeper && onClose && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-xl border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[2px_2px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Gatekeeper Notice */}
        {isGatekeeper && !isAlreadyActive && (
          <div className="mb-4 p-3 rounded-xl bg-[#90e8ff]/30 border-2 border-black text-black text-xs flex items-center gap-2 shadow-[2px_2px_0px_0px_#000]">
            <Shield className="w-4 h-4 shrink-0 text-black" />
            <span>
              <strong>Kotak Neo Authentication Required</strong>: Enter your Kotak API credentials and 6-digit TOTP to start trading. (Session held securely in RAM only).
            </span>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2.5 rounded-xl bg-[#ff90e8] border-2 border-black text-black shadow-[3px_3px_0px_0px_#000]">
            <Key className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-xl font-black text-black">
              {hasSavedConfig ? 'Kotak Neo API Session' : 'Setup Kotak Neo Connection'}
            </h3>
            <p className="text-xs font-semibold text-black/70 mt-0.5">
              {hasSavedConfig && ucc ? (
                <>Account: <span className="bg-[#f4f4f0] px-1.5 py-0.5 rounded border border-black font-black text-black">{clientName || ucc}</span> ({ucc})</>
              ) : (
                'Configure your TradeAPI v2 credentials to enable live execution'
              )}
            </p>
          </div>
        </div>

        {/* Active Session Restored Card */}
        {isAlreadyActive && (
          <div className="mb-5 p-4 rounded-xl bg-[#a3e635]/25 border-2 border-black text-xs text-black space-y-3 shadow-[3px_3px_0px_0px_#000]">
            <div className="flex items-center gap-2.5">
              <CheckCircle className="w-5 h-5 text-black shrink-0" />
              <div>
                <p className="font-black text-sm text-black">Active Kotak Neo Session Connected!</p>
                <p className="text-[11px] font-medium text-black/80 mt-0.5">
                  Client: <strong>{clientName || ucc}</strong> ({ucc}) • Mobile: {mobileNumber}
                </p>
                <p className="text-[10px] text-black/60 mt-0.5">
                  Live quotes and real-time order placement are active.
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="gum-btn-pink flex-1 py-2 px-3 rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>Enter Trading Terminal</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={loading}
                className="gum-btn-white py-2 px-3 rounded-xl text-xs text-red-600 hover:text-red-700 cursor-pointer"
              >
                Disconnect
              </button>
            </div>
          </div>
        )}

        {/* Alerts */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-[#ff4d4d]/15 border-2 border-black text-black font-bold text-xs flex items-center gap-2 shadow-[2px_2px_0px_0px_#000]">
            <AlertCircle className="w-4 h-4 shrink-0 text-[#ff4d4d]" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="mb-4 p-3 rounded-xl bg-[#a3e635]/25 border-2 border-black text-black font-bold text-xs flex items-center gap-2 shadow-[2px_2px_0px_0px_#000]">
            <CheckCircle className="w-4 h-4 shrink-0 text-black" />
            <span>{success}</span>
          </div>
        )}

        {!isAlreadyActive && (
          <form onSubmit={handleConnect} className="space-y-4">
            
            {/* If user already has saved credentials, show collapsible summary */}
            {hasSavedConfig && !showDetailsEdit && (
              <div className="p-3 rounded-xl bg-[#f4f4f0] border-2 border-black flex items-center justify-between text-xs shadow-[2px_2px_0px_0px_#000]">
                <div>
                  <p className="text-black/70 font-bold">Saved Broker Account:</p>
                  <p className="text-black font-mono text-[11px] mt-0.5 font-semibold">
                    <span className="font-bold underline">{ucc}</span> • {mobileNumber} {clientName && `• ${clientName}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDetailsEdit(true)}
                  className="text-[11px] font-bold text-black underline hover:text-[#ff90e8] cursor-pointer"
                >
                  Edit API Keys
                </button>
              </div>
            )}

            {/* Credential Details Inputs (Visible if new or editing) */}
            {showDetailsEdit && (
              <div className="space-y-3 p-3.5 rounded-xl bg-[#f4f4f0] border-2 border-black text-xs shadow-[2px_2px_0px_0px_#000]">
                <div className="flex items-center justify-between">
                  <span className="font-black text-black text-xs uppercase tracking-wider">Kotak API Credentials</span>
                  <a
                    href="https://tradeapi.kotaksecurities.com/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] font-bold text-blue-600 hover:underline flex items-center gap-1"
                  >
                    <span>Kotak Developer Portal</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>

                <div>
                  <label className="block text-black font-bold mb-1">
                    Consumer Key <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={consumerKey}
                    onChange={(e) => setConsumerKey(e.target.value)}
                    placeholder="e.g. 0ac8cf9b-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    className="gum-input w-full px-2.5 py-2 text-xs font-mono"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-black font-bold mb-1">
                      Mobile Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={mobileNumber}
                      onChange={(e) => setMobileNumber(e.target.value)}
                      placeholder="+91XXXXXXXXXX"
                      className="gum-input w-full px-2.5 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-black font-bold mb-1">
                      Client UCC <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={ucc}
                      onChange={(e) => setUcc(e.target.value)}
                      placeholder="e.g. YEPXG"
                      className="gum-input w-full px-2.5 py-2 text-xs uppercase font-mono"
                    />
                  </div>
                </div>

                {hasSavedConfig && (
                  <button
                    type="button"
                    onClick={() => setShowDetailsEdit(false)}
                    className="text-[11px] font-bold text-neutral-600 underline hover:text-black cursor-pointer"
                  >
                    Hide API Keys
                  </button>
                )}
              </div>
            )}

            {/* Primary Input 1: Kotak Neo 6-Digit TOTP Code */}
            <div className="p-3.5 rounded-xl bg-[#ffc900]/15 border-2 border-black shadow-[3px_3px_0px_0px_#000]">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-black uppercase tracking-wider text-black">
                  Kotak Neo TOTP (Authenticator Code) <span className="text-red-500">*</span>
                </label>
                <span className="text-[10px] font-bold font-mono bg-black text-white px-1.5 py-0.5 rounded">6 Digits</span>
              </div>
              <input
                ref={totpInputRef}
                type="text"
                required
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter current 6-digit TOTP"
                className="gum-input w-full px-3 py-2.5 text-lg font-mono font-black tracking-widest text-black placeholder-black/30"
              />
              <p className="text-[11px] font-medium text-black/70 mt-1">
                Open your authenticator app for Kotak Neo and enter the 6-digit code.
              </p>
            </div>

            {/* Primary Input 2: Kotak MPIN */}
            <div>
              <label className="block text-xs font-black uppercase tracking-wider text-black mb-1">
                Kotak 6-Digit MPIN <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50" />
                <input
                  type="password"
                  required
                  maxLength={6}
                  value={mpin}
                  onChange={(e) => setMpin(e.target.value.replace(/\D/g, ''))}
                  placeholder="Enter your 6-digit MPIN"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-sm font-mono tracking-wider font-bold placeholder-black/30"
                />
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading || !consumerKey || !mobileNumber || !ucc || mpin.length !== 6 || totp.length !== 6}
              className="gum-btn-pink w-full py-3 px-4 rounded-xl font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Authenticating with Kotak Neo...' : 'Connect to Kotak Neo API'}
              <ArrowRight className="w-4 h-4" />
            </button>

          </form>
        )}

      </div>
    </div>
  );
}
