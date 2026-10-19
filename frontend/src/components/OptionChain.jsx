import React, { useState, useEffect } from 'react';
import { Table, RefreshCw, X, Calendar } from 'lucide-react';
import { api } from '../services/api';

export default function OptionChain({ isOpen, onClose, niftySpot }) {
  const [chain, setChain] = useState([]);
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [atmStrike, setAtmStrike] = useState(25100);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      api.getExpiries()
        .then((data) => {
          if (Array.isArray(data) && data.length > 0) {
            setExpiries(data);
            if (!selectedExpiry) {
              setSelectedExpiry(data[0].code);
            }
          }
        })
        .catch(console.error);
    }
  }, [isOpen]);

  const fetchChain = async (exp = selectedExpiry) => {
    setLoading(true);
    try {
      const res = await api.getOptionChain(exp);
      setChain(res.chain || []);
      if (res.atm_strike) {
        setAtmStrike(res.atm_strike);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && selectedExpiry) {
      fetchChain(selectedExpiry);
    }
  }, [isOpen, selectedExpiry]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-5xl bg-white border-2 border-black rounded-2xl shadow-[6px_6px_0px_0px_#000] p-6 relative max-h-[85vh] flex flex-col text-black">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-xl border-2 border-black bg-white hover:bg-[#ff90e8] text-black shadow-[2px_2px_0px_0px_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b-2 border-black mb-4 gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-[#ff90e8] border-2 border-black text-black shadow-[2px_2px_0px_0px_#000]">
              <Table className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-black">Nifty 50 Live Option Chain</h3>
              <p className="text-xs font-semibold text-black/70">
                Spot: <span className="font-mono text-black font-black bg-[#ff90e8]/25 px-1 rounded border border-black">{niftySpot?.toFixed(2) || '25,146.15'}</span> • ATM: <span className="font-mono font-black text-black">{atmStrike}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 mr-8">
            <div className="flex items-center gap-1.5 bg-[#f4f4f0] border-2 border-black rounded-xl px-2.5 py-1 shadow-[2px_2px_0px_0px_#000]">
              <Calendar className="w-3.5 h-3.5 text-black" />
              <select
                value={selectedExpiry}
                onChange={(e) => setSelectedExpiry(e.target.value)}
                className="bg-transparent text-xs text-black font-black focus:outline-none cursor-pointer"
              >
                {expiries.map(exp => (
                  <option key={exp.code} value={exp.code} className="bg-white text-black font-bold">
                    {exp.display}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => fetchChain()}
              disabled={loading}
              className="gum-btn-white flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 rounded-xl border-2 border-black shadow-[3px_3px_0px_0px_#000]">
          <table className="w-full text-xs text-center font-mono">
            <thead className="sticky top-0 bg-white border-b-2 border-black text-[11px]">
              <tr>
                <th colSpan="3" className="py-2 bg-[#a3e635]/30 text-black border-r-2 border-b-2 border-black font-black">
                  CALLS (CE)
                </th>
                <th className="py-2 bg-black text-white font-black px-3 border-b-2 border-black">
                  STRIKE
                </th>
                <th colSpan="3" className="py-2 bg-[#ff90e8]/30 text-black border-l-2 border-b-2 border-black font-black">
                  PUTS (PE)
                </th>
              </tr>
              <tr className="bg-[#f4f4f0] text-black text-[10px] font-black border-b-2 border-black">
                <th className="py-1.5 px-2">Symbol</th>
                <th className="py-1.5 px-2">Token</th>
                <th className="py-1.5 px-2 text-emerald-800 border-r-2 border-black font-black">Lot</th>
                <th className="py-1.5 px-3 text-black font-black bg-black/10">NIFTY</th>
                <th className="py-1.5 px-2 text-red-700 border-l-2 border-black font-black">Lot</th>
                <th className="py-1.5 px-2">Token</th>
                <th className="py-1.5 px-2">Symbol</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10 bg-white">
              {chain.map((item) => {
                const isATM = item.is_atm;
                const ce = item.ce;
                const pe = item.pe;

                return (
                  <tr
                    key={item.strike}
                    className={`transition-colors ${
                      isATM 
                        ? 'bg-[#ffc900]/30 font-black' 
                        : 'hover:bg-[#ff90e8]/10'
                    }`}
                  >
                    <td className="py-2 px-2 text-left text-black font-semibold truncate max-w-[140px]">
                      {ce?.trading_symbol || '-'}
                    </td>
                    <td className="py-2 px-2 text-black/70 font-mono text-[11px]">
                      {ce?.token || '-'}
                    </td>
                    <td className="py-2 px-2 text-emerald-700 border-r-2 border-black font-black">
                      {ce?.lot_size || '-'}
                    </td>

                    <td className={`py-2 px-3 text-center font-black text-xs ${
                      isATM ? 'bg-[#ffc900] text-black border-x-2 border-black' : 'text-black bg-black/[0.03]'
                    }`}>
                      {item.strike}
                      {isATM && <span className="ml-1 text-[9px] px-1.5 py-0.5 bg-black text-white rounded font-sans font-black">ATM</span>}
                    </td>

                    <td className="py-2 px-2 text-red-700 border-l-2 border-black font-black">
                      {pe?.lot_size || '-'}
                    </td>
                    <td className="py-2 px-2 text-black/70 font-mono text-[11px]">
                      {pe?.token || '-'}
                    </td>
                    <td className="py-2 px-2 text-right text-black font-semibold truncate max-w-[140px]">
                      {pe?.trading_symbol || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
