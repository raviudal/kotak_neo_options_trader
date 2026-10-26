import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime

from backend.database import init_db, get_db
from backend.auth import (
    hash_password, verify_password, generate_totp_secret, 
    get_totp_uri, generate_qr_code_base64, verify_totp, 
    create_new_user_session, get_current_user, verify_ws_token
)
from backend.kotak_service import KotakNeoManager
from backend.market_engine import MarketEngine
from backend.config import (
    BASE_DIR, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, ADMIN_SEED,
    REGISTRATION_ENABLED, MAX_USERS
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("main")

market_engine = MarketEngine.get_instance()
background_tasks = set()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB schema
    init_db()
    # Seed default user if enabled and no user exists
    if ADMIN_SEED:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM users WHERE username = ?", (DEFAULT_ADMIN_USERNAME,))
            if not cursor.fetchone():
                secret = generate_totp_secret()
                h_pwd = hash_password(DEFAULT_ADMIN_PASSWORD)
                cursor.execute(
                    "INSERT INTO users (username, hashed_password, totp_secret, totp_enabled) VALUES (?, ?, ?, 1)",
                    (DEFAULT_ADMIN_USERNAME, h_pwd, secret)
                )
                new_uid = cursor.lastrowid
                cursor.execute(
                    "INSERT OR IGNORE INTO kotak_config (user_id, consumer_key, mobile_number, ucc, mpin, is_connected) VALUES (?, '', '', '', '', 0)",
                    (new_uid,)
                )
                conn.commit()
                logger.info(f"Default admin created: '{DEFAULT_ADMIN_USERNAME}'")

    # Start live feed broadcaster loop
    task = asyncio.create_task(market_engine.start_feed_loop())
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)

    # Ensure token master is loaded and updated for today at server start
    try:
        from backend.instrument_master import InstrumentMaster
        scrip_task = asyncio.create_task(asyncio.to_thread(InstrumentMaster.get_instance().ensure_today_master))
        background_tasks.add(scrip_task)
        scrip_task.add_done_callback(background_tasks.discard)
    except Exception as e:
        logger.warning(f"Could not initialize token master background update: {e}")

    yield
    market_engine.is_running = False

app = FastAPI(title="Kotak Neo Nifty Options Engine", lifespan=lifespan)

# Allow CORS for mobile browsers and local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Models ---
class LoginRequest(BaseModel):
    username: str
    password: str
    totp_code: str

class RegisterRequest(BaseModel):
    username: str
    password: str

class KotakLoginRequest(BaseModel):
    consumer_key: Optional[str] = None
    mobile_number: Optional[str] = None
    ucc: Optional[str] = None
    mpin: Optional[str] = None
    totp: Optional[str] = None
    totp_secret: Optional[str] = None

class StrategyLegInput(BaseModel):
    trading_symbol: Optional[str] = None
    token: Optional[str] = None
    strike: float
    option_type: str  # CE or PE
    action: str       # BUY or SELL
    quantity: int
    expiry: Optional[str] = None
    entry_price: Optional[float] = 0.0
    order_type: Optional[str] = "MKT"

class StrategyCreateRequest(BaseModel):
    name: str
    strategy_type: str
    index_sl_price: float
    index_sl_condition: str  # LESS_THAN_OR_EQUAL or GREATER_THAN_OR_EQUAL
    index_target_price: Optional[float] = None
    expiry_code: Optional[str] = None
    order_type: Optional[str] = "MKT"
    max_profit: Optional[float] = None
    max_loss: Optional[float] = None
    breakeven_low: Optional[float] = None
    breakeven_high: Optional[float] = None
    risk_reward: Optional[str] = None
    hedge_distance: Optional[float] = None
    index_sl_mode: Optional[str] = "LIVE"     # 'LIVE' or 'CANDLE'
    candle_interval: Optional[int] = 0         # 0, 5, 15, 30, 60 minutes
    sl_target_type: Optional[str] = "INDEX"    # 'INDEX' or 'STRATEGY_LTP'
    strategy_sl_value: Optional[float] = None  # Trigger value for Strategy LTP SL
    legs: List[StrategyLegInput]

class StrategyUpdateSLRequest(BaseModel):
    index_sl_price: Optional[float] = None
    index_sl_condition: Optional[str] = None   # 'LESS_THAN_OR_EQUAL' or 'GREATER_THAN_OR_EQUAL'
    index_sl_mode: Optional[str] = "LIVE"      # 'LIVE' or 'CANDLE'
    candle_interval: Optional[int] = 0         # 0, 5, 15, 30, 60 minutes
    sl_target_type: Optional[str] = None       # 'INDEX' or 'STRATEGY_LTP'
    strategy_sl_value: Optional[float] = None  # Trigger value for Strategy LTP SL

class StrategyPreviewRequest(BaseModel):
    strategy_type: str
    expiry_code: Optional[str] = None
    spread_width: Optional[float] = 100.0
    wing_width: Optional[float] = 300.0
    lots: Optional[int] = 1
    spot_price: Optional[float] = None
    main_strike: Optional[float] = None
    hedge_distance: Optional[float] = None
    custom_legs: Optional[List[Dict[str, Any]]] = None

