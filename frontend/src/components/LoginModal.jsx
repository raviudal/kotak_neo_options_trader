import React, { useState } from 'react';
import { Lock, User, KeyRound, ShieldCheck, ArrowRight, AlertCircle, CheckCircle, Copy, Check, Sparkles } from 'lucide-react';
import { api } from '../services/api';

export default function LoginModal({ onLoginSuccess }) {
  const [tab, setTab] = useState('LOGIN'); // 'LOGIN' | 'REGISTER'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  
  // Registration setup state
  const [registrationData, setRegistrationData] = useState(null);
  const [verifyTotpCode, setVerifyTotpCode] = useState('');
  const [copiedSecret, setCopiedSecret] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFillDemo = () => {
    setUsername('trader');
    setPassword('TradeSafe@2026');
    setError('');
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.login(username.trim(), password, totpCode.trim());
      localStorage.setItem("token", res.access_token);
      localStorage.setItem("user", JSON.stringify(res.user));
      onLoginSuccess(res.user);
    } catch (err) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${window.location.origin}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Registration failed");

      setRegistrationData(data);
    } catch (err) {
      setError(err.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteRegistrationLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await api.login(registrationData.username || username.trim(), password, verifyTotpCode.trim());
      localStorage.setItem("token", res.access_token);
      localStorage.setItem("user", JSON.stringify(res.user));
      onLoginSuccess(res.user);
    } catch (err) {
      setError(err.message || "2FA Verification failed. Make sure your phone's time is accurate.");
    } finally {
      setLoading(false);
    }
  };

  const copySecret = () => {
    if (registrationData?.totp_secret) {
      navigator.clipboard.writeText(registrationData.totp_secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-md bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] p-6 sm:p-8 my-8 text-black">
        
        {/* Header */}
        <div className="text-center mb-6">
          <div className="inline-flex p-3 rounded-xl bg-[#ff90e8] border-2 border-black text-black shadow-[2px_2px_0px_0px_#000] mb-3">
            <ShieldCheck className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-black tracking-tight text-black">
            Kotak Neo Algo Terminal
          </h2>
          <p className="text-xs font-semibold text-black/70 mt-1">
            Nifty Options Engine with Underlying Index Stop Loss
          </p>
        </div>

        {/* Tab Switcher (Only if not in 2FA onboarding mode) */}
        {!registrationData && (
          <div className="flex bg-[#f4f4f0] border-2 border-black p-1 rounded-xl mb-5 shadow-[2px_2px_0px_0px_#000]">
            <button
              type="button"
              onClick={() => { setTab('LOGIN'); setError(''); }}
              className={`flex-1 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                tab === 'LOGIN' ? 'bg-black text-white shadow-sm' : 'text-black/70 hover:text-black'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => { setTab('REGISTER'); setError(''); }}
              className={`flex-1 py-2 text-xs font-black uppercase tracking-wider rounded-lg transition-all cursor-pointer ${
                tab === 'REGISTER' ? 'bg-[#ff90e8] text-black shadow-sm' : 'text-black/70 hover:text-black'
              }`}
            >
              Register New User
            </button>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-[#ff4d4d]/15 border-2 border-black text-black font-bold text-xs flex items-center gap-2 shadow-[2px_2px_0px_0px_#000]">
            <AlertCircle className="w-4 h-4 shrink-0 text-[#ff4d4d]" />
            <span>{error}</span>
          </div>
        )}

        {/* --- SCENARIO 1: Registration Success -> 2FA Activation Screen --- */}
        {registrationData ? (
          <div className="space-y-4">
            <div className="p-3.5 rounded-xl bg-[#a3e635]/25 border-2 border-black text-xs shadow-[2px_2px_0px_0px_#000]">
              <div className="flex items-center gap-2 text-black font-black text-sm mb-1">
                <CheckCircle className="w-4 h-4 text-black shrink-0" />
                <span>Account Created: {registrationData.username}</span>
              </div>
              <p className="text-[11px] font-medium text-black/80">
                To activate your account, link it to Google Authenticator or any TOTP app.
              </p>
            </div>

            {/* QR Code Section */}
            <div className="text-center p-3 rounded-xl bg-[#f4f4f0] border-2 border-black shadow-[2px_2px_0px_0px_#000]">
              <p className="text-[11px] font-black uppercase tracking-wider text-black mb-2">
                1. Scan QR Code with Authenticator App:
              </p>
              <div className="inline-block p-2 bg-white rounded-xl border-2 border-black shadow-sm">
                <img src={registrationData.qr_code} alt="2FA QR Code" className="w-36 h-36 mx-auto" />
              </div>
              
              <div className="mt-2.5">
                <p className="text-[10px] font-bold text-black/60 mb-1">Or enter setup key manually:</p>
                <div className="flex items-center justify-center gap-2">
                  <span className="font-mono text-xs font-black bg-white px-2 py-1 rounded border border-black break-all select-all">
                    {registrationData.totp_secret}
                  </span>
                  <button
                    type="button"
                    onClick={copySecret}
                    className="p-1 rounded border border-black bg-white hover:bg-neutral-100 transition-colors"
                    title="Copy Secret"
                  >
                    {copiedSecret ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5 text-black" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Step 2: Immediate verification to enter terminal */}
            <form onSubmit={handleCompleteRegistrationLogin} className="space-y-3">
              <div>
                <label className="block text-xs font-black uppercase tracking-wider text-black mb-1">
                  2. Enter 6-Digit Code from Authenticator:
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black" />
                  <input
                    type="text"
                    required
                    maxLength={6}
                    autoFocus
                    value={verifyTotpCode}
                    onChange={(e) => setVerifyTotpCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 123456"
                    className="gum-input w-full pl-9 pr-3 py-2.5 text-base font-mono font-black tracking-widest text-black placeholder-black/30"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || verifyTotpCode.length !== 6}
                className="gum-btn-pink w-full py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {loading ? 'Verifying 2FA...' : 'Verify & Enter Terminal'}
                <ArrowRight className="w-4 h-4" />
              </button>
            </form>

            <button
              type="button"
              onClick={() => { setRegistrationData(null); setTab('LOGIN'); }}
              className="w-full text-center text-xs font-bold text-black/70 underline hover:text-black mt-2 cursor-pointer"
            >
              Back to Sign In
            </button>
          </div>
        ) : tab === 'REGISTER' ? (
          /* --- SCENARIO 2: Register New User Form --- */
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-xs font-black uppercase tracking-wider text-black mb-1.5">
                Choose Username
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. trader_rahul"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-sm font-semibold placeholder-black/30"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-black uppercase tracking-wider text-black mb-1.5">
                Create Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50" />
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-sm font-semibold placeholder-black/30"
                />
              </div>
            </div>

            <p className="text-[11px] text-black/70 font-medium">
              After registering, you will immediately receive a Google Authenticator QR code to secure your account.
            </p>

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="gum-btn-pink w-full py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Creating Profile...' : 'Register & Setup Google 2FA'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        ) : (
          /* --- SCENARIO 3: Standard Login Form --- */
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-black uppercase tracking-wider text-black mb-1.5">Username</label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50" />
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-sm font-semibold placeholder-black/30"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-black uppercase tracking-wider text-black mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black/50" />
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-sm font-semibold placeholder-black/30"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-black uppercase tracking-wider text-black">
                  Google Authenticator (TOTP)
                </label>
                <span className="text-[10px] font-bold font-mono bg-black text-white px-1.5 py-0.5 rounded">6 digits</span>
              </div>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-black" />
                <input
                  type="text"
                  required
                  maxLength={6}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 123456"
                  className="gum-input w-full pl-9 pr-3 py-2.5 text-base font-mono font-black tracking-widest text-black placeholder-black/30"
                />
              </div>
              <p className="text-[11px] font-medium text-black/60 mt-1">
                Open Google Authenticator on your phone and enter the current code.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || !username || !password || totpCode.length !== 6}
              className="gum-btn-pink w-full py-3 px-4 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Authenticating...' : 'Verify & Enter Terminal'}
              <ArrowRight className="w-4 h-4" />
            </button>

            {/* Quick Demo Fill Helper */}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={handleFillDemo}
                className="text-[11px] font-bold text-neutral-500 hover:text-black inline-flex items-center gap-1 cursor-pointer"
              >
                <Sparkles className="w-3 h-3 text-[#ff90e8]" />
                <span>Fill Default Admin (trader)</span>
              </button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
}
