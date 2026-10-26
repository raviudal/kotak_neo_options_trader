import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Dict, Any, List, Set, Optional
from fastapi import WebSocket
from backend.database import get_db

logger = logging.getLogger("market_engine")

class MarketEngine:
    _instance = None

    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        
        # Real Live Nifty 50 Spot state (streamed via Kotak Neo WebSocket)
        self.is_live = False
        self.nifty_spot = 0.0
        self.nifty_open = 0.0
        self.nifty_high = 0.0
        self.nifty_low = 0.0
        self.nifty_prev_close = 0.0
        self.nifty_change = 0.0
        self.nifty_pct_change = 0.0
        self.last_tick_time = 0

        # Real Live SENSEX Spot state (BSE)
        self.sensex_spot = 0.0
        self.sensex_open = 0.0
        self.sensex_high = 0.0
        self.sensex_low = 0.0
        self.sensex_prev_close = 0.0
        self.sensex_change = 0.0
        self.sensex_pct_change = 0.0
        
        # Option Chain Real LTP Cache {strike: {'CE': {...}, 'PE': {...}}}
        self.option_chain: Dict[int, Dict[str, Any]] = {}
        # Real-time symbol to LTP map
        self.symbol_ltp_cache: Dict[str, float] = {}
        
        # In-memory Active Strategies for ultra-fast SL checks (<0.1ms)
        self.active_strategies: Dict[int, Dict[str, Any]] = {}
        
        # In-memory Watchlist for strategy builder preview legs: {ws: [leg_dicts]}
        self.watched_preview_legs: Dict[WebSocket, List[Dict[str, Any]]] = {}
        
        # Per-strategy candle state for CANDLE SL mode {strat_id: {last_price, candle_close_time, candle_closed_price}}
        self.candle_state: Dict[int, Dict[str, Any]] = {}
        
        self.is_running = False
        self.loop = None
        self.reload_active_strategies()

    def set_client_watch_legs(self, ws: WebSocket, legs: List[Dict[str, Any]]):
        """Sets the preview legs that this WebSocket client wants live LTP streamed for"""
        if not legs:
            self.watched_preview_legs.pop(ws, None)
        else:
            self.watched_preview_legs[ws] = legs

    def get_all_watched_legs(self) -> List[Dict[str, Any]]:
        """Collects unique legs from all active strategies and client preview watchlists"""
        seen_keys = set()
        all_legs = []

        # 1. Legs from active executed strategies
        for strat in self.active_strategies.values():
            for leg in strat.get("legs", []):
                sym = leg.get("trading_symbol") or ""
                tok = str(leg.get("instrument_token") or leg.get("token") or "")
                key = (tok, sym)
                if key not in seen_keys and (tok or sym):
                    seen_keys.add(key)
                    all_legs.append({
                        "token": tok,
                        "symbol": sym,
                        "strike": leg.get("strike", 0),
                        "option_type": leg.get("option_type", ""),
                        "exchange_segment": leg.get("exchange_segment") or "nse_fo"
                    })

        # 2. Legs from preview StrategyBuilder watchlists
        for legs_list in self.watched_preview_legs.values():
            for leg in legs_list:
                sym = leg.get("trading_symbol") or ""
                tok = str(leg.get("token") or leg.get("instrument_token") or "")
                key = (tok, sym)
                if key not in seen_keys and (tok or sym):
                    seen_keys.add(key)
                    all_legs.append({
                        "token": tok,
                        "symbol": sym,
                        "strike": leg.get("strike", 0),
                        "option_type": leg.get("option_type", ""),
                        "exchange_segment": leg.get("exchange_segment") or "nse_fo"
                    })

        return all_legs

    @classmethod
    def get_instance(cls) -> "MarketEngine":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def reload_active_strategies(self):
        """Loads all ACTIVE strategies from database into memory for SL evaluation"""
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT s.id, s.user_id, s.name, s.strategy_type, s.index_sl_price, 
                       s.index_sl_condition, s.index_target_price, s.entry_index_price,
                       s.total_lots, s.net_premium,
                       s.max_profit, s.max_loss, s.breakeven_low, s.breakeven_high, s.risk_reward, s.hedge_distance,
                       s.index_sl_mode, s.candle_interval, s.created_at,
                       s.sl_target_type, s.strategy_sl_value
                FROM strategies s
                WHERE s.status = 'ACTIVE'
            """)
            strategies = cursor.fetchall()

            new_cache = {}
            for strat in strategies:
                strat_dict = dict(strat)
                cursor.execute("""
                    SELECT id, instrument_token, trading_symbol, strike, option_type, action, quantity, entry_price
                    FROM strategy_legs
                    WHERE strategy_id = ? AND status = 'OPEN'
                """, (strat["id"],))
                strat_dict["legs"] = [dict(leg) for leg in cursor.fetchall()]

                # Auto-repair / backfill payoff metrics if missing in DB
                if strat_dict.get("max_profit") is None or strat_dict.get("max_loss") is None:
                    try:
                        from backend.instrument_master import InstrumentMaster
                        master = InstrumentMaster.get_instance()
                        spot = strat_dict.get("entry_index_price") or self.nifty_spot or 25100.0
                        payoff = master.compute_payoff_profile(strat_dict["legs"], spot)
                        strat_dict["max_profit"] = payoff.get("max_profit")
                        strat_dict["max_loss"] = payoff.get("max_loss")
                        strat_dict["breakeven_low"] = payoff.get("breakeven_low")
                        strat_dict["breakeven_high"] = payoff.get("breakeven_high")
                        strat_dict["risk_reward"] = payoff.get("risk_reward")
                        if not strat_dict.get("hedge_distance") and len(strat_dict["legs"]) >= 2:
                            strat_dict["hedge_distance"] = abs(strat_dict["legs"][0]["strike"] - strat_dict["legs"][1]["strike"])

                        cursor.execute("""
                            UPDATE strategies
                            SET max_profit = ?, max_loss = ?, breakeven_low = ?,
                                 breakeven_high = ?, risk_reward = ?, hedge_distance = ?
                            WHERE id = ?
                        """, (
                            strat_dict["max_profit"], strat_dict["max_loss"],
                            strat_dict["breakeven_low"], strat_dict["breakeven_high"],
                            strat_dict["risk_reward"], strat_dict["hedge_distance"],
                            strat["id"]
                        ))
                        conn.commit()
                        logger.info(f"Auto-backfilled payoff metrics for active strategy #{strat['id']} ({strat['name']})")
                    except Exception as e:
                        logger.error(f"Error computing fallback payoff for strategy #{strat['id']}: {e}")

                new_cache[strat["id"]] = strat_dict

            self.active_strategies = new_cache
            # Clean up candle state for removed or non-CANDLE strategies, or reset if interval changed
            for old_id, state in list(self.candle_state.items()):
                strat = new_cache.get(old_id)
                sl_t = strat.get("sl_target_type") if strat else "INDEX"
                is_candle = bool(strat and ((strat.get("index_sl_mode") == "CANDLE") or (sl_t == "STRATEGY_LTP")))
                if not strat or not is_candle:
                    del self.candle_state[old_id]
                elif state.get("interval") != strat.get("candle_interval"):
                    # Reinitialize candle close time for new interval
                    iv = strat.get("candle_interval") or 5
                    cur_p = self.calculate_strategy_ltp(strat) if sl_t == "STRATEGY_LTP" else self.nifty_spot
                    self.candle_state[old_id] = {
                        "last_price": state.get("last_price", cur_p),
                        "candle_close_time": self._next_candle_close(iv),
                        "candle_closed_price": None,
                        "interval": iv,
                        "sl_target_type": sl_t
                    }
            logger.info("Loaded %d active strategies into memory", len(self.active_strategies))

    def calculate_strategy_ltp(self, strat: Dict[str, Any]) -> float:
        """
        Calculates the net combined LTP of a strategy based on its legs:
        +1 for BUY leg, -1 for SELL leg.
        """
        strat_ltp = 0.0
        for leg in strat.get("legs", []):
            sym = leg.get("trading_symbol")
            tok = str(leg.get("instrument_token") or leg.get("token") or "").strip()
            cur_price = self.symbol_ltp_cache.get(sym)
            if cur_price is None and tok:
                cur_price = self.symbol_ltp_cache.get(tok)
            if cur_price is None:
                cur_price = float(leg.get("entry_price") or 0.0)
            
            multiplier = 1.0 if str(leg.get("action", "")).upper().startswith("B") else -1.0
            strat_ltp += multiplier * cur_price
        return round(strat_ltp, 2)

    def _next_candle_close(self, interval_minutes: int) -> datetime:
        """Calculate the next candle close time aligned to 9:15 AM market open."""
        now = datetime.now()
        market_open = now.replace(hour=9, minute=15, second=0, microsecond=0)
        if now < market_open:
            return market_open + timedelta(minutes=interval_minutes)
        elapsed = (now - market_open).total_seconds()
        interval_secs = max(60, interval_minutes * 60)
        candles_passed = int(elapsed // interval_secs)
        next_close = market_open + timedelta(seconds=(candles_passed + 1) * interval_secs)
        return next_close

    def _update_candle_state(self, spot_price: float):
        """Update candle state for all CANDLE-mode strategies and evaluate SL on candle close."""
        now = datetime.now()
        for strat_id, strat in list(self.active_strategies.items()):
            sl_target = strat.get("sl_target_type") or "INDEX"
            is_candle = (strat.get("index_sl_mode") == "CANDLE") or (sl_target == "STRATEGY_LTP")
            interval = strat.get("candle_interval") or 5
            if not is_candle:
                continue

            current_price = self.calculate_strategy_ltp(strat) if sl_target == "STRATEGY_LTP" else spot_price
            
            state = self.candle_state.get(strat_id)
            if not state:
                # Initialize candle state
                self.candle_state[strat_id] = {
                    "last_price": current_price,
                    "candle_close_time": self._next_candle_close(interval),
                    "candle_closed_price": None,
                    "interval": interval,
                    "sl_target_type": sl_target
                }
                continue
            
            # Always track latest price
            state["last_price"] = current_price
            
            # Check if candle has closed
            if now >= state["candle_close_time"]:
                state["candle_closed_price"] = current_price
                logger.info(
                    f"[CANDLE CLOSE] Strategy #{strat_id} '{strat['name']}' ({sl_target}) "
                    f"{interval}min candle closed at {current_price} "
                    f"(close time: {state['candle_close_time'].strftime('%H:%M:%S')})"
                )
                # Evaluate SL using the candle close price
                if self.loop and self.loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self.evaluate_index_stop_loss(price=current_price, candle_close=True, target_strat_id=strat_id),
                        self.loop
                    )
                # Schedule next candle
                state["candle_close_time"] = self._next_candle_close(interval)
                state["candle_closed_price"] = None

    def handle_kotak_ws_message(self, message: Any):
        """
        Receives real, live binary/JSON packets from Kotak Neo WebSocket (SFeed).
        Parses live index spot ticks and option leg quotes.
        """
        try:
            packets = message if isinstance(message, list) else [message]
            for pkt in packets:
                if not isinstance(pkt, dict):
                    continue

                # Check for LTP field (Kotak Neo sends 'ltp' or 'last_traded_price' or 'iv')
                raw_ltp = pkt.get("ltp") or pkt.get("last_traded_price") or pkt.get("lp")
                token = str(pkt.get("tk") or pkt.get("instrument_token") or "")
                symbol = pkt.get("ts") or pkt.get("trading_symbol") or ""

                # 1. SENSEX Index Spot tick (token '1' in BSE or 'sensex' in symbol)
                if token == "1" or symbol.lower() == "sensex" or "bse_cm|sensex" in symbol.lower():
                    if raw_ltp is not None:
                        new_spot = float(raw_ltp)
                        if new_spot > 0:
                            self.sensex_spot = round(new_spot, 2)
                            self.is_live = True
                            self.last_tick_time = time.time()
                            if pkt.get("h"): self.sensex_high = float(pkt.get("h"))
                            if pkt.get("l"): self.sensex_low = float(pkt.get("l"))
                            if pkt.get("o"): self.sensex_open = float(pkt.get("o"))
                            if pkt.get("c"): self.sensex_prev_close = float(pkt.get("c"))
                            if pkt.get("cng"): self.sensex_change = float(pkt.get("cng"))
                            if pkt.get("nc"): self.sensex_pct_change = float(pkt.get("nc"))
                            elif self.sensex_prev_close > 0:
                                self.sensex_change = round(self.sensex_spot - self.sensex_prev_close, 2)
                                self.sensex_pct_change = round((self.sensex_change / self.sensex_prev_close) * 100, 2)

                # 2. Nifty 50 Index Spot tick (token '26000' or segment 'nse_cm' index)
                elif token == "26000" or "nifty 50" in symbol.lower() or pkt.get("isIndex"):
                    if raw_ltp is not None:
                        new_spot = float(raw_ltp)
                        if new_spot > 0:
                            self.nifty_spot = round(new_spot, 2)
                            self.is_live = True
                            self.last_tick_time = time.time()
                            
                            # Update High/Low/Open/Close if available
                            if pkt.get("h"): self.nifty_high = float(pkt.get("h"))
                            if pkt.get("l"): self.nifty_low = float(pkt.get("l"))
                            if pkt.get("o"): self.nifty_open = float(pkt.get("o"))
                            if pkt.get("c"): self.nifty_prev_close = float(pkt.get("c"))
                            if pkt.get("cng"): self.nifty_change = float(pkt.get("cng"))
                            if pkt.get("nc"): self.nifty_pct_change = float(pkt.get("nc"))
                            elif self.nifty_prev_close > 0:
                                self.nifty_change = round(self.nifty_spot - self.nifty_prev_close, 2)
                                self.nifty_pct_change = round((self.nifty_change / self.nifty_prev_close) * 100, 2)

                            # Update candle state for CANDLE-mode strategies
                            self._update_candle_state(self.nifty_spot)

                            # Evaluate Index-Based Stop Loss immediately on live tick!
                            if self.loop and self.loop.is_running():
                                asyncio.run_coroutine_threadsafe(self.evaluate_index_stop_loss(), self.loop)
                            else:
                                try:
                                    asyncio.run(self.evaluate_index_stop_loss())
                                except Exception as err:
                                    logger.error(f"Error evaluating SL in fallback: {err}")

                # 3. Option contract tick
                elif raw_ltp is not None and (symbol or token):
                    ltp_val = float(raw_ltp)
                    if symbol:
                        self.symbol_ltp_cache[symbol] = ltp_val
                    if token:
                        self.symbol_ltp_cache[token] = ltp_val

        except Exception as e:
            logger.error(f"Error handling Kotak WS message: {e}")

    def get_option_price(self, symbol: str, strike: float, option_type: str, token: str = "") -> float:
        """Returns the real live LTP for an option leg if streamed, or 0.0"""
        if symbol and symbol in self.symbol_ltp_cache:
            return self.symbol_ltp_cache[symbol]
        if token and str(token) in self.symbol_ltp_cache:
            return self.symbol_ltp_cache[str(token)]
        stk = int(strike)
        if stk in self.option_chain and option_type in self.option_chain[stk]:
            return self.option_chain[stk][option_type]["ltp"]
        return 0.0

    async def connect_client(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        await websocket.send_json(self.get_market_snapshot())

    def disconnect_client(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        self.watched_preview_legs.pop(websocket, None)

    def get_market_snapshot(self) -> Dict[str, Any]:
        """Builds snapshot of live Kotak market feed and active strategy PnL"""
        live_strats = []
        for s_id, s_data in self.active_strategies.items():
            total_pnl = 0.0
            legs_detail = []
            for leg in s_data.get("legs", []):
                cur_price = self.get_option_price(
                    leg.get("trading_symbol", ""),
                    leg["strike"],
                    leg["option_type"],
                    leg.get("token") or leg.get("instrument_token", "")
                )
                entry_price = leg["entry_price"]
                qty = leg["quantity"]
                if cur_price > 0:
                    if leg["action"].upper().startswith("B"):
                        leg_pnl = (cur_price - entry_price) * qty
                    else:
                        leg_pnl = (entry_price - cur_price) * qty
                    total_pnl += leg_pnl
                else:
                    leg_pnl = 0.0

                legs_detail.append({
                    **leg,
                    "current_price": cur_price,
                    "pnl": round(leg_pnl, 2)
                })
            
            sl_target = s_data.get("sl_target_type") or "INDEX"
            strategy_ltp = self.calculate_strategy_ltp(s_data)

            if sl_target == "STRATEGY_LTP":
                sl_price = s_data.get("strategy_sl_value") if s_data.get("strategy_sl_value") is not None else s_data.get("index_sl_price", 0.0)
                distance_to_sl = 0.0
                if s_data.get("index_sl_condition") == "GREATER_THAN_OR_EQUAL":
                    distance_to_sl = round(sl_price - strategy_ltp, 2)
                else:
                    distance_to_sl = round(strategy_ltp - sl_price, 2)
            else:
                sl_price = s_data["index_sl_price"]
                distance_to_sl = 0.0
                if self.nifty_spot > 0:
                    distance_to_sl = round(self.nifty_spot - sl_price, 2) if s_data["index_sl_condition"] == "LESS_THAN_OR_EQUAL" else round(sl_price - self.nifty_spot, 2)

            candle_remaining = 0
            cs = self.candle_state.get(s_id)
            if cs and cs.get("candle_close_time"):
                candle_remaining = max(0, int((cs["candle_close_time"] - datetime.now()).total_seconds()))

            live_strats.append({
                "id": s_id,
                "name": s_data["name"],
                "strategy_type": s_data["strategy_type"],
                "sl_target_type": sl_target,
                "strategy_sl_value": s_data.get("strategy_sl_value"),
                "strategy_ltp": strategy_ltp,
                "index_sl_price": sl_price,
                "index_sl_condition": s_data["index_sl_condition"],
                "index_target_price": s_data.get("index_target_price"),
                "entry_index_price": s_data.get("entry_index_price"),
                "current_index_price": self.nifty_spot,
                "distance_to_sl": distance_to_sl,
                "total_pnl": round(total_pnl, 2),
                "max_profit": s_data.get("max_profit"),
                "max_loss": s_data.get("max_loss"),
                "breakeven_low": s_data.get("breakeven_low"),
                "breakeven_high": s_data.get("breakeven_high"),
                "risk_reward": s_data.get("risk_reward"),
                "hedge_distance": s_data.get("hedge_distance"),
                "net_premium": s_data.get("net_premium"),
                "index_sl_mode": "CANDLE" if sl_target == "STRATEGY_LTP" else s_data.get("index_sl_mode", "LIVE"),
                "candle_interval": s_data.get("candle_interval", 0),
                "candle_time_remaining_sec": candle_remaining,
                "legs": legs_detail
            })

        return {
            "type": "MARKET_TICK",
            "timestamp": datetime.now().isoformat(),
            "is_live": self.is_live,
            "nifty": {
                "symbol": "NIFTY 50",
                "spot": self.nifty_spot,
                "change": self.nifty_change,
                "pct_change": self.nifty_pct_change,
                "open": self.nifty_open,
                "high": self.nifty_high,
                "low": self.nifty_low,
                "prev_close": self.nifty_prev_close,
                "is_live": self.is_live,
                "last_tick_time": self.last_tick_time
            },
            "sensex": {
                "symbol": "SENSEX",
                "spot": self.sensex_spot,
                "change": self.sensex_change,
                "pct_change": self.sensex_pct_change,
                "open": self.sensex_open,
                "high": self.sensex_high,
                "low": self.sensex_low,
                "prev_close": self.sensex_prev_close,
                "is_live": self.is_live,
                "last_tick_time": self.last_tick_time
            },
            "strategies": live_strats,
            "ltp_cache": self.symbol_ltp_cache,
            "server_health": self.get_current_server_health()
        }

    def get_current_server_health(self) -> Dict[str, Any]:
        try:
            from backend.system_monitor import get_system_health
            return get_system_health(ws_clients_count=len(self.active_connections))
        except Exception as e:
            logger.warning(f"Failed to fetch system health: {e}")
            return {"status": "ONLINE"}

    async def broadcast(self, message: Dict[str, Any]):
        dead_connections = set()
        for ws in self.active_connections:
            try:
                await ws.send_json(message)
            except Exception:
                dead_connections.add(ws)
        for dead in dead_connections:
            self.active_connections.discard(dead)

    async def evaluate_index_stop_loss(self, price: Optional[float] = None, candle_close: bool = False, target_strat_id: Optional[int] = None):
        """
        Ultra-fast check of active strategies against stop loss conditions.
        Supports both Nifty Index Spot SL and Strategy Combined LTP Candle Close SL.
        """
        from backend.kotak_service import KotakNeoManager

        to_trigger = []
        for strat_id, strat in list(self.active_strategies.items()):
            if target_strat_id is not None and strat_id != target_strat_id:
                continue

            sl_target = strat.get("sl_target_type") or "INDEX"

            # Entry stabilization safeguard: Do not trigger SL within 5 seconds of creation
            created_at_val = strat.get("created_at")
            if created_at_val:
                try:
                    c_dt = datetime.fromisoformat(str(created_at_val))
                    if (datetime.now() - c_dt).total_seconds() < 5.0:
                        continue
                except Exception:
                    pass

            is_breached = False
            eval_p = 0.0
            sl_threshold = 0.0
            cond = strat.get("index_sl_condition") or "LESS_THAN_OR_EQUAL"

            if sl_target == "STRATEGY_LTP":
                # Strategy LTP SL is evaluated ONLY on candle close
                if not candle_close:
                    continue

                eval_p = price if (target_strat_id == strat_id and price is not None) else self.calculate_strategy_ltp(strat)
                sl_threshold = strat.get("strategy_sl_value")
                if sl_threshold is None:
                    sl_threshold = strat.get("index_sl_price", 0.0)

                if cond == "LESS_THAN_OR_EQUAL" and eval_p <= sl_threshold:
                    is_breached = True
                elif cond == "GREATER_THAN_OR_EQUAL" and eval_p >= sl_threshold:
                    is_breached = True

            else:
                # Nifty Index Spot SL
                strat_sl_mode = strat.get("index_sl_mode", "LIVE")
                if candle_close and strat_sl_mode != "CANDLE":
                    continue
                if not candle_close and strat_sl_mode == "CANDLE":
                    continue

                if self.nifty_spot <= 0 and price is None:
                    continue

                eval_p = price if (target_strat_id == strat_id and price is not None) else self.nifty_spot
                sl_threshold = strat["index_sl_price"]

                if cond == "LESS_THAN_OR_EQUAL" and eval_p <= sl_threshold:
                    is_breached = True
                elif cond == "GREATER_THAN_OR_EQUAL" and eval_p >= sl_threshold:
                    is_breached = True

            if is_breached:
                to_trigger.append((strat_id, strat, sl_target, eval_p, sl_threshold, cond))

        trigger_type = "candle close" if candle_close else "live tick"
        for strat_id, strat, sl_target, eval_p, sl_threshold, cond in to_trigger:
            logger.warning(
                f"[{sl_target} {'CANDLE' if candle_close else 'LIVE'} STOP LOSS TRIGGERED] Strategy '{strat['name']}' (ID: {strat_id}). "
                f"Trigger Price: {eval_p}, SL Threshold: {sl_threshold} (Condition: {cond})"
            )
            # Remove from in-memory active list immediately to avoid re-triggering
            self.active_strategies.pop(strat_id, None)
            self.candle_state.pop(strat_id, None)

            manager = KotakNeoManager.get_instance(strat["user_id"])
            
            # Prepare exit legs (BUY short legs back first to prevent margin penalty, then SELL hedges)
            # CRITICAL: Stop Loss exit MUST execute as MARKET (MKT) orders for guaranteed immediate fill
            exit_legs = []
            for leg in strat.get("legs", []):
                exit_action = "BUY" if leg["action"].upper().startswith("S") else "SELL"
                token_val = str(leg.get("instrument_token") or leg.get("token") or "").strip()
                exit_legs.append({
                    "leg_id": leg.get("id"),
                    "trading_symbol": leg["trading_symbol"],
                    "token": token_val,
                    "action": exit_action,
                    "quantity": leg["quantity"],
                    "price": 0.0,
                    "entry_price": leg.get("entry_price") or 0.0,
                    "order_type": "MKT",
                    "product": "NRML",
                    "exchange_segment": "nse_fo"
                })

            # Fire real exit orders on Kotak Neo API
            try:
                exec_results = manager.execute_multi_leg_strategy(exit_legs, is_exit=True, strategy_id=strat_id)
            except Exception as e:
                logger.error(f"Failed to execute stop loss exit on Kotak Neo: {e}")
                exec_results = [{"status": "error", "message": str(e)}]

            # Update database with exit prices and realized PnL
            now_iso = datetime.now().isoformat()
            if sl_target == "STRATEGY_LTP":
                close_reason = f"Strategy LTP Candle SL hit ({eval_p} {cond} {sl_threshold})"
            else:
                close_reason = f"Index SL breached on {trigger_type} at {eval_p} (Threshold: {sl_threshold})"

            total_realized_pnl = 0.0
            with get_db() as conn:
                cursor = conn.cursor()
                for leg in strat.get("legs", []):
                    token_val = str(leg.get("instrument_token") or leg.get("token") or "").strip()
                    cur_p = self.get_option_price(leg.get("trading_symbol", ""), leg["strike"], leg["option_type"], token_val)
                    en_p = float(leg.get("entry_price") or 0.0)
                    qty = abs(int(leg.get("quantity") or 0))
                    is_buy = str(leg.get("action") or "").upper().startswith("B")
                    if cur_p > 0 and en_p > 0:
                        total_realized_pnl += ((cur_p - en_p) * qty if is_buy else (en_p - cur_p) * qty)
                    cursor.execute("""
                        UPDATE strategy_legs 
                        SET exit_price = ?, status = 'CLOSED' 
                        WHERE id = ?
                    """, (cur_p, leg.get("id")))

                cursor.execute("""
                    UPDATE strategies 
                    SET status = 'TRIGGERED_SL', closed_at = ?, close_reason = ?, realized_pnl = ?
                    WHERE id = ?
                """, (now_iso, close_reason, round(total_realized_pnl, 2), strat_id))
                conn.commit()

            try:
                manager.sync_strategy_fill_prices(strat_id)
            except Exception as e:
                logger.warning(f"Could not immediately sync SL exit fill prices: {e}")

            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT INTO activity_logs (user_id, strategy_id, log_level, message, details)
                    VALUES (?, ?, 'WARNING', ?, ?)
                """, (
                    strat["user_id"],
                    strat_id,
                    f"Stop Loss triggered for {strat['name']} ({sl_target} @ {eval_p})",
                    json.dumps(exec_results)
                ))
                conn.commit()

            # Broadcast stop loss trigger notification to UI
            alert_payload = {
                "type": "STOP_LOSS_ALERT",
                "strategy_id": strat_id,
                "strategy_name": strat["name"],
                "sl_target_type": sl_target,
                "eval_price": eval_p,
                "sl_threshold": sl_threshold,
                "message": f"Stop Loss hit for {strat['name']} ({sl_target} {'candle close' if candle_close else 'live tick'} @ {eval_p}). All legs squared off.",
                "timestamp": now_iso
            }
            asyncio.create_task(self.broadcast(alert_payload))



    async def start_feed_loop(self):
        """
        Background periodic broadcaster. Broadcasts live state to front-end.
        Fetches live Nifty quotes from Kotak Neo API every second and streams to WebSockets.
        """
        self.is_running = True
        self.loop = asyncio.get_running_loop()
        logger.info("Market feed broadcaster loop started (Live Kotak Mode).")
        loop_counter = 0
        while self.is_running:
            try:
                loop_counter += 1
                # Fetch live Nifty quote and active/preview option legs every 1 second from Kotak Neo API
                if loop_counter % 2 == 0:
                    from backend.kotak_service import KotakNeoManager
                    manager = KotakNeoManager.get_instance(1)
                    if manager.is_connected:
                        # 1. Fetch Nifty 50 and SENSEX Index quotes
                        quote = await asyncio.to_thread(manager.get_nifty_quote)
                        if quote and quote.get("spot", 0) > 0:
                            self.nifty_spot = quote["spot"]
                            self.nifty_change = quote["change"]
                            self.nifty_pct_change = quote["pct_change"]
                            self.nifty_open = quote["open"]
                            self.nifty_high = quote["high"]
                            self.nifty_low = quote["low"]
                            self.nifty_prev_close = quote["prev_close"]
                            self.is_live = True
                            self.last_tick_time = time.time()
                            await self.evaluate_index_stop_loss()
                            self._update_candle_state(self.nifty_spot)

                        sensex_q = await asyncio.to_thread(manager.get_sensex_quote)
                        if sensex_q and sensex_q.get("spot", 0) > 0:
                            self.sensex_spot = sensex_q["spot"]
                            self.sensex_change = sensex_q["change"]
                            self.sensex_pct_change = sensex_q["pct_change"]
                            self.sensex_open = sensex_q["open"]
                            self.sensex_high = sensex_q["high"]
                            self.sensex_low = sensex_q["low"]
                            self.sensex_prev_close = sensex_q["prev_close"]
                            self.is_live = True

                        # 2. Fetch live quotes for all legs (active strategies + strategy builder preview)
                        watched_legs = self.get_all_watched_legs()
                        if watched_legs:
                            def _fetch_all_legs_quotes():
                                import concurrent.futures
                                def _fetch_single(leg):
                                    sym = leg.get("symbol") or ""
                                    tok = str(leg.get("token") or "")
                                    seg = leg.get("exchange_segment") or "nse_fo"
                                    try:
                                        ltp = manager.get_instrument_ltp(seg, tok, sym)
                                        if ltp > 0:
                                            if sym: self.symbol_ltp_cache[sym] = ltp
                                            if tok: self.symbol_ltp_cache[tok] = ltp
                                            stk = int(leg.get("strike", 0))
                                            ot = leg.get("option_type")
                                            if stk and ot:
                                                if stk not in self.option_chain:
                                                    self.option_chain[stk] = {}
                                                self.option_chain[stk][ot] = {"ltp": ltp}
                                    except Exception as leg_err:
                                        logger.debug(f"Error updating quote for {sym}: {leg_err}")

                                with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(watched_legs))) as ex:
                                    list(ex.map(_fetch_single, watched_legs))

                            await asyncio.to_thread(_fetch_all_legs_quotes)

                if self.active_connections:
                    await self.broadcast(self.get_market_snapshot())
            except Exception as e:
                logger.error(f"Error in broadcast loop: {e}")
            await asyncio.sleep(0.5)

market_engine = MarketEngine.get_instance()