class SingleOrderRequest(BaseModel):
    trading_symbol: str
    token: Optional[str] = ""
    action: str  # BUY or SELL
    quantity: int = 1
    strike: Optional[float] = None
    option_type: Optional[str] = None
    product: Optional[str] = "NRML"
    order_type: Optional[str] = "MKT"
    price: Optional[float] = 0.0
    exchange_segment: Optional[str] = "nse_fo"

# --- Authentication Endpoints ---

@app.get("/api/auth/registration-status")
def get_registration_status():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM users")
        user_count = cursor.fetchone()[0]
    return {
        "registration_enabled": REGISTRATION_ENABLED and (user_count < MAX_USERS),
        "user_count": user_count,
        "max_users": MAX_USERS
    }

@app.post("/api/auth/register")
def register_user(req: RegisterRequest):
    if not REGISTRATION_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, 
            detail="Public registration is disabled by the administrator. Contact host."
        )

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM users")
        user_count = cursor.fetchone()[0]
        if user_count >= MAX_USERS:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Registration limit reached ({MAX_USERS} users max)."
            )

    uname = req.username.strip()
    if len(uname) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters long")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters long")

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE username = ?", (uname,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Username already exists. Please choose another username.")
        
        secret = generate_totp_secret()
        h_pwd = hash_password(req.password)
        cursor.execute(
            "INSERT INTO users (username, hashed_password, totp_secret, totp_enabled) VALUES (?, ?, ?, 1)",
            (uname, h_pwd, secret)
        )
        new_user_id = cursor.lastrowid
        cursor.execute(
            "INSERT OR IGNORE INTO kotak_config (user_id, consumer_key, mobile_number, ucc, mpin, is_connected) VALUES (?, '', '', '', '', 0)",
            (new_user_id,)
        )
        conn.commit()

        uri = get_totp_uri(secret, uname)
        qr_base64 = generate_qr_code_base64(uri)
        return {
            "status": "success",
            "message": "User registered successfully. Please scan QR in Google Authenticator.",
            "username": uname,
            "totp_secret": secret,
            "qr_code": qr_base64
        }

@app.post("/api/auth/login")
def login(req: LoginRequest):
    uname = req.username.strip()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, hashed_password, totp_secret, totp_enabled FROM users WHERE username = ?", (uname,))
        user = cursor.fetchone()
        
        if not user or not verify_password(user["hashed_password"], req.password):
            raise HTTPException(status_code=401, detail="Invalid username or password")

        # Verify Google Authenticator 2FA TOTP code
        if user["totp_enabled"]:
            if not verify_totp(user["totp_secret"], req.totp_code):
                raise HTTPException(status_code=401, detail="Invalid 6-digit Google Authenticator code")

        # Create new unique session, strictly invalidating any other open session
        token = create_new_user_session(user["id"], user["username"])

        # Check and download updated token master for today upon the first login of the day
        try:
            from backend.instrument_master import InstrumentMaster
            asyncio.create_task(asyncio.to_thread(InstrumentMaster.get_instance().ensure_today_master))
        except Exception as e:
            logger.warning(f"Could not trigger background token master check: {e}")

        return {
            "access_token": token,
            "token_type": "bearer",
            "user": {"id": user["id"], "username": user["username"]}
        }

