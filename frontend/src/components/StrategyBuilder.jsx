import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Layers, Plus, Trash2, ArrowUpRight, ArrowDownRight, ShieldAlert, 
  CheckCircle2, ChevronRight, Calendar, Sparkles, RefreshCw, Sliders,
  TrendingUp, TrendingDown, Target, Info, Edit2, RotateCcw,
  ChevronDown, ChevronUp, GripVertical, Calculator, AlertTriangle, Wallet, X
} from 'lucide-react';
import { api } from '../services/api';
import PayoffGraph from './PayoffGraph';

const STRATEGY_PRESETS = [
  { id: 'BULL_PUT_CREDIT', name: 'Bull Put Spread', type: 'Credit', bias: 'BULLISH', desc: 'Sell OTM Put + Buy deeper OTM Put hedge' },
  { id: 'BEAR_CALL_CREDIT', name: 'Bear Call Spread', type: 'Credit', bias: 'BEARISH', desc: 'Sell OTM Call + Buy higher OTM Call hedge' },
  { id: 'BULL_CALL_SPREAD', name: 'Bull Call Spread', type: 'Debit', bias: 'BULLISH', desc: 'Buy ATM Call + Sell higher OTM Call' },
  { id: 'BEAR_PUT_SPREAD', name: 'Bear Put Spread', type: 'Debit', bias: 'BEARISH', desc: 'Buy ATM Put + Sell lower OTM Put' },
  { id: 'CALENDAR_SPREAD', name: 'Calendar Spread', type: 'Time Spread', bias: 'NEUTRAL', desc: 'Sell Near Expiry + Buy Far Expiry' },
  { id: 'IRON_CONDOR', name: 'Iron Condor', type: 'Credit', bias: 'NEUTRAL', desc: '4 Legs: OTM Put Spread + OTM Call Spread' },
  { id: 'LONG_STRADDLE', name: 'Long Straddle', type: 'Debit', bias: 'VOLATILITY', desc: 'Buy ATM Call + Buy ATM Put' },
  { id: 'SHORT_STRADDLE', name: 'Short Straddle', type: 'Credit', bias: 'NEUTRAL', desc: 'Sell ATM Call + Sell ATM Put' }
];

