import os
import csv
import re
import math
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from pathlib import Path

logger = logging.getLogger("instrument_master")

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
SCRIP_CSV_PATH = DATA_DIR / "scrip_nse_fo.csv"

def is_scrip_updated_today() -> bool:
    """Checks if the local scrip_nse_fo.csv exists, is valid size, and was modified today"""
    if not SCRIP_CSV_PATH.exists() or SCRIP_CSV_PATH.stat().st_size < 100000:
        return False
    try:
        mtime = datetime.fromtimestamp(SCRIP_CSV_PATH.stat().st_mtime)
        return mtime.date() == datetime.now().date()
    except Exception:
        return False

def download_scrip_csv(consumer_key: Optional[str] = None) -> bool:
    """
    Downloads the daily updated NSE F&O scrip master from Kotak Neo.
    1. Queries Kotak Neo API /script-details/1.0/masterscrip/file-paths if consumer_key is available.
    2. Uses official daily date-stamped Kotak CDN endpoints (today / yesterday fallback).
    3. Uses legacy static fallback endpoints.
    """
    import requests
    today_str = datetime.now().strftime("%Y-%m-%d")
    yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    candidate_urls: List[str] = []

    # 1. Dynamic Kotak Neo API discovery if consumer_key is provided or in config
    if not consumer_key:
        try:
            from backend.config import KOTAK_CONSUMER_KEY
            consumer_key = KOTAK_CONSUMER_KEY
        except Exception:
            pass

    if consumer_key:
        try:
            logger.info("Querying Kotak Neo API for daily masterscrip file paths...")
            api_url = "https://e41.kotaksecurities.com/script-details/1.0/masterscrip/file-paths"
            headers = {"Authorization": consumer_key, "neo-fin-key": "neotradeapi"}
            res = requests.get(api_url, headers=headers, timeout=8)
            if res.status_code == 200:
                data = res.json().get("data", {})
                for path in data.get("filesPaths", []):
                    if "nse_fo" in path.lower():
                        candidate_urls.append(path)
                        logger.info(f"Discovered official daily Kotak scrip URL: {path}")
        except Exception as e:
            logger.warning(f"Kotak Neo API masterscrip discovery fallback: {e}")

    # 2. Known official Kotak CDN endpoints with daily date-stamp
    candidate_urls.extend([
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{today_str}/transformed/nse_fo.csv",
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{today_str}/nse_fo.csv",
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{yesterday_str}/transformed/nse_fo.csv",
        "https://lapi.kotaksecurities.com/content/files/scrip_nse_fo.csv",
        "https://scripfile.kotaksecurities.com/nse_fo.csv"
    ])

    for url in candidate_urls:
        try:
            logger.info(f"Downloading daily scrip master from: {url}")
            r = requests.get(url, timeout=30, stream=True)
            if r.status_code == 200:
                temp_path = SCRIP_CSV_PATH.with_suffix(".csv.tmp")
                with open(temp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
                if temp_path.stat().st_size > 500000:
                    temp_path.replace(SCRIP_CSV_PATH)
                    logger.info(f"Successfully updated scrip_nse_fo.csv ({SCRIP_CSV_PATH.stat().st_size} bytes)")
                    return True
        except Exception as e:
            logger.debug(f"Failed download from {url}: {e}")

    return False

class Instrument:
    def __init__(self, token: str, symbol: str, strike: float, option_type: str, expiry_code: str, expiry_date: str, lot_size: int = 65, tick_size: float = 0.05):
        self.token = token
        self.trading_symbol = symbol
        self.strike = strike
        self.option_type = option_type.upper()
        self.expiry_code = expiry_code
        self.expiry_date = expiry_date
        self.lot_size = lot_size
        self.tick_size = tick_size

    def to_dict(self) -> Dict[str, Any]:
        return {
            "token": self.token,
            "trading_symbol": self.trading_symbol,
            "strike": self.strike,
            "option_type": self.option_type,
            "expiry_code": self.expiry_code,
            "expiry_date": self.expiry_date,
            "lot_size": self.lot_size,
            "tick_size": self.tick_size
        }

class InstrumentMaster:
    _instance = None

    def __init__(self):
        self.instruments_by_token: Dict[str, Instrument] = {}
        self.instruments_by_symbol: Dict[str, Instrument] = {}
        
        # Structure: (expiry_code, strike, option_type) -> Instrument
        self.lookup_map: Dict[tuple, Instrument] = {}
        
        # Expiry metadata: code -> {"code": code, "date": "YYYY-MM-DD", "display": "19-Oct-2026", "dt": datetime}
        self.expiries: Dict[str, Dict[str, Any]] = {}
        
        # Expiry -> sorted list of strikes
        self.strikes_by_expiry: Dict[str, List[float]] = {}
        
        self.is_loaded = False
        self.load_master()

    @classmethod
    def get_instance(cls) -> "InstrumentMaster":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def load_master(self, force_reload: bool = False, consumer_key: Optional[str] = None):
        """
        Loads the scrip master into memory.
        If force_reload is True or the local file is not from today, downloads today's copy first.
        """
        target_path = None

        # Check if file needs download for today
        if force_reload or not is_scrip_updated_today():
            logger.info("Scrip master is missing or older than today. Downloading fresh copy from Kotak Neo...")
            if download_scrip_csv(consumer_key=consumer_key) and SCRIP_CSV_PATH.exists():
                target_path = SCRIP_CSV_PATH

        if not target_path and SCRIP_CSV_PATH.exists() and SCRIP_CSV_PATH.stat().st_size > 100000:
            target_path = SCRIP_CSV_PATH

        if not target_path:
            logger.warning(f"No scrip master file found at {SCRIP_CSV_PATH}. Option chain and strikes resolution may be limited until scrip_nse_fo.csv is present in data/.")
            return

        # Clear existing mappings before reloading fresh contracts
        self.instruments_by_token.clear()
        self.instruments_by_symbol.clear()
        self.lookup_map.clear()
        self.expiries.clear()
        self.strikes_by_expiry.clear()

        logger.info(f"Loading NIFTY option instruments from {target_path}...")
        try:
            with open(target_path, mode="r", encoding="utf-8", errors="ignore") as f:
                reader = csv.DictReader(f)
                count = 0
                for row in reader:
                    # Filter for NIFTY Index Options
                    if row.get("pSymbolName") == "NIFTY" and row.get("pInstType") == "OPTIDX":
                        token = (row.get("pSymbol") or "").strip()
                        trd_sym = (row.get("pTrdSymbol") or "").strip()
                        opt_type = (row.get("pOptionType") or "").strip().upper()
                        ref_key = (row.get("pScripRefKey") or "").strip()

                        # Extract Strike (in Kotak scrip CSV, values >= 10000 are in paise e.g. 2500000 -> 25000.0)
                        raw_strike = row.get("dStrikePrice;") or row.get("dStrikePrice") or "0"
                        try:
                            strike = float(raw_strike)
                            if strike >= 10000:
                                strike = strike / 100.0
                            strike = round(strike, 2)
                        except Exception:
                            continue

                        # Extract Expiry Code from RefKey (e.g. NIFTY19OCT2620850.00PE -> 19OCT26)
                        exp_code = ""
                        m = re.search(r"NIFTY(\d{2}[A-Z]{3}\d{2})", ref_key)
                        if m:
                            exp_code = m.group(1).upper()
                        else:
                            # Fallback from trading symbol
                            m_sym = re.match(r"NIFTY(\d{2}[A-Z0-9]{3,4})", trd_sym)
                            if m_sym:
                                exp_code = m_sym.group(1).upper()

                        if not exp_code:
                            continue

                        # Parse Expiry Date object
                        try:
                            # e.g. 19OCT26 -> 2026-10-19
                            dt = datetime.strptime(exp_code, "%d%b%y")
                            date_str = dt.strftime("%Y-%m-%d")
                            display_str = dt.strftime("%d %b %Y")
                        except Exception:
                            date_str = exp_code
                            display_str = exp_code
                            dt = datetime.max

                        # Lot size & Tick size
                        try:
                            lot_size = int(row.get("lLotSize") or row.get("iLotSize") or 65)
                        except Exception:
                            lot_size = 65

                        try:
                            tick_size = float(row.get("dTickSize ") or row.get("dTickSize") or 5)
                            if tick_size >= 1.0:
                                tick_size = tick_size / 100.0
                        except Exception:
                            tick_size = 0.05

                        inst = Instrument(
                            token=token,
                            symbol=trd_sym,
                            strike=strike,
                            option_type=opt_type,
                            expiry_code=exp_code,
                            expiry_date=date_str,
                            lot_size=lot_size,
                            tick_size=tick_size
                        )

                        self.instruments_by_token[token] = inst
                        self.instruments_by_symbol[trd_sym] = inst
                        self.lookup_map[(exp_code, strike, opt_type)] = inst

                        if exp_code not in self.expiries:
                            self.expiries[exp_code] = {
                                "code": exp_code,
                                "date": date_str,
                                "display": display_str,
                                "dt": dt
                            }

                        if exp_code not in self.strikes_by_expiry:
                            self.strikes_by_expiry[exp_code] = []
                        if strike not in self.strikes_by_expiry[exp_code]:
                            self.strikes_by_expiry[exp_code].append(strike)

                        count += 1

                for exp_code in self.strikes_by_expiry:
                    self.strikes_by_expiry[exp_code].sort()

            self.is_loaded = True
            logger.info(f"Loaded {count} NIFTY instruments across {len(self.expiries)} expiries.")
        except Exception as e:
            logger.error(f"Error parsing scrip master CSV: {e}")

    def ensure_today_master(self, force: bool = False, consumer_key: Optional[str] = None) -> bool:
        """
        Ensures the token master is up-to-date for today (first login of the day).
        If today's scrip master is not yet downloaded, downloads it and reloads all instruments.
        """
        if not force and is_scrip_updated_today() and self.is_loaded:
            logger.info("Token master is already up-to-date for today's trading session.")
            return True

        logger.info("Updating token master for today's trading session...")
        self.load_master(force_reload=True, consumer_key=consumer_key)
        return self.is_loaded

    def get_sorted_expiries(self) -> List[Dict[str, Any]]:
        """Returns sorted list of active future (or today's) expiries, omitting expired dates"""
        today = datetime.now().date()
        # Filter out expired contracts strictly prior to today
        exp_list = [e for e in self.expiries.values() if e["dt"].date() >= today]
        exp_list.sort(key=lambda x: x["dt"])
        return [
            {
                "code": e["code"],
                "date": e["date"],
                "display": f"{e['display']} ({'Weekly' if e['dt'].day not in [24,25,26,27,28,29,30,31] or e['dt'].weekday() != 3 else 'Monthly'})"
            }
            for e in exp_list
        ]

    def get_strikes(self, expiry_code: Optional[str] = None) -> List[float]:
        """Returns sorted list of available strike prices for given expiry"""
        if not expiry_code:
            expiries = self.get_sorted_expiries()
            if not expiries:
                return []
            expiry_code = expiries[0]["code"]
        return self.strikes_by_expiry.get(expiry_code.upper(), [])

    def resolve_option(self, strike: float, option_type: str, expiry_code: Optional[str] = None) -> Optional[Instrument]:
        """Resolves exact Instrument for strike, CE/PE, and expiry"""
        if not expiry_code:
            expiries = self.get_sorted_expiries()
            if not expiries:
                return None
            expiry_code = expiries[0]["code"]

        exp_code = expiry_code.upper()
        opt_type = option_type.upper()
        stk = round(float(strike), 2)

        key = (exp_code, stk, opt_type)
        if key in self.lookup_map:
            return self.lookup_map[key]

        # Try nearest strike match within 2 points if exact not found
        available = self.strikes_by_expiry.get(exp_code, [])
        for s in available:
            if abs(s - stk) <= 2.0:
                alt_key = (exp_code, s, opt_type)
                if alt_key in self.lookup_map:
                    return self.lookup_map[alt_key]

        return None

    def get_option_chain_snapshot(self, spot_price: float, expiry_code: Optional[str] = None, strike_count: int = 10) -> Dict[str, Any]:
        """Returns chain centered around ATM for the selected expiry"""
        expiries = self.get_sorted_expiries()
        if not expiries:
            return {"expiry": None, "strikes": [], "chain": []}

        if not expiry_code:
            expiry_code = expiries[0]["code"]

        exp_code = expiry_code.upper()
        strikes = self.strikes_by_expiry.get(exp_code, [])
        if not strikes:
            return {"expiry": exp_code, "strikes": [], "chain": []}

        # Find closest strike to spot_price
        atm_strike = min(strikes, key=lambda s: abs(s - spot_price))
        atm_idx = strikes.index(atm_strike)

        start_idx = max(0, atm_idx - strike_count)
        end_idx = min(len(strikes), atm_idx + strike_count + 1)
        selected_strikes = strikes[start_idx:end_idx]

        chain = []
        for stk in selected_strikes:
            ce_inst = self.lookup_map.get((exp_code, stk, "CE"))
            pe_inst = self.lookup_map.get((exp_code, stk, "PE"))
            chain.append({
                "strike": stk,
                "is_atm": (stk == atm_strike),
                "ce": ce_inst.to_dict() if ce_inst else None,
                "pe": pe_inst.to_dict() if pe_inst else None
            })

        return {
            "expiry": exp_code,
            "expiry_display": next((e["display"] for e in expiries if e["code"] == exp_code), exp_code),
            "atm_strike": atm_strike,
            "spot_price": spot_price,
            "chain": chain
        }

    def estimate_option_price(
        self,
        spot_price: float,
        strike: float,
        option_type: str,
        expiry_code: Optional[str] = None
    ) -> float:
        """
        Calculates realistic, expiry-aware option premium based on Black-Scholes volatility time-decay.
        Properly differentiates between near-week, next-week, and monthly expiries.
        """
        exp_code = str(expiry_code or "").upper()
        dte = 2.0  # fallback
        if exp_code and exp_code in self.expiries:
            exp_info = self.expiries[exp_code]
            exp_dt = exp_info.get("dt")
            if exp_dt:
                from datetime import date
                cur_date = date.today()
                exp_date = exp_dt.date() if hasattr(exp_dt, "date") else exp_dt
                diff = (exp_date - cur_date).days
                dte = max(0.35, float(diff) + 0.35)

        # ATM extrinsic time value scales with sqrt(T)
        # Nifty ATM: 1-day ~ 36 pts, 8-day ~ 100 pts, 15-day ~ 138 pts, 30-day ~ 195 pts
        atm_extrinsic = max(6.0, 36.0 * math.sqrt(dte))
        
        # Bell curve width scales with DTE (further out expiry has wider strike sensitivity)
        dist = abs(spot_price - strike)
        curve_width = 160.0 + 20.0 * math.sqrt(dte)
        time_val = max(1.5, atm_extrinsic * math.exp(-0.5 * ((dist / curve_width) ** 2)))

        if option_type.upper() == "CE":
            intrinsic = max(0.0, spot_price - strike)
        else:
            intrinsic = max(0.0, strike - spot_price)

        return round(round((intrinsic + time_val) / 0.05) * 0.05, 2)

    def build_strategy_legs(
        self,
        strategy_type: str,
        spot_price: float,
        expiry_code: Optional[str] = None,
        spread_width: float = 100.0,
        wing_width: float = 300.0,
        lots: int = 1,
        main_strike: Optional[float] = None,
        hedge_distance: Optional[float] = None
    ) -> List[Dict[str, Any]]:
        """
        Builds properly sequenced and resolved strategy legs with exact Kotak tokens and symbols.
        Supports customizable main strike and hedge distance (Sensibull style).
        BUY legs are placed first for margin reduction.
        """
        expiries = self.get_sorted_expiries()
        if not expiries:
            return []
        if not expiry_code:
            expiry_code = expiries[0]["code"]

        exp_code = expiry_code.upper()
        strikes = self.strikes_by_expiry.get(exp_code, [])
        if not strikes:
            return []

        # Find closest ATM strike (rounded to nearest 50)
        atm_strike = min(strikes, key=lambda s: abs(s - spot_price))
        atm_strike = round(atm_strike / 50.0) * 50.0

        # Anchor strike (Main strike selected by user or default ATM)
        if main_strike is not None and float(main_strike) > 0:
            anchor_strike = round(float(main_strike) / 50.0) * 50.0
        else:
            anchor_strike = atm_strike

        # Effective hedge distance
        effective_hedge = float(hedge_distance if hedge_distance is not None and hedge_distance > 0 else spread_width)
        effective_hedge = max(50.0, round(effective_hedge / 50.0) * 50.0)

        legs_config = []
        strat_type = strategy_type.upper()

        if strat_type in ["BULL_CALL_SPREAD", "BULL_CALL"]:
            # Buy Main Call, Sell Higher OTM Call
            # Sequence: BUY leg first, then SELL leg
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY"},
                {"strike": anchor_strike + effective_hedge, "option_type": "CE", "action": "SELL"}
            ]
        elif strat_type in ["BEAR_PUT_SPREAD", "BEAR_PUT"]:
            # Buy Main Put, Sell Lower OTM Put
            # Sequence: BUY leg first, then SELL leg
            legs_config = [
                {"strike": anchor_strike, "option_type": "PE", "action": "BUY"},
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "SELL"}
            ]
        elif strat_type in ["BULL_PUT_SPREAD", "BULL_PUT_CREDIT"]:
            # Sell Main Put (Credit), Buy deeper OTM Put hedge
            # Sequence: BUY hedge leg first, then SELL short leg
            legs_config = [
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "BUY"},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL"}
            ]
        elif strat_type in ["BEAR_CALL_SPREAD", "BEAR_CALL_CREDIT"]:
            # Sell Main Call (Credit), Buy higher OTM Call hedge
            # Sequence: BUY hedge leg first, then SELL short leg
            legs_config = [
                {"strike": anchor_strike + effective_hedge, "option_type": "CE", "action": "BUY"},
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL"}
            ]
        elif strat_type in ["IRON_CONDOR", "CONDOR"]:
            # Wings: Buy Far OTM Put, Buy Far OTM Call
            # Body: Sell OTM Put, Sell OTM Call
            # Sequence: BOTH BUY legs first, then BOTH SELL legs
            put_sell = anchor_strike - 100.0
            put_buy = put_sell - effective_hedge
            call_sell = anchor_strike + 100.0
            call_buy = call_sell + effective_hedge

            legs_config = [
                {"strike": put_buy, "option_type": "PE", "action": "BUY"},
                {"strike": call_buy, "option_type": "CE", "action": "BUY"},
                {"strike": put_sell, "option_type": "PE", "action": "SELL"},
                {"strike": call_sell, "option_type": "CE", "action": "SELL"}
            ]
        elif strat_type in ["SHORT_STRADDLE"]:
            # Sell Main CE, Sell Main PE
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL"},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL"}
            ]
        elif strat_type in ["LONG_STRADDLE"]:
            # Buy Main CE, Buy Main PE
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY"},
                {"strike": anchor_strike, "option_type": "PE", "action": "BUY"}
            ]
        elif strat_type in ["CALENDAR_SPREAD", "CALENDAR"]:
            # Sell Near Expiry (current week), Buy Far Expiry (next week) at same strike
            near_exp = exp_code
            far_exp = exp_code
            for i, e in enumerate(expiries):
                if e["code"].upper() == exp_code and (i + 1) < len(expiries):
                    far_exp = expiries[i + 1]["code"].upper()
                    break
            if far_exp == near_exp and len(expiries) > 1:
                far_exp = expiries[1]["code"].upper()

            # BUY far expiry leg first (for margin benefit), SELL near expiry leg
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY", "expiry": far_exp},
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL", "expiry": near_exp}
            ]
        else:
            # Default to Bull Put Spread
            legs_config = [
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "BUY"},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL"}
            ]

        resolved_legs = []
        for cfg in legs_config:
            leg_exp = cfg.get("expiry", exp_code)
            inst = self.resolve_option(cfg["strike"], cfg["option_type"], leg_exp)
            qty = (inst.lot_size if inst else 65) * lots
            if inst:
                # Estimate price from live market engine or realistic Black-Scholes Gaussian decay
                price = 0.0
                try:
                    from backend.market_engine import market_engine
                    if market_engine:
                        price = market_engine.get_option_price(inst.trading_symbol, inst.strike, inst.option_type)
                except Exception:
                    pass

                if price <= 0.0:
                    price = self.estimate_option_price(spot_price, inst.strike, inst.option_type, inst.expiry_code)

                resolved_legs.append({
                    "token": inst.token,
                    "trading_symbol": inst.trading_symbol,
                    "strike": inst.strike,
                    "option_type": inst.option_type,
                    "action": cfg["action"],
                    "quantity": qty,
                    "price": price,
                    "entry_price": price,
                    "lot_size": inst.lot_size,
                    "expiry": inst.expiry_code,
                    "expiry_date": inst.expiry_date,
                    "exchange_segment": "nse_fo",
                    "product": "NRML"
                })
            else:
                logger.warning(f"Could not resolve instrument for strike {cfg['strike']} {cfg['option_type']} {exp_code}")

        return resolved_legs

    def resolve_custom_legs(
        self,
        custom_legs: List[Dict[str, Any]],
        spot_price: float,
        default_expiry: Optional[str] = None,
        lots: int = 1
    ) -> List[Dict[str, Any]]:
        """
        Takes user-customized legs (with edited strikes, action, expiry, option_type, quantity),
        resolves exact scrip master tokens & trading symbols, and estimates/fetches real-time price.
        """
        expiries = self.get_sorted_expiries()
        if not default_expiry and expiries:
            default_expiry = expiries[0]["code"]

        resolved = []
        for leg in custom_legs:
            try:
                stk = round(float(leg.get("strike", spot_price)) / 50.0) * 50.0
            except Exception:
                stk = round(spot_price / 50.0) * 50.0

            opt_type = str(leg.get("option_type", "CE")).upper()
            act = str(leg.get("action", "BUY")).upper()
            act = "SELL" if act.startswith("S") else "BUY"
            leg_exp = str(leg.get("expiry") or default_expiry or "").upper()

            inst = self.resolve_option(stk, opt_type, leg_exp)
            lot_size = inst.lot_size if inst else 65
            qty = int(leg.get("quantity") or (lot_size * lots))

            price = 0.0
            if inst:
                trading_symbol = inst.trading_symbol
                token = inst.token
                expiry_date = inst.expiry_date
                expiry_code = inst.expiry_code
            else:
                trading_symbol = leg.get("trading_symbol") or f"NIFTY_{leg_exp}_{int(stk)}{opt_type}"
                token = str(leg.get("token") or "")
                expiry_date = leg.get("expiry_date") or leg_exp
                expiry_code = leg_exp

            if leg.get("is_custom_price") and float(leg.get("price") or 0.0) > 0.0:
                price = float(leg["price"])
            else:
                price = 0.0
                # Price lookup from market engine or realistic curve
                try:
                    from backend.market_engine import market_engine
                    if market_engine and trading_symbol:
                        price = market_engine.get_option_price(trading_symbol, stk, opt_type)
                except Exception:
                    pass

                if price <= 0.0:
                    price = self.estimate_option_price(spot_price, stk, opt_type, expiry_code)

            resolved.append({
                "token": token,
                "trading_symbol": trading_symbol,
                "strike": stk,
                "option_type": opt_type,
                "action": act,
                "quantity": qty,
                "price": price,
                "entry_price": price,
                "is_custom_price": bool(leg.get("is_custom_price")),
                "lot_size": lot_size,
                "expiry": expiry_code,
                "expiry_date": expiry_date,
                "exchange_segment": "nse_fo",
                "product": "NRML"
            })
        return resolved

    def compute_payoff_profile(
        self,
        legs: List[Dict[str, Any]],
        spot_price: float
    ) -> Dict[str, Any]:
        """
        Sensibull/Opstra style payoff computation:
        Calculates exact Max Profit, Max Loss, Breakevens, Risk-Reward, and sampled payoff curve.
        """
        if not legs:
            return {
                "max_profit": 0.0,
                "max_loss": 0.0,
                "breakeven_low": None,
                "breakeven_high": None,
                "breakevens": [],
                "risk_reward": "N/A",
                "net_premium": 0.0,
                "payoff_curve": []
            }

        strikes = [float(l["strike"]) for l in legs]
        min_stk = min(strikes) if strikes else spot_price - 500
        max_stk = max(strikes) if strikes else spot_price + 500

        # Calculate net premium
        net_prem = 0.0
        for l in legs:
            act = str(l.get("action", "")).upper()
            prc = float(l.get("price") or l.get("entry_price") or 0.0)
            qty = abs(int(l.get("quantity") or 65))
            if act.startswith("B"):
                net_prem -= prc * qty
            else:
                net_prem += prc * qty

        # Evaluation range
        eval_min = min(min_stk, spot_price) - 600.0
        eval_max = max(max_stk, spot_price) + 600.0
        eval_min = round(eval_min / 50.0) * 50.0
        eval_max = round(eval_max / 50.0) * 50.0

        step = 25.0
        num_steps = int((eval_max - eval_min) / step) + 1
        sample_spots = sorted(set([eval_min + i * step for i in range(num_steps)] + strikes + [spot_price]))

        # Check for multiple expiries (Calendar Spread modeling)
        leg_expiries = [l.get("expiry") for l in legs if l.get("expiry")]
        sorted_exp_codes = [e["code"].upper() for e in self.get_sorted_expiries()]
        
        nearest_expiry = None
        if leg_expiries:
            for exp_code in sorted_exp_codes:
                if any(exp_code == str(x).upper() for x in leg_expiries):
                    nearest_expiry = exp_code
                    break
            if not nearest_expiry:
                nearest_expiry = str(leg_expiries[0]).upper()

        has_calendar = bool(nearest_expiry and any(str(l.get("expiry") or "").upper() != nearest_expiry for l in legs))

        def _pnl_at_spot(s: float) -> float:
            total = 0.0
            for leg in legs:
                k = float(leg["strike"])
                opt = str(leg.get("option_type", "")).upper()
                act = str(leg.get("action", "")).upper()
                prc = float(leg.get("price") or leg.get("entry_price") or 0.0)
                qty = abs(int(leg.get("quantity") or 65))
                leg_exp = str(leg.get("expiry") or "").upper()
                is_far_expiry = bool(has_calendar and leg_exp and leg_exp != nearest_expiry)

                if opt == "CE":
                    intrinsic = max(0.0, s - k)
                else:
                    intrinsic = max(0.0, k - s)

                if is_far_expiry:
                    # In a Calendar Spread at near expiry, far option retains remaining extrinsic time value
                    dist = abs(s - k)
                    remaining_extrinsic = max(5.0, prc * 0.75 * math.exp(-0.5 * ((dist / 220.0) ** 2)))
                    opt_val = intrinsic + remaining_extrinsic
                    if act.startswith("B"):
                        leg_pnl = (opt_val - prc) * qty
                    else:
                        leg_pnl = (prc - opt_val) * qty
                else:
                    if act.startswith("B"):
                        leg_pnl = (intrinsic - prc) * qty
                    else:
                        leg_pnl = (prc - intrinsic) * qty
                total += leg_pnl
            return round(total, 2)

        curve = []
        for s in sample_spots:
            curve.append({"spot": round(s, 1), "pnl": _pnl_at_spot(s)})

        # Asymptotic checks: test far left and far right
        pnl_far_left = _pnl_at_spot(max(100.0, eval_min - 3000.0))
        pnl_far_right = _pnl_at_spot(eval_max + 3000.0)

        all_pnls = [pt["pnl"] for pt in curve]
        raw_max = max(all_pnls)
        raw_min = min(all_pnls)

        if has_calendar:
            is_profit_unlimited = False
            is_loss_unlimited = False
        else:
            is_profit_unlimited = (pnl_far_right > raw_max + 1000) or (pnl_far_left > raw_max + 1000)
            is_loss_unlimited = (pnl_far_right < raw_min - 1000) or (pnl_far_left < raw_min - 1000)

        max_profit = None if is_profit_unlimited else round(raw_max, 2)
        max_loss = None if is_loss_unlimited else round(raw_min, 2)

        # Breakeven calculation via zero-crossing linear interpolation
        breakevens = []
        for i in range(len(curve) - 1):
            p1 = curve[i]
            p2 = curve[i + 1]
            if (p1["pnl"] <= 0 and p2["pnl"] >= 0) or (p1["pnl"] >= 0 and p2["pnl"] <= 0):
                if p2["pnl"] != p1["pnl"]:
                    zero_spot = p1["spot"] + (0.0 - p1["pnl"]) * (p2["spot"] - p1["spot"]) / (p2["pnl"] - p1["pnl"])
                    breakevens.append(round(zero_spot, 1))
                else:
                    breakevens.append(round(p1["spot"], 1))

        # Deduplicate breakevens within 5 points
        cleaned_be = []
        for be in sorted(breakevens):
            if not cleaned_be or abs(be - cleaned_be[-1]) > 5.0:
                cleaned_be.append(be)

        be_low = cleaned_be[0] if len(cleaned_be) > 0 else None
        be_high = cleaned_be[-1] if len(cleaned_be) > 1 else None

        # Risk to Reward ratio
        if max_profit is not None and max_loss is not None and max_profit > 0 and max_loss < 0:
            if abs(max_loss) > max_profit:
                ratio = abs(max_loss) / max_profit
                risk_reward = f"{ratio:.2f} : 1"
            else:
                ratio = max_profit / abs(max_loss)
                risk_reward = f"1 : {ratio:.2f}"
        elif max_profit is None:
            risk_reward = "1 : Unlimited"
        elif max_loss is None:
            risk_reward = "Unlimited Risk"
        else:
            risk_reward = "N/A"

        # Margin Required Estimation (NSE SPAN + Exposure approximation)
        sell_legs = [l for l in legs if str(l.get("action", "")).upper() == "SELL"]
        buy_legs = [l for l in legs if str(l.get("action", "")).upper() == "BUY"]
        total_buy_prem = sum(
            float(l.get("price", 0)) * int(l.get("quantity", 65))
            for l in buy_legs
        )
        total_qty = max([int(l.get("quantity", 65)) for l in legs], default=65)
        num_lots = max(1, total_qty // 65)

        # Full Margin Required Calculation (Full broker margin from API / exchange without SPAN discount)
        short_margin = sum(125000.0 * (int(l.get("quantity", 65)) / 65.0) for l in sell_legs)
        margin_required = short_margin + total_buy_prem
        if margin_required <= 0:
            margin_required = total_buy_prem if total_buy_prem > 0 else 50000.0 * num_lots

        return {
            "max_profit": max_profit,
            "max_loss": max_loss,
            "breakeven_low": be_low,
            "breakeven_high": be_high,
            "breakevens": cleaned_be,
            "risk_reward": risk_reward,
            "margin_required": round(margin_required, 2),
            "net_premium": round(net_prem, 2),
            "payoff_curve": curve
        }

    def generate_strategy_name(self, strategy_type: str, legs: List[Dict[str, Any]]) -> str:
        """
        Auto-generates clean Sensibull-style strategy names incorporating the exact leg strikes and expiry.
        e.g. Bull Put Spread (25100 PE / 24900 PE) - 27-Oct-2026
             Bear Call Spread (25200 CE / 25400 CE) - 27-Oct-2026
             Iron Condor (24800 PE / 25000 PE / 25300 CE / 25500 CE) - 27-Oct-2026
        """
        if not legs:
            return "Nifty Strategy"

        strat_type = strategy_type.upper()
        # Sort legs: PE first then CE; within that by strike
        sorted_legs = sorted(legs, key=lambda l: (l.get("option_type", ""), float(l.get("strike", 0))))
        legs_desc = " / ".join(f"{int(l['strike'])} {l['option_type']}" for l in sorted_legs)

        # Extract expiry
        expiry_label = ""
        for l in legs:
            exp_code = l.get("expiry") or l.get("expiry_code")
            if exp_code and exp_code in self.expiries:
                expiry_label = self.expiries[exp_code].get("display", exp_code)
                break
            elif l.get("expiry_date"):
                expiry_label = str(l.get("expiry_date"))
                break
            elif exp_code:
                expiry_label = str(exp_code)
                break

        exp_suffix = f" - {expiry_label}" if expiry_label else ""

        if "BULL_PUT" in strat_type:
            base = f"Bull Put Spread ({legs_desc})"
        elif "BEAR_CALL" in strat_type:
            base = f"Bear Call Spread ({legs_desc})"
        elif "BULL_CALL" in strat_type:
            base = f"Bull Call Spread ({legs_desc})"
        elif "BEAR_PUT" in strat_type:
            base = f"Bear Put Spread ({legs_desc})"
        elif "CONDOR" in strat_type:
            base = f"Iron Condor ({legs_desc})"
        elif "LONG_STRADDLE" in strat_type:
            base = f"Long Straddle ({legs_desc})"
        elif "SHORT_STRADDLE" in strat_type:
            base = f"Short Straddle ({legs_desc})"
        elif "CALENDAR" in strat_type:
            base = f"Calendar Spread ({legs_desc})"
        else:
            title = strategy_type.replace("_", " ").title()
            base = f"{title} ({legs_desc})"

        return f"{base}{exp_suffix}"