@app.get("/api/auth/setup-2fa")
def setup_2fa(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT totp_secret FROM users WHERE id = ?", (user["id"],))
        row = cursor.fetchone()
        secret = row["totp_secret"]
        uri = get_totp_uri(secret, user["username"])
        qr_base64 = generate_qr_code_base64(uri)
        return {
            "secret": secret,
            "qr_code": qr_base64,
            "uri": uri
        }

@app.get("/api/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    return user

# --- Kotak Neo Integration Endpoints ---

@app.get("/api/kotak/saved-config")
def get_saved_kotak_config(user: dict = Depends(get_current_user)):
    """Returns saved Kotak credentials so the UI automatically auto-fills them"""
    manager = KotakNeoManager.get_instance(user["id"])
    return manager.get_saved_credentials()

@app.post("/api/kotak/login")
def kotak_login(req: KotakLoginRequest, user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    res = manager.login_totp(
        consumer_key=req.consumer_key,
        mobile_number=req.mobile_number,
        ucc=req.ucc,
        totp=req.totp,
        mpin=req.mpin,
        totp_secret=req.totp_secret
    )
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message", "Kotak Neo authentication failed"))
    return res

@app.post("/api/kotak/restore-session")
def kotak_restore_session(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    if manager.verify_session(force_check=True):
        return {"status": "success", "message": f"Active in-RAM session verified for {manager.client_name} ({manager.ucc})"}
    raise HTTPException(status_code=400, detail="No active in-memory session. Please enter your 6-digit TOTP to authenticate.")

@app.post("/api/kotak/disconnect")
def kotak_disconnect(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    return manager.disconnect()

@app.post("/api/kotak/test-session")
def set_test_kotak_session(user: dict = Depends(get_current_user)):
    """Initializes in-RAM test session for automated tests"""
    manager = KotakNeoManager.get_instance(user["id"])
    manager.trade_token = "test_ram_token_only"
    manager.trade_sid = "test_ram_sid_only"
    manager.session_created_at = datetime.now()
    manager.is_connected = True
    return {"status": "success", "message": "In-RAM test session active"}

@app.get("/api/kotak/status")
def kotak_status(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    return manager.get_status()

@app.get("/api/kotak/limits")
def kotak_limits(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")
    return manager.get_limits()

@app.get("/api/kotak/positions")
def kotak_positions(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")
    return manager.get_positions()

class CheckMarginRequest(BaseModel):
    legs: List[Dict[str, Any]]
    max_loss: Optional[float] = None
    max_profit: Optional[float] = None

@app.post("/api/kotak/check-margin")
def kotak_check_margin(req: CheckMarginRequest, user: dict = Depends(get_current_user)):
    """Queries Kotak Neo /quick/user/check-margin endpoint for strategy legs"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        return {"is_connected": False, "message": "Kotak Neo login required"}
    return manager.check_order_margin(req.legs, max_loss=req.max_loss, max_profit=req.max_profit)

# --- Option Strategies & Stop Loss Endpoints ---

def _enrich_strategy_pnl(strat_dict: dict) -> dict:
    """Computes per-leg PnL and total realized PnL for closed or triggered strategies"""
    if strat_dict.get("status") in ["CLOSED", "TRIGGERED_SL"]:
        calc_total_pnl = 0.0
        has_any_exit = False
        for leg in strat_dict.get("legs", []):
            en = float(leg.get("entry_price") or 0.0)
            ex = float(leg.get("exit_price") or 0.0)
            q = abs(int(leg.get("quantity") or 0))
            is_buy = str(leg.get("action") or "").upper().startswith("B")
            if ex > 0 and en > 0:
                has_any_exit = True
                leg_pnl = (ex - en) * q if is_buy else (en - ex) * q
                leg["realized_pnl"] = round(leg_pnl, 2)
                calc_total_pnl += leg_pnl
            else:
                leg["realized_pnl"] = None
        
        db_pnl = strat_dict.get("realized_pnl")
        if (db_pnl is None or db_pnl == 0.0) and has_any_exit:
            strat_dict["realized_pnl"] = round(calc_total_pnl, 2)
    return strat_dict

@app.get("/api/strategies")
def list_strategies(user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required to access strategies")

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT s.*, 
                   (SELECT COUNT(*) FROM strategy_legs WHERE strategy_id = s.id) as leg_count
            FROM strategies s
            WHERE s.user_id = ?
            ORDER BY s.id DESC
        """, (user["id"],))
        rows = cursor.fetchall()
        
        result = []
        for r in rows:
            strat_dict = dict(r)
            cursor.execute("SELECT * FROM strategy_legs WHERE strategy_id = ?", (r["id"],))
            strat_dict["legs"] = [dict(leg) for leg in cursor.fetchall()]
            result.append(_enrich_strategy_pnl(strat_dict))
            
        return result

@app.get("/api/strategies/book")
def get_strategy_book(user: dict = Depends(get_current_user)):
    """Returns complete strategy execution book with all legs and Kotak broker order IDs"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT s.id, s.name, s.strategy_type, s.status, s.order_status,
                   s.index_symbol, s.entry_index_price, s.index_sl_price, s.index_sl_condition,
                   s.index_target_price, s.total_lots, s.net_premium, s.realized_pnl,
                   s.created_at, s.closed_at, s.close_reason,
                   s.max_profit, s.max_loss, s.breakeven_low, s.breakeven_high, s.risk_reward, s.hedge_distance,
                   s.index_sl_mode, s.candle_interval, s.sl_target_type, s.strategy_sl_value
            FROM strategies s
            WHERE s.user_id = ?
            ORDER BY s.id DESC
        """, (user["id"],))
        strategies = []
        for s in cursor.fetchall():
            s_dict = dict(s)
            cursor.execute("""
                SELECT id, instrument_token, trading_symbol, strike, option_type, action,
                       quantity, entry_price, exit_price, order_id, status,
                       execution_status, execution_message, executed_at, exit_order_id, exit_executed_at
                FROM strategy_legs
                WHERE strategy_id = ?
                ORDER BY id ASC
            """, (s["id"],))
            s_dict["legs"] = [dict(leg) for leg in cursor.fetchall()]
            strategies.append(_enrich_strategy_pnl(s_dict))
        return strategies

@app.get("/api/orders/logs")
def get_order_logs(limit: int = Query(100), user: dict = Depends(get_current_user)):
    """SEBI Mandated Log Keeping: Returns full audit logs for all orders sent and responses received"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, timestamp, trading_symbol, exchange_segment, transaction_type,
                   quantity, price, trigger_price, order_type, product, tag, token, is_amo,
                   latency_ms, status, order_id, error_message, sent_payload, received_response, http_status
            FROM order_logs
            WHERE user_id = ?
            ORDER BY id DESC LIMIT ?
        """, (user["id"], limit))
        return [dict(r) for r in cursor.fetchall()]


@app.get("/api/market/expiries")
def get_nifty_expiries(user: dict = Depends(get_current_user)):
    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()
    return master.get_sorted_expiries()

@app.get("/api/market/strikes")
def get_nifty_strikes(expiry: Optional[str] = Query(None), user: dict = Depends(get_current_user)):
    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()
    return master.get_strikes(expiry)

@app.get("/api/market/chain")
def get_option_chain(expiry: Optional[str] = Query(None), count: int = Query(10), user: dict = Depends(get_current_user)):
    """Returns current active strikes and spot from master scrip and live prices"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")

    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()
    spot = market_engine.nifty_spot or 25100.0
    snapshot = master.get_option_chain_snapshot(spot, expiry, count)
    snapshot["is_live"] = market_engine.is_live
    return snapshot

@app.post("/api/market/refresh-master")
def refresh_token_master(user: dict = Depends(get_current_user)):
    """Manually force re-download of today's scrip master from Kotak Neo"""
    manager = KotakNeoManager.get_instance(user["id"])
    key = manager.consumer_key
    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()
    success = master.ensure_today_master(force=True, consumer_key=key)
    expiries = master.get_sorted_expiries()
    return {
        "status": "success" if success else "warning",
        "message": "Token master updated successfully for today!" if success else "Using existing token master copy.",
        "expiries_count": len(expiries),
        "nearest_expiry": expiries[0]["display"] if expiries else None,
        "expiries": expiries
    }

@app.post("/api/strategies/preview")
def preview_strategy(req: StrategyPreviewRequest, user: dict = Depends(get_current_user)):
    """Computes exact strikes, expiries, tokens, symbols, auto strategy name, and payoff profile for preset"""
    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()
    spot = req.spot_price or market_engine.nifty_spot or 25100.0
    effective_hedge = req.hedge_distance if req.hedge_distance is not None else (req.spread_width or 100.0)
    if req.custom_legs and len(req.custom_legs) > 0:
        legs = master.resolve_custom_legs(
            custom_legs=req.custom_legs,
            spot_price=spot,
            default_expiry=req.expiry_code,
            lots=req.lots or 1
        )
    else:
        legs = master.build_strategy_legs(
            strategy_type=req.strategy_type,
            spot_price=spot,
            expiry_code=req.expiry_code,
            spread_width=effective_hedge,
            wing_width=req.wing_width or 300.0,
            lots=req.lots or 1,
            main_strike=req.main_strike,
            hedge_distance=effective_hedge
        )

    # ── Fetch Live Real Quotes from Kotak Neo API if connected ──
    try:
        manager = KotakNeoManager.get_instance(user["id"])
        if manager.is_connected:
            import concurrent.futures
            def _fetch_live_quote(leg):
                # Don't overwrite if user manually set a custom price
                if leg.get("is_custom_price") and float(leg.get("price") or 0.0) > 0:
                    return float(leg["price"])
                tok = str(leg.get("token") or "").strip()
                sym = str(leg.get("trading_symbol") or "").strip()
                seg = str(leg.get("exchange_segment") or "nse_fo").strip()
                
                cached = market_engine.get_option_price(sym, leg.get("strike", 0), leg.get("option_type", ""), tok)
                if cached > 0:
                    return cached

                try:
                    ltp = manager.get_instrument_ltp(seg, tok, sym)
                    if ltp > 0:
                        market_engine.symbol_ltp_cache[sym] = ltp
                        if tok:
                            market_engine.symbol_ltp_cache[tok] = ltp
                        return ltp
                except Exception as e:
                    logger.warning(f"Error fetching live quote for {sym}: {e}")
                return 0.0

            if legs:
                with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(legs))) as executor:
                    live_quotes = list(executor.map(_fetch_live_quote, legs))

                for leg, ltp in zip(legs, live_quotes):
                    if ltp > 0:
                        leg["price"] = ltp
                        leg["entry_price"] = ltp
    except Exception as e:
        logger.error(f"Error in preview live quote retrieval: {e}")

    payoff = master.compute_payoff_profile(legs, spot)
    auto_name = master.generate_strategy_name(req.strategy_type, legs)
    anchor = req.main_strike if req.main_strike is not None else (round(spot / 50.0) * 50.0)

    # Fetch live full margin from Kotak Neo API if connected
    margin_req = payoff.get("margin_required")
    try:
        if manager.is_connected and legs:
            margin_res = manager.check_order_margin(legs, max_loss=payoff.get("max_loss"), max_profit=payoff.get("max_profit"))
            if margin_res and margin_res.get("broker_total_margin", 0) > 0:
                margin_req = margin_res["broker_total_margin"]
    except Exception as e:
        logger.debug(f"Error checking broker margin during preview: {e}")

    return {
        "strategy_type": req.strategy_type,
        "strategy_name": auto_name,
        "spot_price": spot,
        "main_strike": anchor,
        "hedge_distance": effective_hedge,
        "expiry_code": req.expiry_code,
        "legs": legs,
        "max_profit": payoff.get("max_profit"),
        "max_loss": payoff.get("max_loss"),
        "breakeven_low": payoff.get("breakeven_low"),
        "breakeven_high": payoff.get("breakeven_high"),
        "breakevens": payoff.get("breakevens", []),
        "risk_reward": payoff.get("risk_reward"),
        "margin_required": margin_req,
        "net_premium": payoff.get("net_premium"),
        "payoff_curve": payoff.get("payoff_curve", [])
    }

@app.post("/api/orders/place")
def place_single_order(req: SingleOrderRequest, user: dict = Depends(get_current_user)):
    """Places a single order on Kotak Neo API with token and symbol verification"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")

    res = manager.place_order_leg({
        "trading_symbol": req.trading_symbol,
        "token": req.token,
        "action": req.action,
        "quantity": req.quantity,
        "strike": req.strike,
        "option_type": req.option_type,
        "product": req.product or "NRML",
        "order_type": req.order_type or "MKT",
        "price": req.price or 0.0,
        "exchange_segment": req.exchange_segment or ("nse_cm" if req.product == "CNC" else "nse_fo")
    })
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message", "Order rejected"))
    return res

@app.post("/api/orders/test-itc")
def test_itc_order(user: dict = Depends(get_current_user)):
    """Places a live test order for 1 share of ITC (ITC-EQ, token 1660, nse_cm, CNC) on Kotak Neo"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")

    res = manager.place_order_leg({
        "trading_symbol": "ITC-EQ",
        "token": "1660",
        "action": "BUY",
        "quantity": 1,
        "exchange_segment": "nse_cm",
        "product": "CNC",
        "order_type": "L",
        "price": 0.0,
        "tag": "TEST_ITC_1"
    })
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message", "ITC Test Order Rejected"))
    return res

@app.post("/api/strategies")
def create_strategy(req: StrategyCreateRequest, user: dict = Depends(get_current_user)):
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Cannot place orders: Kotak Neo is not logged in.")

    from backend.instrument_master import InstrumentMaster
    master = InstrumentMaster.get_instance()

    current_spot = market_engine.nifty_spot or 25100.0
    sl_target = req.sl_target_type or "INDEX"
    effective_sl_mode = "CANDLE" if sl_target == "STRATEGY_LTP" else (req.index_sl_mode or "LIVE")
    effective_candle_interval = req.candle_interval if effective_sl_mode == "CANDLE" else 0
    if effective_sl_mode == "CANDLE" and not effective_candle_interval:
        effective_candle_interval = 5

    # Stop-Loss Premature Trigger Safeguard: Prevent deploying with an Index SL that is already breached
    if sl_target == "INDEX":
        if req.index_sl_condition == "LESS_THAN_OR_EQUAL" and req.index_sl_price >= current_spot:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot deploy strategy: For '≤' condition, Stop-Loss price ({req.index_sl_price}) must be strictly below current Nifty Spot ({current_spot}). It would trigger an immediate exit."
            )
        if req.index_sl_condition == "GREATER_THAN_OR_EQUAL" and req.index_sl_price <= current_spot:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot deploy strategy: For '≥' condition, Stop-Loss price ({req.index_sl_price}) must be strictly above current Nifty Spot ({current_spot}). It would trigger an immediate exit."
            )

    # Auto-resolve tokens, symbols, and entry prices for all legs
    net_premium = 0.0
    legs_to_execute = []
    resolved_legs_info = []

    for leg in req.legs:
        # Resolve instrument metadata if token or symbol missing
        token = leg.token
        symbol = leg.trading_symbol
        if not token or not symbol:
            inst = master.resolve_option(leg.strike, leg.option_type, req.expiry_code or leg.expiry)
            if inst:
                token = inst.token
                symbol = inst.trading_symbol
                leg.quantity = leg.quantity or inst.lot_size
            else:
                token = f"TOKEN_{int(leg.strike)}_{leg.option_type}"
                symbol = symbol or f"NIFTY{int(leg.strike)}{leg.option_type}"

        price = leg.entry_price or market_engine.get_option_price(symbol, leg.strike, leg.option_type, token)
        leg.entry_price = price
        if leg.action.upper().startswith("B"):
            net_premium -= price
        else:
            net_premium += price

        leg_ot = getattr(leg, "order_type", None) or req.order_type or "MKT"
        resolved_legs_info.append({
            "token": token,
            "symbol": symbol,
            "strike": leg.strike,
            "option_type": leg.option_type,
            "action": leg.action,
            "quantity": leg.quantity,
            "entry_price": leg.entry_price,
            "order_type": leg_ot
        })

    # Compute Payoff Profile & Metrics
    payoff = master.compute_payoff_profile(resolved_legs_info, current_spot)
    final_max_profit = req.max_profit if req.max_profit is not None else payoff.get("max_profit")
    final_max_loss = req.max_loss if req.max_loss is not None else payoff.get("max_loss")
    final_be_low = req.breakeven_low if req.breakeven_low is not None else payoff.get("breakeven_low")
    final_be_high = req.breakeven_high if req.breakeven_high is not None else payoff.get("breakeven_high")
    final_rr = req.risk_reward or payoff.get("risk_reward")
    final_hedge = req.hedge_distance if req.hedge_distance is not None else (
        abs(resolved_legs_info[0]["strike"] - resolved_legs_info[1]["strike"]) if len(resolved_legs_info) >= 2 else 100.0
    )

    strat_name = req.name.strip() if req.name and req.name.strip() else master.generate_strategy_name(req.strategy_type, resolved_legs_info)
    strat_sl_val = req.strategy_sl_value if req.strategy_sl_value is not None else req.index_sl_price

    # 1. Save strategy into database
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO strategies 
            (user_id, name, strategy_type, index_sl_price, index_sl_condition, index_target_price, entry_index_price, net_premium,
             max_profit, max_loss, breakeven_low, breakeven_high, risk_reward, hedge_distance,
             index_sl_mode, candle_interval, sl_target_type, strategy_sl_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user["id"], strat_name, req.strategy_type, req.index_sl_price, 
            req.index_sl_condition, req.index_target_price, current_spot, round(net_premium, 2),
            final_max_profit, final_max_loss, final_be_low, final_be_high, final_rr, final_hedge,
            effective_sl_mode, effective_candle_interval, sl_target, strat_sl_val
        ))
        strat_id = cursor.lastrowid

        # 2. Save individual legs with real token and symbol
        default_ot = (req.order_type or "MKT").strip().upper()
        if default_ot in ["M", "MARKET", "MKT"]:
            default_ot = "MKT"
        elif default_ot in ["L", "LIMIT"]:
            default_ot = "L"

        for item in resolved_legs_info:
            cursor.execute("""
                INSERT INTO strategy_legs 
                (strategy_id, instrument_token, trading_symbol, strike, option_type, action, quantity, entry_price)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                strat_id, item["token"], item["symbol"],
                item["strike"], item["option_type"], item["action"], item["quantity"], item["entry_price"]
            ))
            leg_id = cursor.lastrowid

            leg_ot = str(item.get("order_type") or default_ot).strip().upper()
            if leg_ot in ["M", "MARKET", "MKT"]:
                leg_ot = "MKT"
                exec_price = 0.0
            elif leg_ot in ["L", "LIMIT"]:
                leg_ot = "L"
                exec_price = float(item["entry_price"] or 0.0)
            else:
                leg_ot = "MKT"
                exec_price = 0.0

            legs_to_execute.append({
                "leg_id": leg_id,
                "trading_symbol": item["symbol"],
                "token": item["token"],
                "action": item["action"],
                "quantity": item["quantity"],
                "price": exec_price,
                "order_type": leg_ot,
                "exchange_segment": "nse_fo",
                "product": "NRML"
            })
        conn.commit()

    # 3. Execute live order on Kotak Neo API with BUY legs placed first
    try:
        exec_results = manager.execute_multi_leg_strategy(legs_to_execute, is_exit=False, strategy_id=strat_id)
    except Exception as e:
        logger.error(f"Error executing strategy legs: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to place orders: {e}")

    # Determine execution summary
    all_success = all(r.get("status") == "success" for r in exec_results) if exec_results else False
    any_success = any(r.get("status") == "success" for r in exec_results) if exec_results else False
    order_status_summary = "ALL_PLACED" if all_success else ("PARTIAL_PLACED" if any_success else "ALL_REJECTED")

    # 4. If orders were placed, immediately sync executed fill prices from Kotak Neo API
    if any_success:
        try:
            time.sleep(0.3)
            sync_res = manager.sync_strategy_fill_prices(strat_id)
            logger.info(f"Strategy #{strat_id} fill prices sync result: {sync_res}")
        except Exception as e:
            logger.warning(f"Could not immediately sync fill prices for strategy #{strat_id}: {e}")

    # 5. Reload active strategies into memory for sub-millisecond live tick monitoring
    market_engine.reload_active_strategies()

    first_err = ""
    for r in exec_results:
        if r.get("status") != "success":
            first_err = r.get("message") or ""
            break

    msg = "Strategy deployed and broker orders placed!" if all_success else (
        f"Some orders were rejected by Kotak RMS: {first_err}" if any_success else f"Orders rejected by Kotak: {first_err or 'Check order logs'}"
    )

    return {
        "status": "success" if any_success else "warning",
        "order_status": order_status_summary,
        "strategy_id": strat_id,
        "name": req.name,
        "entry_index_price": current_spot,
        "index_sl_price": req.index_sl_price,
        "execution": exec_results,
        "message": msg
    }

@app.post("/api/strategies/{strategy_id}/sync")
def sync_strategy(strategy_id: int, user: dict = Depends(get_current_user)):
    """Fetches real-time executed fill prices from Kotak Neo API and recalculates payoff profile"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")

    res = manager.sync_strategy_fill_prices(strategy_id)
    if res.get("status") == "error":
        raise HTTPException(status_code=400, detail=res.get("message", "Sync failed"))