export default function StrategyBuilder({ 
  niftySpot, 
  ltpCache = {}, 
  wsClient = null, 
  kotakStatus = null,
  onOpenKotakModal = null,
  onStrategyCreated 
}) {
  const [strategyType, setStrategyType] = useState('BULL_PUT_CREDIT');
  const [strategyName, setStrategyName] = useState('Bull Put Spread');
  const [isNameManuallyEdited, setIsNameManuallyEdited] = useState(false);
  const [lots, setLots] = useState(1);
  const [lotSize, setLotSize] = useState(65);
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  
  // Collapsible Presets Section (Saves vertical space)
  const [presetsOpen, setPresetsOpen] = useState(false);

  // Sensibull-style interactive controls
  const [mainStrike, setMainStrike] = useState(0);
  const [hedgeDistance, setHedgeDistance] = useState(100);
  
  // Strategy legs & Payoff
  const [legs, setLegs] = useState([]);
  const [payoff, setPayoff] = useState({
    max_profit: null,
    max_loss: null,
    breakevens: [],
    breakeven_low: null,
    breakeven_high: null,
    risk_reward: 'N/A',
    margin_required: null,
    net_premium: 0,
    payoff_curve: []
  });

  // Account Margin States
  const [availableMargin, setAvailableMargin] = useState(null);
  const [limitsLoading, setLimitsLoading] = useState(false);
  const [brokerMarginData, setBrokerMarginData] = useState(null);

  // Stop Loss & Execution: Choose between Nifty Index Spot SL and Strategy LTP Candle Close SL
  const [slTargetType, setSlTargetType] = useState('STRATEGY_LTP'); // 'INDEX' | 'STRATEGY_LTP'
  const [strategySLValue, setStrategySLValue] = useState('');
  const [isStratSLManuallyEdited, setIsStratSLManuallyEdited] = useState(false);
  const [slPercentage, setSlPercentage] = useState(5); // default 5%
  const [indexSL, setIndexSL] = useState(0);
  const [slCondition, setSlCondition] = useState('LESS_THAN_OR_EQUAL');
  const [indexTarget, setIndexTarget] = useState('');
  const [orderType, setOrderType] = useState('MKT');
  const [indexSLMode, setIndexSLMode] = useState('CANDLE');
  const [candleInterval, setCandleInterval] = useState(5);
  
  // UI states
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [refreshingMaster, setRefreshingMaster] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [orderResults, setOrderResults] = useState([]);

  // Available strikes
  const atmSpot = niftySpot ? Math.round(niftySpot / 50) * 50 : 25100;

  // Margin Required Calculation (Full broker margin from API or calculation)
  const marginRequired = useMemo(() => {
    if (brokerMarginData?.broker_total_margin && Number(brokerMarginData.broker_total_margin) > 0) {
      return Number(brokerMarginData.broker_total_margin);
    }
    if (payoff.margin_required !== null && payoff.margin_required !== undefined && Number(payoff.margin_required) > 0) {
      return Number(payoff.margin_required);
    }
    const sellLegs = legs.filter(l => String(l.action).toUpperCase() === 'SELL');
    const buyPrem = legs
      .filter(l => String(l.action).toUpperCase() === 'BUY')
      .reduce((sum, l) => sum + (parseFloat(l.price) || 0) * (parseInt(l.quantity) || lots * lotSize), 0);
    const shortMargin = sellLegs.reduce((sum, l) => sum + (125000 * ((parseInt(l.quantity) || lots * lotSize) / lotSize)), 0);
    return shortMargin + buyPrem;
  }, [brokerMarginData?.broker_total_margin, payoff.margin_required, legs, lots, lotSize]);

  // Fetch Kotak Neo Available Limits & Real-Time Broker Margins
  const fetchLimits = async () => {
    try {
      setLimitsLoading(true);
      const data = await api.getKotakLimits();
      if (data && !data.error) {
        const val = data.available_margin ?? data.available_cash ?? null;
        if (val !== null && !isNaN(Number(val))) {
          setAvailableMargin(Number(val));
        }
      }
    } catch (e) {
      console.debug("fetchLimits error:", e);
    } finally {
      setLimitsLoading(false);
    }
  };

  // 1. Load Expiries and Limits on Mount
  useEffect(() => {
    api.getExpiries()
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setExpiries(data);
          setSelectedExpiry(data[0].code);
          if (!isNameManuallyEdited) {
            const expDisplay = data[0].display || data[0].code;
            setStrategyName(`Bull Put Spread - ${expDisplay}`);
          }
        }
      })
      .catch((err) => console.error("Error loading expiries:", err));

    fetchLimits();
  }, []);

  // Re-fetch limits whenever Kotak connects or login state changes
  useEffect(() => {
    if (kotakStatus?.is_connected) {
      fetchLimits();
    } else {
      setAvailableMargin(null);
    }
  }, [kotakStatus?.is_connected]);

  // Real-time broker check-margin endpoint query when legs change and Kotak is connected
  useEffect(() => {
    if (kotakStatus?.is_connected && legs && legs.length > 0) {
      api.checkKotakMargin(legs, payoff?.max_loss, payoff?.max_profit)
        .then(res => {
          if (res && res.is_connected) {
            setBrokerMarginData(res);
            if (res.broker_available_margin && Number(res.broker_available_margin) > 0) {
              setAvailableMargin(Number(res.broker_available_margin));
            }
          }
        })
        .catch(err => console.debug("Broker check margin error:", err));
    }
  }, [legs, payoff?.max_loss, payoff?.max_profit, kotakStatus?.is_connected]);

  const handleRefreshMaster = async () => {
    setRefreshingMaster(true);
    try {
      const res = await api.refreshMaster();
      if (res && Array.isArray(res.expiries) && res.expiries.length > 0) {
        setExpiries(res.expiries);
        setSelectedExpiry(res.expiries[0].code);
        setIsNameManuallyEdited(false);
      }
      fetchLimits();
    } catch (e) {
      console.error("Error refreshing token master:", e);
    } finally {
      setRefreshingMaster(false);
    }
  };

  // 2. Initialize Main Strike to ATM when spot arrives
  useEffect(() => {
    if (niftySpot) {
      if (!mainStrike || Math.abs(mainStrike - atmSpot) > 500) {
        setMainStrike(atmSpot);
      }
    }
  }, [niftySpot, atmSpot]);

  const isCustomizedRef = useRef(false);
  const initializedRef = useRef(false);
  const lastAtmRef = useRef(null);

  // 3. Strategy Preview & Payoff Calculation for Presets
  const refreshPreview = async (
    type = strategyType, 
    exp = selectedExpiry, 
    lts = lots, 
    strike = mainStrike, 
    hedge = hedgeDistance
  ) => {
    if (!niftySpot) return;
    setPreviewLoading(true);
    try {
      const res = await api.previewStrategy({
        strategy_type: type,
        expiry_code: exp || undefined,
        main_strike: strike || atmSpot,
        hedge_distance: hedge,
        spread_width: hedge,
        lots: lts,
        spot_price: niftySpot
      });

      if (res && Array.isArray(res.legs)) {
        setLegs(res.legs);
        if (res.legs.length > 0 && res.legs[0].lot_size) {
          setLotSize(res.legs[0].lot_size);
        }

        // Payoff metrics
        setPayoff({
          max_profit: res.max_profit,
          max_loss: res.max_loss,
          breakevens: res.breakevens || [],
          breakeven_low: res.breakeven_low,
          breakeven_high: res.breakeven_high,
          risk_reward: res.risk_reward || 'N/A',
          margin_required: res.margin_required ?? null,
          net_premium: res.net_premium || 0,
          payoff_curve: res.payoff_curve || []
        });

        // Dynamic Sensibull-style auto strategy name based on used legs
        if (!isNameManuallyEdited && res.strategy_name) {
          setStrategyName(res.strategy_name);
        }

        // Sensible default Stop Loss based on current Nifty Spot (never breach upon entry)
        const currentSpot = niftySpot || atmSpot;
        if (type === 'BULL_PUT_CREDIT' || type === 'BULL_CALL_SPREAD') {
          // Bullish strategy: SL triggers if Nifty falls below current market
          setIndexSL(Math.round((currentSpot - 75) / 5) * 5);
          setSlCondition('LESS_THAN_OR_EQUAL');
        } else if (type === 'BEAR_CALL_CREDIT' || type === 'BEAR_PUT_SPREAD') {
          // Bearish strategy: SL triggers if Nifty rises above current market
          setIndexSL(Math.round((currentSpot + 75) / 5) * 5);
          setSlCondition('GREATER_THAN_OR_EQUAL');
        } else if (type === 'IRON_CONDOR') {
          setIndexSL(Math.round((currentSpot - 120) / 5) * 5);
          setSlCondition('LESS_THAN_OR_EQUAL');
        } else {
          setIndexSL(Math.round((currentSpot - 75) / 5) * 5);
          setSlCondition('LESS_THAN_OR_EQUAL');
        }
      }
    } catch (err) {
      console.error("Preview error:", err);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Real-time recalculation when user customizes legs (strike, action, expiry, option type, delete)
  const updateCustomLegsPreview = async (updatedLegs, lts = lots) => {
    if (!niftySpot || !updatedLegs || updatedLegs.length === 0) return;
    setPreviewLoading(true);
    try {
      const res = await api.previewStrategy({
        strategy_type: strategyType,
        expiry_code: selectedExpiry || undefined,
        main_strike: mainStrike || atmSpot,
        hedge_distance: hedgeDistance,
        spread_width: hedgeDistance,
        lots: lts,
        spot_price: niftySpot,
        custom_legs: updatedLegs
      });

      if (res && Array.isArray(res.legs)) {
        setLegs(res.legs);
        if (res.legs.length > 0 && res.legs[0].lot_size) {
          setLotSize(res.legs[0].lot_size);
        }

        setPayoff({
          max_profit: res.max_profit,
          max_loss: res.max_loss,
          breakevens: res.breakevens || [],
          breakeven_low: res.breakeven_low,
          breakeven_high: res.breakeven_high,
          risk_reward: res.risk_reward || 'N/A',
          margin_required: res.margin_required ?? null,
          net_premium: res.net_premium || 0,
          payoff_curve: res.payoff_curve || []
        });

        if (!isNameManuallyEdited && res.strategy_name) {
          setStrategyName(res.strategy_name);
        }
      }
    } catch (err) {
      console.error("Custom legs preview error:", err);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Initial load when spot and expiry are ready
  useEffect(() => {
    if (niftySpot && selectedExpiry && !initializedRef.current) {
      initializedRef.current = true;
      lastAtmRef.current = atmSpot;
      refreshPreview(strategyType, selectedExpiry, lots, mainStrike || atmSpot, hedgeDistance);
    }
  }, [niftySpot, selectedExpiry]);

  // When strategyType or selectedExpiry changes after initial load
  useEffect(() => {
    if (initializedRef.current && selectedExpiry && niftySpot) {
      if (isCustomizedRef.current && legs && legs.length > 0) {
        updateCustomLegsPreview(legs);
      } else {
        refreshPreview(strategyType, selectedExpiry, lots, mainStrike, hedgeDistance);
      }
    }
  }, [strategyType, selectedExpiry]);

  // Tell backend WebSocket to monitor these preview legs via Kotak Neo
  useEffect(() => {
    if (wsClient && typeof wsClient.send === 'function' && legs && legs.length > 0) {
      const legsToWatch = legs.map(l => ({
        trading_symbol: l.trading_symbol,
        token: l.token,
        strike: l.strike,
        option_type: l.option_type,
        exchange_segment: l.exchange_segment || 'nse_fo'
      }));
      wsClient.send({
        type: 'WATCH_LEGS',
        legs: legsToWatch
      });
    }
  }, [legs, wsClient]);

  // Real-time WebSocket streaming of leg prices into Strategy Builder
  useEffect(() => {
    if (!ltpCache || Object.keys(ltpCache).length === 0 || !legs || legs.length === 0) return;

    let hasUpdate = false;
    const updatedLegs = legs.map(leg => {
      // Don't overwrite if user deliberately typed a custom price
      if (leg.is_custom_price) return leg;

      const liveLtp = ltpCache[leg.trading_symbol] ?? (leg.token ? ltpCache[leg.token] : undefined);
      if (liveLtp !== undefined && liveLtp !== null && Number(liveLtp) > 0) {
        const numLtp = Number(liveLtp);
        if (leg.price !== numLtp) {
          hasUpdate = true;
          return {
            ...leg,
            price: numLtp,
            entry_price: numLtp
          };
        }
      }
      return leg;
    });

    if (hasUpdate) {
      setLegs(updatedLegs);

      // Recalculate net premium immediately
      let netPrem = 0;
      for (const l of updatedLegs) {
        const act = (l.action || 'BUY').toUpperCase();
        const p = Number(l.price || 0);
        const q = Number(l.quantity || (lots * (l.lot_size || lotSize || 65)));
        if (act.startsWith('B')) {
          netPrem -= p * q;
        } else {
          netPrem += p * q;
        }
      }

      setPayoff(prev => ({
        ...prev,
        net_premium: netPrem
      }));
    }
  }, [ltpCache, lots, lotSize]);

  // Handle Preset Selection
  const handlePresetChange = (presetId) => {
    isCustomizedRef.current = false;
    setStrategyType(presetId);
    setIsNameManuallyEdited(false);
    setIsStratSLManuallyEdited(false);
    refreshPreview(presetId, selectedExpiry, lots, mainStrike, hedgeDistance);
  };

  // Shift all strikes up or down by delta (50 pts) - Sensibull Shift
  const handleShiftAllLegs = (delta) => {
    const newAnchor = Math.round((mainStrike + delta) / 50) * 50;
    setMainStrike(newAnchor);
    setIsNameManuallyEdited(false);
    if (legs && legs.length > 0) {
      const updated = legs.map(l => {
        const copy = {
          ...l,
          strike: Math.round(((parseFloat(l.strike) || newAnchor) + delta) / 50) * 50,
          is_custom_price: false
        };
        delete copy.price;
        delete copy.entry_price;
        return copy;
      });
      setLegs(updated);
      updateCustomLegsPreview(updated);
    }
  };

  // Adjust Hedge Distance with +/- 50 pts
  const handleShiftHedge = (delta) => {
    const newHedge = Math.max(50, hedgeDistance + delta);
    setHedgeDistance(newHedge);
    setIsNameManuallyEdited(false);
    isCustomizedRef.current = false;
    refreshPreview(strategyType, selectedExpiry, lots, mainStrike, newHedge);
  };

  // Step an individual leg's strike by +/- 50 pts (Immediate real-time recalculation)
  const handleStepLegStrike = (index, delta) => {
    isCustomizedRef.current = true;
    const updated = [...legs];
    const curStrike = parseFloat(updated[index].strike) || atmSpot;
    updated[index].strike = Math.round((curStrike + delta) / 50) * 50;
    updated[index].is_custom_price = false;
    delete updated[index].price;
    delete updated[index].entry_price;
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Toggle Buy/Sell action on a leg (Immediate real-time recalculation)
  const handleToggleLegAction = (index) => {
    isCustomizedRef.current = true;
    const updated = [...legs];
    const curAction = (updated[index].action || 'BUY').toUpperCase();
    updated[index].action = curAction.startsWith('B') ? 'SELL' : 'BUY';
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Toggle CE / PE on a leg (Immediate real-time recalculation)
  const handleToggleLegOptionType = (index) => {
    isCustomizedRef.current = true;
    const updated = [...legs];
    const curOpt = (updated[index].option_type || 'CE').toUpperCase();
    updated[index].option_type = curOpt === 'CE' ? 'PE' : 'CE';
    updated[index].is_custom_price = false;
    delete updated[index].price;
    delete updated[index].entry_price;
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Change individual leg expiry (Immediate real-time recalculation)
  const handleLegExpiryChange = (index, newExpiry) => {
    isCustomizedRef.current = true;
    const updated = [...legs];
    updated[index].expiry = newExpiry;
    updated[index].is_custom_price = false;
    delete updated[index].price;
    delete updated[index].entry_price;
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Change individual leg price manually (for what-if testing)
  const handleLegPriceChange = (index, newPrice) => {
    isCustomizedRef.current = true;
    const updated = [...legs];
    updated[index].price = newPrice;
    updated[index].entry_price = newPrice;
    updated[index].is_custom_price = true;
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Reset custom price back to real-time WebSocket live quote
  const handleResetLegToLivePrice = (index) => {
    const updated = [...legs];
    updated[index].is_custom_price = false;
    const liveLtp = ltpCache ? (ltpCache[updated[index].trading_symbol] ?? (updated[index].token ? ltpCache[updated[index].token] : null)) : null;
    if (liveLtp && Number(liveLtp) > 0) {
      updated[index].price = Number(liveLtp);
      updated[index].entry_price = Number(liveLtp);
    }
    setLegs(updated);
    updateCustomLegsPreview(updated);
  };

  // Delete a leg (Immediate real-time recalculation)
  const handleDeleteLeg = (index) => {
    if (legs.length <= 1) return;
    isCustomizedRef.current = true;
    const updated = legs.filter((_, i) => i !== index);
    setLegs(updated);
    setIsNameManuallyEdited(false);
    updateCustomLegsPreview(updated);
  };

  // Multiplier / Lots change
  const handleLotsChange = (newLts) => {
    setLots(newLts);
    if (isCustomizedRef.current && legs && legs.length > 0) {
      const updated = legs.map(l => ({
        ...l,
        quantity: (l.lot_size || lotSize || 65) * newLts
      }));
      setLegs(updated);
      updateCustomLegsPreview(updated, newLts);
    } else {
      refreshPreview(strategyType, selectedExpiry, newLts, mainStrike, hedgeDistance);
    }
  };

  // Real-time Strategy Combined Net LTP: +1 for BUY leg and -1 for SELL leg
  const currentStrategyLTP = useMemo(() => {
    if (!legs || legs.length === 0) return 0;
    let total = 0;
    for (const leg of legs) {
      const isBuy = (leg.action === 'BUY' || leg.action === 'B');
      const p = parseFloat(leg.price || leg.entry_price || 0);
      total += (isBuy ? 1 : -1) * p;
    }
    return Math.round(total * 100) / 100;
  }, [legs]);

  // Automatically prefill Strategy LTP Stop Loss by 5% (or selected percentage)
  useEffect(() => {
    if (currentStrategyLTP !== 0 && !isStratSLManuallyEdited) {
      const adverse = (Math.abs(currentStrategyLTP) * slPercentage) / 100;
      const autoSL = Math.round((currentStrategyLTP - adverse) * 100) / 100;
      setStrategySLValue(autoSL);
      setSlCondition('LESS_THAN_OR_EQUAL');
    }
  }, [currentStrategyLTP, slPercentage, isStratSLManuallyEdited]);

  // Deploy Strategy
  const handleDeploy = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setOrderResults([]);

    if (slTargetType === 'STRATEGY_LTP') {
      const parsedStratSL = parseFloat(strategySLValue);
      if (isNaN(parsedStratSL)) {
        setError('Please enter a valid Strategy LTP Stop Loss value.');
        return;
      }
      if (slCondition === 'LESS_THAN_OR_EQUAL' && parsedStratSL >= currentStrategyLTP) {
        setError(`Warning: For "≤" condition, Strategy Stop-Loss (₹${parsedStratSL}) is at or above current Strategy LTP (₹${currentStrategyLTP}). It would trigger an immediate exit on candle close.`);
        return;
      }
      if (slCondition === 'GREATER_THAN_OR_EQUAL' && parsedStratSL <= currentStrategyLTP) {
        setError(`Warning: For "≥" condition, Strategy Stop-Loss (₹${parsedStratSL}) is at or below current Strategy LTP (₹${currentStrategyLTP}). It would trigger an immediate exit on candle close.`);
        return;
      }
    } else {
      const currentSpot = niftySpot || atmSpot;
      const parsedSL = parseFloat(indexSL);
      if (parsedSL > 0) {
        if (slCondition === 'LESS_THAN_OR_EQUAL' && parsedSL >= currentSpot) {
          setError(`Cannot deploy: For "≤" condition, Stop-Loss (₹${parsedSL}) must be strictly below current Nifty Spot (₹${currentSpot.toFixed(1)}). Otherwise it would trigger an immediate exit.`);
          return;
        }
        if (slCondition === 'GREATER_THAN_OR_EQUAL' && parsedSL <= currentSpot) {
          setError(`Cannot deploy: For "≥" condition, Stop-Loss (₹${parsedSL}) must be strictly above current Nifty Spot (₹${currentSpot.toFixed(1)}). Otherwise it would trigger an immediate exit.`);
          return;
        }
      }
    }

    // Safeguard Check: Warn if available margin is insufficient
    if (availableMargin !== null && availableMargin < marginRequired) {
      const shortfall = Math.round(marginRequired - availableMargin);
      const proceed = window.confirm(
        `⚠️ INSUFFICIENT MARGIN WARNING\n\n` +
        `Estimated Margin Required: ₹${Math.round(marginRequired).toLocaleString('en-IN')}\n` +
        `Available Kotak Margin: ₹${Math.round(availableMargin).toLocaleString('en-IN')}\n` +
        `Shortfall: ₹${shortfall.toLocaleString('en-IN')}\n\n` +
        `Your Kotak Neo account does not have sufficient available funds. Order placement may be rejected by the exchange/broker.\n\n` +
        `Do you still want to attempt placing these orders?`
      );
      if (!proceed) return;
    }

    setLoading(true);

    try {
      const payload = {
        name: strategyName,
        strategy_type: strategyType,
        sl_target_type: slTargetType,
        strategy_sl_value: slTargetType === 'STRATEGY_LTP' ? parseFloat(strategySLValue) : null,
        index_sl_price: slTargetType === 'INDEX' ? parseFloat(indexSL) : 0,
        index_sl_condition: slCondition,
        index_sl_mode: slTargetType === 'STRATEGY_LTP' ? 'CANDLE' : indexSLMode,
        candle_interval: (slTargetType === 'STRATEGY_LTP' || indexSLMode === 'CANDLE') ? (candleInterval || 5) : 0,
        index_target_price: indexTarget ? parseFloat(indexTarget) : null,
        expiry_code: selectedExpiry,
        order_type: orderType,
        max_profit: payoff.max_profit,
        max_loss: payoff.max_loss,
        breakeven_low: payoff.breakeven_low,
        breakeven_high: payoff.breakeven_high,
        risk_reward: payoff.risk_reward,
        hedge_distance: hedgeDistance,
        legs: legs.map(l => ({
          trading_symbol: l.trading_symbol,
          token: l.token,
          strike: parseFloat(l.strike),
          option_type: l.option_type,
          action: l.action,
          quantity: parseInt(l.quantity),
          expiry: l.expiry || selectedExpiry,
          entry_price: parseFloat(l.price || l.entry_price || 0.0),
          order_type: orderType
        }))
      };

      const res = await api.createStrategy(payload);
      const slMsg = slTargetType === 'STRATEGY_LTP'
        ? `Strategy LTP Candle Close SL @ ₹${res.strategy_sl_value ?? strategySLValue} (${candleInterval || 5}m)`
        : `Index SL @ ${res.index_sl_price}`;
      setSuccess(`Strategy "${res.name}" successfully placed on Kotak Neo with ${slMsg}!`);
      if (res.execution && Array.isArray(res.execution)) {
        setOrderResults(res.execution);
      }
      setTimeout(() => {
        setSuccess('');
      }, 6000);
      if (onStrategyCreated) onStrategyCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const distanceToSL = useMemo(() => {
    if (slTargetType === 'STRATEGY_LTP') {
      const target = parseFloat(strategySLValue);
      if (isNaN(target)) return 0;
      if (slCondition === 'GREATER_THAN_OR_EQUAL') {
        return Math.round((target - currentStrategyLTP) * 100) / 100;
      } else {
        return Math.round((currentStrategyLTP - target) * 100) / 100;
      }
    } else {
      if (!niftySpot || !indexSL) return 0;
      return slCondition === 'LESS_THAN_OR_EQUAL'
        ? Math.round((niftySpot - parseFloat(indexSL)) * 10) / 10
        : Math.round((parseFloat(indexSL) - niftySpot) * 10) / 10;
    }
  }, [slTargetType, strategySLValue, currentStrategyLTP, slCondition, niftySpot, indexSL]);
  const activePreset = STRATEGY_PRESETS.find(p => p.id === strategyType) || STRATEGY_PRESETS[0];

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-sm text-slate-800 space-y-4">
      
      {/* 1. Header with Expiry Selector & Compact Presets Toggle */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-3 border-b border-slate-200 gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 text-white flex items-center justify-center font-bold shadow-sm">
            <Layers className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Strategy Builder
            </h3>
          </div>
        </div>

        {/* Expiry Selector */}
        <div className="flex items-center gap-1.5 w-full sm:w-auto">
          <Calendar className="w-4 h-4 text-slate-500 shrink-0" />
          <select
            value={selectedExpiry}
            onChange={(e) => {
              setSelectedExpiry(e.target.value);
              setIsNameManuallyEdited(false);
            }}
            className="w-full sm:w-auto bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm cursor-pointer"
          >
            {expiries.map(exp => (
              <option key={exp.code} value={exp.code} className="font-medium">
                {exp.display}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleRefreshMaster}
            disabled={refreshingMaster}
            title="Download today's latest token master from Kotak Neo"
            className="p-1.5 rounded-lg border border-slate-200 hover:border-blue-300 hover:bg-blue-50 text-slate-500 hover:text-blue-600 transition-all cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshingMaster ? 'animate-spin text-blue-600' : ''}`} />
          </button>
        </div>
      </div>

      {/* 2. Collapsible Predefined Strategy Bar (Saves vast vertical space) */}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5">
        <div 
          onClick={() => setPresetsOpen(!presetsOpen)}
          className="flex items-center justify-between cursor-pointer select-none"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700">Predefined Strategy:</span>
            <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border shadow-sm ${
              activePreset.bias === 'BULLISH' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
              activePreset.bias === 'BEARISH' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-blue-50 text-blue-700 border-blue-200'
            }`}>
              {activePreset.name} ({activePreset.type})
            </span>
          </div>

          <button
            type="button"
            className="text-xs font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer"
          >
            <span>{presetsOpen ? 'Collapse' : 'Change Strategy'}</span>
            {presetsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* Expanded Presets Pill Grid */}
        {presetsOpen && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-3 mt-2.5 border-t border-slate-200">
            {STRATEGY_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => {
                  handlePresetChange(preset.id);
                  setPresetsOpen(false);
                }}
                className={`p-2 rounded-lg border text-left transition-all cursor-pointer ${
                  strategyType === preset.id
                    ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-sm'
                    : 'bg-white border-slate-200 hover:border-slate-300 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${
                    strategyType === preset.id
                      ? 'bg-blue-700 text-white border-blue-500'
                      : (preset.bias === 'BULLISH' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                         preset.bias === 'BEARISH' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-100 text-slate-600 border-slate-200')
                  }`}>
                    {preset.bias}
                  </span>
                </div>
                <p className="font-semibold text-xs leading-tight">{preset.name}</p>
                <span className={`text-[10px] block mt-0.5 ${strategyType === preset.id ? 'text-blue-100' : 'text-slate-500'}`}>
                  {preset.type}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 3. Sensibull Table Format Legs & In-Line Controls (Matching media_1792297475883_92dbd06e.png) */}
      <div className="border border-slate-200 rounded-lg overflow-hidden shadow-sm">
        
        {/* Table Header */}
        <div className="grid grid-cols-12 gap-2 bg-slate-50 px-3 py-2 text-[11px] font-semibold text-slate-500 border-b border-slate-200">
          <div className="col-span-1 flex items-center justify-center">B/S</div>
          <div className="col-span-3 sm:col-span-2">Expiry</div>
          <div className="col-span-4 sm:col-span-3 text-center">Strike</div>
          <div className="col-span-1 text-center">Type</div>
          <div className="col-span-1 text-center hidden sm:block">Lots</div>
          <div className="col-span-2 text-right">Price</div>
          <div className="col-span-1 text-right"></div>
        </div>

        {/* Legs Rows */}
        <div className="divide-y divide-slate-100 bg-white">
          {legs.map((leg, index) => {
            const isBuy = (leg.action || 'BUY').toUpperCase() === 'BUY';
            return (
              <div 
                key={index} 
                className="grid grid-cols-12 gap-2 items-center px-3 py-2 text-xs hover:bg-slate-50/70 transition-colors"
              >
                {/* B/S Badge */}
                <div className="col-span-1 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => handleToggleLegAction(index)}
                    title="Click to toggle BUY / SELL"
                    className={`w-11 py-1 rounded flex items-center justify-center font-bold text-[10px] tracking-wider transition-colors cursor-pointer shadow-xs ${
                      isBuy ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-rose-600 text-white hover:bg-rose-700'
                    }`}
                  >
                    {isBuy ? 'BUY' : 'SELL'}
                  </button>
                </div>

                {/* Expiry Selector */}
                <div className="col-span-3 sm:col-span-2">
                  <select
                    value={leg.expiry || selectedExpiry}
                    onChange={(e) => handleLegExpiryChange(index, e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded px-1.5 py-1 text-[11px] font-medium text-slate-800 shadow-sm focus:outline-none cursor-pointer"
                  >
                    {expiries.map(exp => (
                      <option key={exp.code} value={exp.code}>
                        {exp.display.split(' ')[0]} {exp.display.split(' ')[1]}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Strike Stepper: [-] [ 23150 ] [+] (Exact Sensibull Match) */}
                <div className="col-span-4 sm:col-span-3 flex items-center justify-center">
                  <div className="inline-flex items-center border border-slate-200 rounded bg-white shadow-sm overflow-hidden">
                    <button
                      type="button"
                      onClick={() => handleStepLegStrike(index, -50)}
                      className="px-2 py-1 hover:bg-slate-100 text-slate-600 font-bold text-xs border-r border-slate-200 transition-colors cursor-pointer"
                      title="-50 pts"
                    >
                      −
                    </button>
                    <span className="px-2.5 py-1 font-mono font-bold text-xs text-slate-800 min-w-[54px] text-center">
                      {leg.strike}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleStepLegStrike(index, 50)}
                      className="px-2 py-1 hover:bg-slate-100 text-slate-600 font-bold text-xs border-l border-slate-200 transition-colors cursor-pointer"
                      title="+50 pts"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* Option Type CE / PE */}
                <div className="col-span-1 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => handleToggleLegOptionType(index)}
                    title="Click to toggle CE / PE"
                    className="px-1.5 py-0.5 rounded text-[11px] font-bold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer transition-colors"
                  >
                    {leg.option_type}
                  </button>
                </div>

                {/* Lots Dropdown */}
                <div className="col-span-1 text-center hidden sm:block">
                  <span className="font-mono text-xs font-semibold text-slate-700">
                    {lots}
                  </span>
                </div>

                {/* Price Display / Editable LTP */}
                <div className="col-span-2 flex items-center justify-end">
                  <div className={`inline-flex items-center justify-end bg-slate-50 hover:bg-white focus-within:bg-white border rounded px-1.5 py-0.5 shadow-xs transition-colors ${
                    leg.is_custom_price ? 'border-amber-300 bg-amber-50/40' : 'border-slate-200 hover:border-slate-300 focus-within:border-blue-500'
                  }`}>
                    <span className="text-slate-400 font-sans text-[11px] mr-0.5">₹</span>
                    <input
                      type="number"
                      step="0.05"
                      value={leg.price !== undefined ? leg.price : (leg.entry_price || '')}
                      onChange={(e) => handleLegPriceChange(index, parseFloat(e.target.value) || 0)}
                      className="w-14 text-right bg-transparent font-mono text-xs font-bold text-slate-800 focus:outline-none"
                      title="LTP Price (live WebSocket stream from Kotak Neo; click to edit or test what-if)"
                    />
                    {leg.is_custom_price ? (
                      <button
                        type="button"
                        onClick={() => handleResetLegToLivePrice(index)}
                        title="Custom price set. Click to reset to live WS quote."
                        className="ml-1 text-[9px] text-amber-700 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded px-1 py-0 cursor-pointer font-bold uppercase"
                      >
                        live
                      </button>
                    ) : (
                      <span className="ml-1 flex h-1.5 w-1.5 relative" title="Live streaming via WebSocket">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500"></span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Delete / Actions */}
                <div className="col-span-1 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => handleDeleteLeg(index)}
                    title="Delete Leg"
                    className="p-1 text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 4. In-Line Adjustment Controls Toolbar (Circled in user screenshot media_1792297475883_92dbd06e.png) */}
        <div className="p-2.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          
          {/* Shift, Hedge & Multiplier in-line */}
          <div className="flex flex-wrap items-center gap-3">
            
            {/* Shift Stepper (Circled in red in screenshot) */}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-600 font-semibold">Shift</span>
              <div className="inline-flex items-center border border-slate-300 rounded bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleShiftAllLegs(-50)}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-r border-slate-200 transition-colors cursor-pointer"
                  title="Shift all strikes down by 50 pts"
                >
                  −
                </button>
                <span className="px-2.5 py-1 font-mono font-bold text-slate-800 text-[11px] min-w-[32px] text-center">
                  −
                </span>
                <button
                  type="button"
                  onClick={() => handleShiftAllLegs(50)}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-l border-slate-200 transition-colors cursor-pointer"
                  title="Shift all strikes up by 50 pts"
                >
                  +
                </button>
              </div>
            </div>

            <div className="h-4 w-[1px] bg-slate-300 hidden sm:block"></div>

            {/* Hedge Stepper (Circled in red in screenshot: Hedge [-] [ 200 ] [+]) */}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-600 font-semibold">Hedge</span>
              <div className="inline-flex items-center border border-slate-300 rounded bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleShiftHedge(-50)}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-r border-slate-200 transition-colors cursor-pointer"
                  title="Decrease hedge width by 50 pts"
                >
                  −
                </button>
                <span className="px-3 py-1 font-mono font-bold text-slate-800 text-[11px] min-w-[38px] text-center">
                  {hedgeDistance}
                </span>
                <button
                  type="button"
                  onClick={() => handleShiftHedge(50)}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-l border-slate-200 transition-colors cursor-pointer"
                  title="Increase hedge width by 50 pts"
                >
                  +
                </button>
              </div>
            </div>

            <div className="h-4 w-[1px] bg-slate-300 hidden sm:block"></div>

            {/* Multiplier (Manual input with - / + stepper) */}
            <div className="flex items-center gap-1.5">
              <span className="text-slate-600 font-semibold">Multiplier</span>
              <div className="inline-flex items-center border border-slate-300 rounded bg-white shadow-sm overflow-hidden">
                <button
                  type="button"
                  onClick={() => handleLotsChange(Math.max(1, lots - 1))}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-r border-slate-200 transition-colors cursor-pointer"
                  title="Decrease lots"
                >
                  −
                </button>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={lots}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val) && val > 0) {
                      handleLotsChange(val);
                    }
                  }}
                  className="w-12 py-1 font-mono font-bold text-slate-800 text-xs text-center focus:outline-none focus:bg-blue-50/50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  title="Enter lots manually"
                />
                <button
                  type="button"
                  onClick={() => handleLotsChange(lots + 1)}
                  className="px-2.5 py-1 hover:bg-slate-100 text-slate-700 font-bold border-l border-slate-200 transition-colors cursor-pointer"
                  title="Increase lots"
                >
                  +
                </button>
              </div>
              <span className="text-[10px] text-slate-400 font-mono hidden sm:inline">
                ({lots * lotSize} Qty)
              </span>
            </div>

          </div>

          {/* Right: Net Margin & Net Premium Summary with Live Strategy Price */}
          <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-xs font-mono ml-auto">
            <div>
              <span className="text-slate-500 font-sans text-[10px] block">Live Strategy Price</span>
              <span className={`font-bold ${currentStrategyLTP >= 0 ? 'text-blue-700' : 'text-slate-800'}`}>
                {currentStrategyLTP >= 0 ? 'Debit ' : 'Credit '}
                ₹{Math.abs(currentStrategyLTP).toFixed(2)}
              </span>
            </div>
            <div>
              <span className="text-slate-500 font-sans text-[10px] block">Margin Req</span>
              <span className="font-bold text-slate-800">
                ₹{Math.round(marginRequired).toLocaleString('en-IN')}
              </span>
            </div>
            <div>
              <span className="text-slate-500 font-sans text-[10px] block">Avail Margin</span>
              {availableMargin !== null ? (
                <span className={`font-bold ${
                  availableMargin < marginRequired ? 'text-rose-600 font-extrabold' : 'text-emerald-600'
                }`}>
                  ₹{Math.round(availableMargin).toLocaleString('en-IN')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={onOpenKotakModal}
                  className="font-bold text-blue-600 hover:text-blue-800 hover:underline cursor-pointer flex items-center gap-0.5 text-[11px]"
                  title="Click to connect Kotak Neo"
                >
                  <span>Connect Kotak</span>
                </button>
              )}
            </div>
            <div>
              <span className="text-slate-500 font-sans text-[10px] block">Premium</span>
              <span className={`font-bold ${payoff.net_premium >= 0 ? 'text-emerald-600' : 'text-slate-800'}`}>
                {payoff.net_premium >= 0 ? 'Receive ' : 'Pay '}
                ₹{Math.abs(Math.round(payoff.net_premium)).toLocaleString('en-IN')}
              </span>
            </div>
          </div>

        </div>

      </div>

      {/* 5. Strategy Metrics Grid: 2 Columns with Label & Value on the SAME line */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-2.5 font-mono text-xs">
        
        {/* Row 1, Col 1: Max Profit */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Max Profit</span>
          <span className="font-bold text-emerald-600 whitespace-nowrap text-xs sm:text-sm">
            {payoff.max_profit !== null ? `+₹${Math.round(payoff.max_profit).toLocaleString('en-IN')}` : 'Unlimited'}
          </span>
        </div>

        {/* Row 1, Col 2: Max Loss */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Max Loss</span>
          <span className="font-bold text-rose-600 whitespace-nowrap text-xs sm:text-sm">
            {payoff.max_loss !== null ? `-₹${Math.round(Math.abs(payoff.max_loss)).toLocaleString('en-IN')}` : 'Unlimited'}
          </span>
        </div>

        {/* Row 2, Col 1: Risk / Reward */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Risk / Reward</span>
          <span className="font-bold text-slate-800 whitespace-nowrap text-xs sm:text-sm">
            {payoff.risk_reward}
          </span>
        </div>

        {/* Row 2, Col 2: Breakeven(s) */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Breakeven(s)</span>
          <span className="font-bold text-slate-800 whitespace-nowrap text-xs sm:text-sm" title={payoff.breakevens.length > 0 ? payoff.breakevens.map(b => Math.round(b)).join(' & ') : '—'}>
            {payoff.breakevens.length > 0 ? payoff.breakevens.map(b => Math.round(b)).join(' & ') : '—'}
          </span>
        </div>

        {/* Row 3, Col 1: Live Strategy Price */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans flex items-center gap-1">
            <span>Live Strategy Price</span>
            <span className="text-[9px] px-1 py-0.2 rounded bg-blue-100 text-blue-700 font-bold uppercase font-mono">LTP</span>
          </span>
          <span className={`font-bold whitespace-nowrap text-xs sm:text-sm ${
            currentStrategyLTP >= 0 ? 'text-blue-700' : 'text-slate-800'
          }`}>
            {currentStrategyLTP >= 0 ? 'Debit ' : 'Credit '}
            ₹{Math.abs(currentStrategyLTP).toFixed(2)}
          </span>
        </div>

        {/* Row 3, Col 2: Net Premium */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Net Premium</span>
          <span className={`font-bold whitespace-nowrap text-xs sm:text-sm ${
            payoff.net_premium >= 0 ? 'text-emerald-600' : 'text-slate-800'
          }`}>
            {payoff.net_premium >= 0 ? 'Receive ' : 'Pay '}
            ₹{Math.abs(Math.round(payoff.net_premium)).toLocaleString('en-IN')}
          </span>
        </div>

        {/* Row 4, Col 1: Margin Required */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Margin Required</span>
          <span className="font-bold text-slate-800 whitespace-nowrap text-xs sm:text-sm">
            ₹{Math.round(marginRequired).toLocaleString('en-IN')}
          </span>
        </div>

        {/* Row 4, Col 2: Available Margin */}
        <div className="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-slate-500 font-semibold uppercase font-sans">Available Margin</span>
            {availableMargin !== null && (
              <button
                type="button"
                onClick={fetchLimits}
                disabled={limitsLoading}
                title="Refresh Kotak available margin"
                className="text-slate-400 hover:text-blue-600 transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${limitsLoading ? 'animate-spin text-blue-600' : ''}`} />
              </button>
            )}
          </div>
          {availableMargin !== null ? (
            <div className="flex items-center gap-1.5">
              <span className={`font-bold whitespace-nowrap text-xs sm:text-sm ${
                availableMargin < marginRequired ? 'text-rose-600 font-extrabold' : 'text-emerald-600'
              }`}>
                ₹{Math.round(availableMargin).toLocaleString('en-IN')}
              </span>
              {availableMargin < marginRequired && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold uppercase font-sans tracking-tight">
                  Low
                </span>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onOpenKotakModal}
              className="py-0.5 px-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded text-[10px] font-bold text-blue-700 transition-all cursor-pointer"
              title="Click to connect Kotak Neo"
            >
              Connect Kotak
            </button>
          )}
        </div>

      </div>

      {/* 6. Interactive Payoff Graph */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-blue-600" />
            <span>Payoff Diagram at Expiry</span>
          </label>
          {previewLoading && <RefreshCw className="w-3 h-3 text-slate-500 animate-spin" />}
        </div>

        <PayoffGraph
          curve={payoff.payoff_curve}
          spotPrice={niftySpot || 25100}
          breakevens={payoff.breakevens}
          maxProfit={payoff.max_profit}
          maxLoss={payoff.max_loss}
        />
      </div>

      {/* 7. Alerts */}
      {error && (
        <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 font-medium text-xs">
          {error}
        </div>
      )}

      {/* 8. Strategy Title, Stop Loss & Order Routing Form */}
      <form onSubmit={handleDeploy} className="space-y-3.5 pt-1">
        
        {/* Dynamic Strategy Name */}
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <input
              type="text"
              value={strategyName}
              onChange={(e) => {
                setStrategyName(e.target.value);
                setIsNameManuallyEdited(true);
              }}
              required
              placeholder="Strategy Title"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          {isNameManuallyEdited && (
            <button
              type="button"
              onClick={() => {
                setIsNameManuallyEdited(false);
                refreshPreview();
              }}
              className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-[11px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Reset Name</span>
            </button>
          )}
        </div>

        {/* Stop Loss Protection (Radio Button Selection: Nifty Index vs Strategy LTP) */}
        <div className="p-3.5 rounded-lg bg-amber-50/70 border border-amber-200 space-y-3">
          
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-amber-200/80">
            <div className="flex items-center gap-1.5 text-slate-900 font-bold text-xs">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              <span>Stop Loss Mechanism (Choose One)</span>
            </div>
            {distanceToSL !== 0 && (
              <span className="text-[11px] font-mono font-semibold text-slate-700 bg-white px-2 py-0.5 rounded border border-amber-200 self-start sm:self-auto">
                Buffer: <strong>{Math.abs(distanceToSL)} {slTargetType === 'STRATEGY_LTP' ? '₹' : 'pts'}</strong>
              </span>
            )}
          </div>

          {/* Radio Switcher: User can select ONLY ONE mechanism */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all ${
              slTargetType === 'INDEX'
                ? 'bg-white border-blue-600 shadow-xs ring-1 ring-blue-600'
                : 'bg-white/60 border-slate-200 hover:bg-white text-slate-600'
            }`}>
              <input
                type="radio"
                name="slTargetType"
                value="INDEX"
                checked={slTargetType === 'INDEX'}
                onChange={() => setSlTargetType('INDEX')}
                className="w-4 h-4 text-blue-600 cursor-pointer"
              />
              <div>
                <span className="block text-xs font-bold text-slate-900">Nifty Index Spot SL</span>
                <span className="block text-[10px] text-slate-500">Track Nifty 50 Index (Live tick or candle close)</span>
              </div>
            </label>

            <label className={`flex items-center gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-all ${
              slTargetType === 'STRATEGY_LTP'
                ? 'bg-white border-blue-600 shadow-xs ring-1 ring-blue-600'
                : 'bg-white/60 border-slate-200 hover:bg-white text-slate-600'
            }`}>
              <input
                type="radio"
                name="slTargetType"
                value="STRATEGY_LTP"
                checked={slTargetType === 'STRATEGY_LTP'}
                onChange={() => {
                  setSlTargetType('STRATEGY_LTP');
                  if (!candleInterval || candleInterval === 0) setCandleInterval(5);
                }}
                className="w-4 h-4 text-blue-600 cursor-pointer"
              />
              <div>
                <span className="block text-xs font-bold text-slate-900">Strategy LTP Candle Close SL</span>
                <span className="block text-[10px] text-slate-500">Track Combined Net LTP (+1 BUY, -1 SELL)</span>
              </div>
            </label>
          </div>

          {/* Details for INDEX SL */}
          {slTargetType === 'INDEX' && (
            <div className="space-y-2.5 pt-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    SL Trigger Mode:
                  </label>
                  <select
                    value={indexSLMode}
                    onChange={(e) => {
                      setIndexSLMode(e.target.value);
                      if (e.target.value === 'LIVE') setCandleInterval(0);
                      else if (candleInterval === 0) setCandleInterval(5);
                    }}
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
                  >
                    <option value="LIVE">Live Tick (Instant)</option>
                    <option value="CANDLE">Candle Close</option>
                  </select>
                </div>

                {indexSLMode === 'CANDLE' && (
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Candle Timeframe:
                    </label>
                    <select
                      value={candleInterval || 5}
                      onChange={(e) => setCandleInterval(parseInt(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value={1}>1 Minute</option>
                      <option value={3}>3 Minutes</option>
                      <option value={5}>5 Minutes</option>
                      <option value={15}>15 Minutes</option>
                      <option value={30}>30 Minutes</option>
                      <option value={60}>60 Minutes</option>
                    </select>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Square Off if Nifty Spot:
                  </label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={slCondition}
                      onChange={(e) => setSlCondition(e.target.value)}
                      className="bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value="LESS_THAN_OR_EQUAL">≤ Falls Below</option>
                      <option value="GREATER_THAN_OR_EQUAL">≥ Rises Above</option>
                    </select>
                    <input
                      type="number"
                      step="0.05"
                      value={indexSL}
                      onChange={(e) => setIndexSL(e.target.value)}
                      required={slTargetType === 'INDEX'}
                      placeholder="e.g. 25050"
                      className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono font-bold text-rose-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Target Level (Optional):
                  </label>
                  <input
                    type="number"
                    step="0.05"
                    value={indexTarget}
                    onChange={(e) => setIndexTarget(e.target.value)}
                    placeholder="Optional Target Index Level"
                    className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono font-bold text-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Details for STRATEGY_LTP SL */}
          {slTargetType === 'STRATEGY_LTP' && (
            <div className="space-y-2.5 pt-1">
              {/* Strategy LTP Live Indicator Box */}
              <div className="p-2.5 bg-white rounded-lg border border-amber-300/80 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold text-slate-700">Current Strategy Net LTP:</span>
                  <span className={`text-sm font-mono font-bold px-2 py-0.5 rounded ${
                    currentStrategyLTP >= 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                  }`}>
                    {currentStrategyLTP >= 0 ? '+' : ''}₹{currentStrategyLTP.toFixed(2)}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-mono">
                  Formula: Σ (+1 BUY, -1 SELL) × Leg LTP
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-medium text-slate-700 mb-1">
                    Candle Close Timeframe:
                  </label>
                  <select
                    value={candleInterval || 5}
                    onChange={(e) => setCandleInterval(parseInt(e.target.value))}
                    className="w-full bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
                  >
                    <option value={1}>1 Minute</option>
                    <option value={3}>3 Minutes</option>
                    <option value={5}>5 Minutes</option>
                    <option value={15}>15 Minutes</option>
                    <option value={30}>30 Minutes</option>
                    <option value={60}>60 Minutes</option>
                  </select>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-[11px] font-medium text-slate-700">
                      Square Off if Strategy LTP:
                    </label>
                    <span className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.2 rounded border border-blue-200">
                      {!isStratSLManuallyEdited ? `${slPercentage}% Prefilled` : 'Custom SL'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={slCondition}
                      onChange={(e) => setSlCondition(e.target.value)}
                      className="bg-white border border-slate-300 rounded px-2 py-1.5 text-xs font-semibold text-slate-800 focus:outline-none cursor-pointer"
                    >
                      <option value="LESS_THAN_OR_EQUAL">≤ Falls Below</option>
                      <option value="GREATER_THAN_OR_EQUAL">≥ Rises Above</option>
                    </select>
                    <input
                      type="number"
                      step="0.05"
                      value={strategySLValue}
                      onChange={(e) => {
                        setStrategySLValue(e.target.value);
                        setIsStratSLManuallyEdited(true);
                      }}
                      required={slTargetType === 'STRATEGY_LTP'}
                      placeholder="e.g. -120 or 50"
                      className="w-full bg-white border border-slate-300 rounded px-2.5 py-1.5 text-xs font-mono font-bold text-rose-600 focus:outline-none focus:ring-1 focus:ring-rose-500"
                    />
                  </div>

                  {/* Quick % SL Prefill Selector */}
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[10px] text-slate-500 font-semibold">Quick SL:</span>
                    {[5, 10, 15, 20].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          setSlPercentage(pct);
                          setIsStratSLManuallyEdited(false);
                          if (currentStrategyLTP !== 0) {
                            const adverse = (Math.abs(currentStrategyLTP) * pct) / 100;
                            const autoSL = Math.round((currentStrategyLTP - adverse) * 100) / 100;
                            setStrategySLValue(autoSL);
                            setSlCondition('LESS_THAN_OR_EQUAL');
                          }
                        }}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all cursor-pointer ${
                          slPercentage === pct && !isStratSLManuallyEdited
                            ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {pct}%{pct === 5 ? ' (Default)' : ''}
                      </button>
                    ))}
                    {isStratSLManuallyEdited && (
                      <button
                        type="button"
                        onClick={() => {
                          setIsStratSLManuallyEdited(false);
                          setSlPercentage(5);
                          if (currentStrategyLTP !== 0) {
                            const adverse = (Math.abs(currentStrategyLTP) * 5) / 100;
                            const autoSL = Math.round((currentStrategyLTP - adverse) * 100) / 100;
                            setStrategySLValue(autoSL);
                            setSlCondition('LESS_THAN_OR_EQUAL');
                          }
                        }}
                        className="text-[10px] text-blue-600 hover:underline font-semibold ml-1 cursor-pointer"
                      >
                        Reset (5%)
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Order Execution Settings (Limit vs Market) */}
        <div className="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs">
          <span className="font-semibold text-slate-700">Order Routing</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOrderType('MKT')}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                orderType === 'MKT'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              Market (MKT)
            </button>
            <button
              type="button"
              onClick={() => setOrderType('L')}
              className={`px-3 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                orderType === 'L'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
              }`}
            >
              Limit (LTP)
            </button>
          </div>
        </div>

        {/* Insufficient Margin Safeguard Alert Banner */}
        {availableMargin !== null && availableMargin < marginRequired && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-950 text-xs">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-bold text-amber-900 flex items-center gap-1.5">
                <span>Insufficient Margin Warning</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-rose-100 text-rose-700 border border-rose-300 font-mono font-bold">
                  Shortfall: ₹{Math.round(marginRequired - availableMargin).toLocaleString('en-IN')}
                </span>
              </div>
              <div className="text-amber-800 leading-relaxed">
                This strategy requires an estimated margin of <strong className="font-mono text-rose-700">₹{Math.round(marginRequired).toLocaleString('en-IN')}</strong>, but your available Kotak margin is <strong className="font-mono text-amber-900">₹{Math.round(availableMargin).toLocaleString('en-IN')}</strong>. Deploying may cause orders to be rejected by Kotak Neo.
              </div>
            </div>
          </div>
        )}

        {/* Submit Deploy Button (Sensibull Blue) */}
        <button
          type="submit"
          disabled={loading || legs.length === 0}
          className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-bold text-xs uppercase tracking-wide rounded-lg shadow-sm transition-all flex items-center justify-center gap-2 cursor-pointer"
        >
          {loading ? (
            <span>Placing Orders on Kotak Neo...</span>
          ) : (
            <>
              <span>Deploy Strategy & Place Real Orders on Kotak Neo</span>
              <ChevronRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Floating Corner Toast Notification for Strategy Execution */}
      {success && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm sm:max-w-md w-[calc(100vw-2.5rem)] bg-white border border-emerald-500/30 shadow-2xl rounded-xl p-4 animate-in fade-in slide-in-from-bottom-4 duration-300 ring-1 ring-black/5">
          <div className="flex items-start gap-3">
            <div className="p-1.5 rounded-full bg-emerald-100 text-emerald-600 shrink-0">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0 pr-1">
              <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                Strategy Executed Successfully
              </h4>
              <p className="text-[11px] text-slate-600 mt-0.5 leading-relaxed break-words">
                {success}
              </p>
              {orderResults.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-slate-100 max-h-40 overflow-y-auto space-y-1.5 font-mono text-[10px]">
                  {orderResults.map((ord, idx) => (
                    <div key={idx} className="p-1.5 bg-slate-50 rounded border border-slate-200 flex items-center justify-between gap-2">
                      <span className={ord.status === 'success' ? 'text-emerald-700 font-bold' : 'text-rose-600 font-bold'}>
                        {ord.action} {ord.quantity}x {ord.trading_symbol}
                      </span>
                      <span className="text-slate-600 shrink-0">
                        {ord.message || (ord.order_id ? `#${ord.order_id}` : 'OK')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setSuccess('');
                setOrderResults([]);
              }}
              className="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
              title="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
