import React, { useState, useEffect } from 'react';
import { X, Copy, Check, ShieldAlert, Smartphone } from 'lucide-react';
import { api } from '../services/api';

export default function Setup2FAModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      api.get2FASetup()
        .then(res => setData(res))
        .catch(err => console.error(err))
        .finally(() => setLoading(false));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    if (data?.secret) {
      navigator.clipboard.writeText(data.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] p-6 relative text-black">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-xl border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[2px_2px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="text-center mb-5">
          <div className="inline-flex p-3 rounded-xl bg-[#ff90e8] border-2 border-black text-black shadow-[2px_2px_0px_0px_#000] mb-2">
            <Smartphone className="w-6 h-6" />
          </div>
          <h3 className="text-xl font-black text-black">Google Authenticator Setup</h3>
          <p className="text-xs font-medium text-black/70 mt-0.5">
            Link this trading terminal to your phone's Authenticator app
          </p>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm font-semibold text-black/60">Loading 2FA Key...</div>
        ) : (
          <div className="space-y-4">
            
            {/* QR Code Container */}
            <div className="flex flex-col items-center justify-center p-3 bg-white border-2 border-black rounded-2xl mx-auto w-fit shadow-[4px_4px_0px_0px_#000]">
              {data?.qr_code && (
                <img src={data.qr_code} alt="2FA QR Code" className="w-48 h-48 rounded" />
              )}
            </div>

            {/* Secret Key with Copy */}
            <div>
              <label className="block text-[11px] font-black uppercase tracking-wider text-black mb-1">
                Manual Setup Key (if you can't scan QR)
              </label>
              <div className="flex items-center gap-2 p-2.5 rounded-xl bg-[#f4f4f0] border-2 border-black shadow-[2px_2px_0px_0px_#000]">
                <span className="font-mono text-xs font-black text-black select-all break-all flex-1">
                  {data?.secret}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1.5 rounded-lg border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[1px_1px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
                  title="Copy secret"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-[#90e8ff]/20 border-2 border-black text-[11px] font-medium text-black space-y-1 shadow-[2px_2px_0px_0px_#000]">
              <p className="font-black uppercase tracking-wider">How to activate:</p>
              <p>1. Open Google Authenticator on your mobile.</p>
              <p>2. Tap the '+' button and select <strong>Scan a QR code</strong>.</p>
              <p>3. Point your camera at this QR code.</p>
            </div>

            <button
              onClick={onClose}
              className="gum-btn-black w-full py-2.5 rounded-xl text-xs cursor-pointer"
            >
              Done & Return to App
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