@app.put("/api/strategies/{strategy_id}/sl")
def update_strategy_sl(strategy_id: int, req: StrategyUpdateSLRequest, user: dict = Depends(get_current_user)):
    """Dynamically updates the Stop Loss target type, price, condition, SL trigger mode, and candle timeframe for an active strategy"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, name, status, index_sl_price, index_sl_condition, index_sl_mode, candle_interval,
                   sl_target_type, strategy_sl_value
            FROM strategies WHERE id = ? AND user_id = ?
        """, (strategy_id, user["id"]))
        strat = cursor.fetchone()
        if not strat:
            raise HTTPException(status_code=404, detail="Strategy not found")
        if strat["status"] != "ACTIVE":
            raise HTTPException(status_code=400, detail="Cannot update SL for a non-active strategy")

        strat_dict = dict(strat)
        new_target = req.sl_target_type or strat_dict.get("sl_target_type") or "INDEX"
        new_cond = req.index_sl_condition or strat_dict["index_sl_condition"]
        new_mode = "CANDLE" if new_target == "STRATEGY_LTP" else (req.index_sl_mode or strat_dict.get("index_sl_mode") or "LIVE")
        new_interval = req.candle_interval if new_mode == "CANDLE" else 0
        if new_mode == "CANDLE" and not new_interval:
            new_interval = strat_dict.get("candle_interval") or 5

        new_idx_sl = req.index_sl_price if req.index_sl_price is not None else strat_dict["index_sl_price"]
        new_strat_sl_val = req.strategy_sl_value if req.strategy_sl_value is not None else strat_dict.get("strategy_sl_value")
        if new_target == "STRATEGY_LTP" and new_strat_sl_val is None:
            new_strat_sl_val = new_idx_sl

        cursor.execute("""
            UPDATE strategies
            SET index_sl_price = ?, index_sl_condition = ?, index_sl_mode = ?, candle_interval = ?,
                sl_target_type = ?, strategy_sl_value = ?
            WHERE id = ?
        """, (new_idx_sl, new_cond, new_mode, new_interval, new_target, new_strat_sl_val, strategy_id))

        cursor.execute("""
            INSERT INTO activity_logs (user_id, strategy_id, log_level, message, details)
            VALUES (?, ?, 'INFO', ?, ?)
        """, (
            user["id"],
            strategy_id,
            f"SL settings updated for strategy #{strategy_id} ({strat_dict['name']})",
            json.dumps({
                "sl_target_type": new_target,
                "strategy_sl_value": new_strat_sl_val,
                "index_sl_price": new_idx_sl,
                "index_sl_condition": new_cond,
                "index_sl_mode": new_mode,
                "candle_interval": new_interval
            })
        ))
        conn.commit()

    # Immediately reload in-memory cache and reinitialize candle state if needed
    market_engine.reload_active_strategies()
    logger.info(f"Updated SL settings for strategy #{strategy_id}: Target={new_target}, StratSL={new_strat_sl_val}, IdxSL={new_idx_sl}, mode={new_mode}, interval={new_interval}m")

    return {
        "status": "success",
        "message": f"Stop loss settings updated for {strat_dict['name']}",
        "strategy_id": strategy_id,
        "sl_target_type": new_target,
        "strategy_sl_value": new_strat_sl_val,
        "index_sl_price": new_idx_sl,
        "index_sl_condition": new_cond,
        "index_sl_mode": new_mode,
        "candle_interval": new_interval
    }

@app.post("/api/strategies/{strategy_id}/close")
def emergency_close_strategy(strategy_id: int, user: dict = Depends(get_current_user)):
    """Manually square off an active strategy immediately on Kotak Neo"""
    manager = KotakNeoManager.get_instance(user["id"])
    if not manager.is_connected:
        raise HTTPException(status_code=403, detail="Kotak Neo login required")

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM strategies WHERE id = ? AND user_id = ?", (strategy_id, user["id"]))
        strat = cursor.fetchone()
        if not strat:
            raise HTTPException(status_code=404, detail="Strategy not found")
        if strat["status"] != "ACTIVE":
            raise HTTPException(status_code=400, detail="Strategy is not active")

        cursor.execute("SELECT * FROM strategy_legs WHERE strategy_id = ?", (strategy_id,))
        legs = cursor.fetchall()

    # Square off by reversing actions (BUY legs become SELL, SELL legs become BUY)
    # Manual square off MUST execute as MARKET (MKT) orders for guaranteed immediate fill
    exit_legs = []
    for leg in legs:
        exit_action = "BUY" if leg["action"].upper().startswith("S") else "SELL"
        token_val = str(leg["instrument_token"] or "").strip()
        exit_legs.append({
            "leg_id": leg["id"],
            "trading_symbol": leg["trading_symbol"],
            "token": token_val,
            "action": exit_action,
            "quantity": leg["quantity"],
            "price": 0.0,
            "entry_price": leg["entry_price"] or 0.0,
            "order_type": "MKT",
            "product": "NRML",
            "exchange_segment": "nse_fo"
        })

    # Execute square-off with BUY (cover shorts) first
    results = manager.execute_multi_leg_strategy(exit_legs, is_exit=True, strategy_id=strategy_id)

    any_success = any(r.get("status") == "success" for r in results)
    all_success = all(r.get("status") == "success" for r in results)

    # Mark as CLOSED in database and record exit prices & realized PnL
    now_iso = datetime.now().isoformat()
    total_realized_pnl = 0.0
    with get_db() as conn:
        cursor = conn.cursor()
        for leg in legs:
            token_val = str(leg["instrument_token"] or "").strip()
            cur_p = market_engine.get_option_price(leg["trading_symbol"], leg["strike"], leg["option_type"], token_val)
            en_p = float(leg["entry_price"] or 0.0)
            qty = abs(int(leg["quantity"] or 0))
            is_buy = str(leg["action"] or "").upper().startswith("B")
            if cur_p > 0 and en_p > 0:
                total_realized_pnl += ((cur_p - en_p) * qty if is_buy else (en_p - cur_p) * qty)
            cursor.execute("""
                UPDATE strategy_legs 
                SET exit_price = ?, status = 'CLOSED' 
                WHERE id = ?
            """, (cur_p, leg["id"]))

        if all_success:
            cursor.execute("""
                UPDATE strategies 
                SET status = 'CLOSED', closed_at = ?, close_reason = 'Manual Square-Off', realized_pnl = ? 
                WHERE id = ?
            """, (now_iso, round(total_realized_pnl, 2), strategy_id))
        elif any_success:
            cursor.execute("""
                UPDATE strategies 
                SET close_reason = 'Partial Square-Off', realized_pnl = ? 
                WHERE id = ?
            """, (round(total_realized_pnl, 2), strategy_id))
        conn.commit()

    try:
        manager.sync_strategy_fill_prices(strategy_id)
    except Exception as e:
        logger.warning(f"Could not immediately sync exit fill prices: {e}")

    market_engine.reload_active_strategies()

    if not any_success:
        first_err = results[0].get("message") if len(results) > 0 else "Broker rejected exit order"
        raise HTTPException(status_code=400, detail=f"Square-off failed on Kotak: {first_err}")

    return {
        "status": "success",
        "message": "Strategy squared off successfully on Kotak Neo" if all_success else "Partial square-off executed on Kotak",
        "results": results
    }

@app.delete("/api/strategies/{strategy_id}")
def delete_strategy(strategy_id: int, user: dict = Depends(get_current_user)):
    """
    Permanently deletes a strategy and its legs from the database and active memory.
    Used for failed/stuck strategies or manual clearance.
    """
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM strategies WHERE id = ? AND user_id = ?", (strategy_id, user["id"]))
        strat = cursor.fetchone()
        if not strat:
            raise HTTPException(status_code=404, detail="Strategy not found")
        
        strat_name = strat["name"]
        cursor.execute("DELETE FROM strategy_legs WHERE strategy_id = ?", (strategy_id,))
        cursor.execute("DELETE FROM strategies WHERE id = ? AND user_id = ?", (strategy_id, user["id"]))
        
        cursor.execute("""
            INSERT INTO activity_logs (user_id, strategy_id, log_level, message, details)
            VALUES (?, ?, 'WARNING', ?, ?)
        """, (
            user["id"],
            strategy_id,
            f"Strategy #{strategy_id} ('{strat_name}') permanently deleted.",
            json.dumps({"deleted_at": datetime.now().isoformat(), "strategy_id": strategy_id, "name": strat_name})
        ))
        conn.commit()

    # Remove from active engine memory if currently active
    market_engine.active_strategies.pop(strategy_id, None)
    market_engine.reload_active_strategies()
    logger.info(f"Strategy #{strategy_id} permanently deleted by user {user['id']}")

    return {
        "status": "success",
        "message": f"Strategy #{strategy_id} ('{strat_name}') deleted successfully."
    }

# --- System Health & Live Resources Endpoint ---

@app.get("/api/system/health")
def get_server_health(user: dict = Depends(get_current_user)):
    """Returns live server resource metrics (CPU, RAM, Disk, Process, Uptime, IST time)"""
    from backend.system_monitor import get_system_health
    return get_system_health(ws_clients_count=len(market_engine.active_connections))

@app.post("/api/system/restart-service")
async def restart_service(user: dict = Depends(get_current_user)):
    """Restarts the neotrader systemd service on Linux host"""
    import subprocess
    import platform
    logger.warning(f"User '{user['username']}' requested service restart")

    async def _do_restart():
        await asyncio.sleep(0.8)
        try:
            if platform.system() == "Linux":
                subprocess.Popen(["sudo", "systemctl", "restart", "neotrader.service"])
            else:
                logger.info("Restart service requested in dev environment.")
        except Exception as e:
            logger.error(f"Failed to restart service: {e}")

    asyncio.create_task(_do_restart())
    return {
        "status": "success",
        "action": "RESTART_SERVICE",
        "message": "Service restart initiated. The system will reconnect in a few seconds."
    }

@app.post("/api/system/reboot")
async def reboot_server(user: dict = Depends(get_current_user)):
    """Reboots the entire virtual machine host"""
    import subprocess
    import platform
    logger.critical(f"User '{user['username']}' requested complete server reboot")

    async def _do_reboot():
        await asyncio.sleep(0.8)
        try:
            if platform.system() == "Linux":
                subprocess.Popen(["sudo", "reboot"])
            else:
                logger.info("Server reboot requested in dev environment.")
        except Exception as e:
            logger.error(f"Failed to trigger reboot: {e}")

    asyncio.create_task(_do_reboot())
    return {
        "status": "success",
        "action": "REBOOT_SERVER",
        "message": "Server reboot initiated. The VM will reboot and reconnect in about 30–45 seconds."
    }


# --- WebSocket Endpoint for Live Streaming to Front-end ---

@app.websocket("/ws/market")
async def websocket_market_feed(websocket: WebSocket, token: Optional[str] = Query(None)):
    # Validate session token if provided
    if token:
        user = verify_ws_token(token)
        if not user:
            await websocket.close(code=4001, reason="Invalid or expired session")
            return

    await market_engine.connect_client(websocket)
    try:
        while True:
            raw_msg = await websocket.receive_text()
            if raw_msg:
                try:
                    parsed = json.loads(raw_msg)
                    msg_type = parsed.get("type")
                    if msg_type in ["WATCH_LEGS", "SUBSCRIBE_LEGS"]:
                        legs_list = parsed.get("legs") or []
                        market_engine.set_client_watch_legs(websocket, legs_list)
                except Exception as parse_err:
                    logger.debug(f"WS client message parse error: {parse_err}")
    except WebSocketDisconnect:
        market_engine.disconnect_client(websocket)
    except Exception:
        market_engine.disconnect_client(websocket)

# Serve Frontend static assets with SPA fallback
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"
if FRONTEND_DIST.exists():
    from starlette.responses import FileResponse
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        if full_path.startswith("api") or full_path.startswith("ws"):
            raise HTTPException(status_code=404, detail="API endpoint not found")
        file_path = FRONTEND_DIST / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        index_file = FRONTEND_DIST / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        raise HTTPException(status_code=404, detail="Index file not found")
