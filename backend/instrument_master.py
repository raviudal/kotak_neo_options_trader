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
SCRIP_NSE_PATH = DATA_DIR / "scrip_nse_fo.csv"
SCRIP_BSE_PATH = DATA_DIR / "scrip_bse_fo.csv"
SCRIP_CSV_PATH = SCRIP_NSE_PATH  # Backwards compatibility

def is_scrip_updated_today(segment: str = "nse_fo") -> bool:
    """Checks if the local scrip CSV file exists, is valid size, and was modified today"""
    target = SCRIP_BSE_PATH if segment == "bse_fo" else SCRIP_NSE_PATH
    if not target.exists() or target.stat().st_size < 100000:
        return False
    try:
        mtime = datetime.fromtimestamp(target.stat().st_mtime)
        return mtime.date() == datetime.now().date()
    except Exception:
        return False

def download_scrip_csv(consumer_key: Optional[str] = None, segment: str = "nse_fo") -> bool:
    """
    Downloads the daily updated F&O scrip master from Kotak Neo for NSE (nse_fo) or BSE (bse_fo).
    """
    import requests
    today_str = datetime.now().strftime("%Y-%m-%d")
    yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    target_path = SCRIP_BSE_PATH if segment == "bse_fo" else SCRIP_NSE_PATH

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
            logger.info(f"Querying Kotak Neo API for daily {segment} masterscrip file paths...")
            api_url = "https://e41.kotaksecurities.com/script-details/1.0/masterscrip/file-paths"
            headers = {"Authorization": consumer_key, "neo-fin-key": "neotradeapi"}
            res = requests.get(api_url, headers=headers, timeout=8)
            if res.status_code == 200:
                data = res.json().get("data", {})
                for path in data.get("filesPaths", []):
                    if segment in path.lower():
                        candidate_urls.append(path)
                        logger.info(f"Discovered official daily Kotak scrip URL for {segment}: {path}")
        except Exception as e:
            logger.warning(f"Kotak Neo API masterscrip discovery fallback for {segment}: {e}")

    # 2. Known official Kotak CDN endpoints with daily date-stamp
    candidate_urls.extend([
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{today_str}/transformed/{segment}.csv",
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{today_str}/{segment}.csv",
        f"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{yesterday_str}/transformed/{segment}.csv",
        f"https://lapi.kotaksecurities.com/content/files/scrip_{segment}.csv",
        f"https://scripfile.kotaksecurities.com/{segment}.csv"
    ])

    for url in candidate_urls:
        try:
            logger.info(f"Downloading daily {segment} scrip master from: {url}")
            r = requests.get(url, timeout=30, stream=True)
            if r.status_code == 200:
                temp_path = target_path.with_suffix(".csv.tmp")
                with open(temp_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
                if temp_path.stat().st_size > 500000:
                    temp_path.replace(target_path)
                    logger.info(f"Successfully updated {target_path.name} ({target_path.stat().st_size} bytes)")
                    return True
        except Exception as e:
            logger.debug(f"Failed download from {url}: {e}")

    return False

class Instrument:
    def __init__(self, token: str, symbol: str, strike: float, option_type: str, expiry_code: str, expiry_date: str, lot_size: int = 65, tick_size: float = 0.05, underlying: str = "NIFTY", exchange_segment: str = "nse_fo"):
        self.token = token
        self.trading_symbol = symbol
        self.strike = strike
        self.option_type = option_type.upper()
        self.expiry_code = expiry_code
        self.expiry_date = expiry_date
        self.lot_size = lot_size
        self.tick_size = tick_size
        self.underlying = underlying.upper()
        self.exchange_segment = exchange_segment

    def to_dict(self) -> Dict[str, Any]:
        return {
            "token": self.token,
            "trading_symbol": self.trading_symbol,
            "strike": self.strike,
            "option_type": self.option_type,
            "expiry_code": self.expiry_code,
            "expiry_date": self.expiry_date,
            "lot_size": self.lot_size,
            "tick_size": self.tick_size,
            "underlying": self.underlying,
            "exchange_segment": self.exchange_segment
        }

class InstrumentMaster:
    _instance = None

    def __init__(self):
        self.instruments_by_token: Dict[str, Instrument] = {}
        self.instruments_by_symbol: Dict[str, Instrument] = {}
        
        # Structure: (underlying, expiry_code, strike, option_type) -> Instrument
        # AND backwards compatible: (expiry_code, strike, option_type) -> Instrument
        self.lookup_map: Dict[tuple, Instrument] = {}
        
        # Partitioned by underlying: "NIFTY" and "SENSEX"
        self.expiries: Dict[str, Dict[str, Dict[str, Any]]] = {"NIFTY": {}, "SENSEX": {}}
        self.strikes_by_expiry: Dict[str, Dict[str, List[float]]] = {"NIFTY": {}, "SENSEX": {}}
        
        self.lot_sizes: Dict[str, int] = {"NIFTY": 65, "SENSEX": 20}
        self.strike_steps: Dict[str, float] = {"NIFTY": 50.0, "SENSEX": 100.0}
        self.default_hedges: Dict[str, float] = {"NIFTY": 100.0, "SENSEX": 200.0}
        
        self.is_loaded = False
        self.load_master()

    @classmethod
    def get_instance(cls) -> "InstrumentMaster":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _parse_nse_csv(self, file_path: Path):
        count = 0
        try:
            with open(file_path, mode="r", encoding="utf-8", errors="ignore") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get("pSymbolName") == "NIFTY" and row.get("pInstType") in ["OPTIDX", "IO"]:
                        token = (row.get("pSymbol") or "").strip()
                        trd_sym = (row.get("pTrdSymbol") or "").strip()
                        opt_type = (row.get("pOptionType") or "").strip().upper()
                        ref_key = (row.get("pScripRefKey") or "").strip()

                        raw_strike = row.get("dStrikePrice;") or row.get("dStrikePrice") or "0"
                        try:
                            strike = float(raw_strike)
                            if strike >= 10000:
                                strike = strike / 100.0
                            strike = round(strike, 2)
                        except Exception:
                            continue

                        exp_code = ""
                        m = re.search(r"NIFTY(\d{2}[A-Z]{3}\d{2})", ref_key)
                        if m:
                            exp_code = m.group(1).upper()
                        else:
                            m_sym = re.match(r"NIFTY(\d{2}[A-Z0-9]{3,4})", trd_sym)
                            if m_sym:
                                exp_code = m_sym.group(1).upper()

                        if not exp_code:
                            continue

                        try:
                            dt = datetime.strptime(exp_code, "%d%b%y")
                            date_str = dt.strftime("%Y-%m-%d")
                            display_str = dt.strftime("%d %b %Y")
                        except Exception:
                            date_str = exp_code
                            display_str = exp_code
                            dt = datetime.max

                        try:
                            lot_size = int(row.get("lLotSize") or row.get("iLotSize") or 65)
                        except Exception:
                            lot_size = 65

                        inst = Instrument(
                            token=token,
                            symbol=trd_sym,
                            strike=strike,
                            option_type=opt_type,
                            expiry_code=exp_code,
                            expiry_date=date_str,
                            lot_size=lot_size,
                            tick_size=0.05,
                            underlying="NIFTY",
                            exchange_segment="nse_fo"
                        )

                        self.instruments_by_token[token] = inst
                        self.instruments_by_symbol[trd_sym] = inst
                        self.lookup_map[("NIFTY", exp_code, strike, opt_type)] = inst
                        self.lookup_map[(exp_code, strike, opt_type)] = inst  # Backwards compatibility

                        if exp_code not in self.expiries["NIFTY"]:
                            self.expiries["NIFTY"][exp_code] = {
                                "code": exp_code,
                                "date": date_str,
                                "display": display_str,
                                "dt": dt
                            }

                        if exp_code not in self.strikes_by_expiry["NIFTY"]:
                            self.strikes_by_expiry["NIFTY"][exp_code] = []
                        if strike not in self.strikes_by_expiry["NIFTY"][exp_code]:
                            self.strikes_by_expiry["NIFTY"][exp_code].append(strike)

                        count += 1

                for exp_code in self.strikes_by_expiry["NIFTY"]:
                    self.strikes_by_expiry["NIFTY"][exp_code].sort()

            logger.info(f"Loaded {count} NIFTY instruments across {len(self.expiries['NIFTY'])} expiries from NSE.")
        except Exception as e:
            logger.error(f"Error parsing NSE scrip master CSV: {e}")

    def _parse_bse_csv(self, file_path: Path):
        count = 0
        try:
            with open(file_path, mode="r", encoding="utf-8", errors="ignore") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    if row.get("pSymbolName") == "SENSEX" and row.get("pInstType") in ["IO", "OPTIDX"]:
                        token = (row.get("pSymbol") or "").strip()
                        trd_sym = (row.get("pTrdSymbol") or "").strip()
                        opt_type = (row.get("pOptionType") or "").strip().upper()
                        ref_key = (row.get("pScripRefKey") or "").strip()

                        raw_strike = row.get("dStrikePrice;") or row.get("dStrikePrice") or "0"
                        try:
                            strike = float(raw_strike)
                            if strike >= 10000:
                                strike = strike / 100.0
                            strike = round(strike, 2)
                        except Exception:
                            continue

                        exp_code = ""
                        m = re.search(r"SENSEX(\d{2}[A-Z]{3}\d{2})", ref_key)
                        if m:
                            exp_code = m.group(1).upper()
                        else:
                            m_sym = re.match(r"SENSEX(\d{2}[A-Z0-9]{3,4})", trd_sym)
                            if m_sym:
                                exp_code = m_sym.group(1).upper()

                        if not exp_code:
                            continue

                        try:
                            dt = datetime.strptime(exp_code, "%d%b%y")
                            date_str = dt.strftime("%Y-%m-%d")
                            display_str = dt.strftime("%d %b %Y")
                        except Exception:
                            date_str = exp_code
                            display_str = exp_code
                            dt = datetime.max

                        try:
                            lot_size = int(row.get("lLotSize") or row.get("iLotSize") or 20)
                        except Exception:
                            lot_size = 20

                        inst = Instrument(
                            token=token,
                            symbol=trd_sym,
                            strike=strike,
                            option_type=opt_type,
                            expiry_code=exp_code,
                            expiry_date=date_str,
                            lot_size=lot_size,
                            tick_size=0.05,
                            underlying="SENSEX",
                            exchange_segment="bse_fo"
                        )

                        self.instruments_by_token[token] = inst
                        self.instruments_by_symbol[trd_sym] = inst
                        self.lookup_map[("SENSEX", exp_code, strike, opt_type)] = inst

                        if exp_code not in self.expiries["SENSEX"]:
                            self.expiries["SENSEX"][exp_code] = {
                                "code": exp_code,
                                "date": date_str,
                                "display": display_str,
                                "dt": dt
                            }

                        if exp_code not in self.strikes_by_expiry["SENSEX"]:
                            self.strikes_by_expiry["SENSEX"][exp_code] = []
                        if strike not in self.strikes_by_expiry["SENSEX"][exp_code]:
                            self.strikes_by_expiry["SENSEX"][exp_code].append(strike)

                        count += 1

                for exp_code in self.strikes_by_expiry["SENSEX"]:
                    self.strikes_by_expiry["SENSEX"][exp_code].sort()

            logger.info(f"Loaded {count} SENSEX instruments across {len(self.expiries['SENSEX'])} expiries from BSE.")
        except Exception as e:
            logger.error(f"Error parsing BSE scrip master CSV: {e}")

    def load_master(self, force_reload: bool = False, consumer_key: Optional[str] = None):
        """
        Loads both NSE F&O (NIFTY) and BSE F&O (SENSEX) scrip masters into memory.
        """
        if force_reload or not is_scrip_updated_today("nse_fo"):
            logger.info("NSE F&O scrip master is missing or older than today. Downloading fresh copy from Kotak Neo...")
            download_scrip_csv(consumer_key=consumer_key, segment="nse_fo")

        if force_reload or not is_scrip_updated_today("bse_fo"):
            logger.info("BSE F&O scrip master is missing or older than today. Downloading fresh copy from Kotak Neo...")
            download_scrip_csv(consumer_key=consumer_key, segment="bse_fo")

        self.instruments_by_token.clear()
        self.instruments_by_symbol.clear()
        self.lookup_map.clear()
        self.expiries = {"NIFTY": {}, "SENSEX": {}}
        self.strikes_by_expiry = {"NIFTY": {}, "SENSEX": {}}

        # 1. Load NIFTY from scrip_nse_fo.csv
        if SCRIP_NSE_PATH.exists() and SCRIP_NSE_PATH.stat().st_size > 100000:
            self._parse_nse_csv(SCRIP_NSE_PATH)
        elif SCRIP_CSV_PATH.exists() and SCRIP_CSV_PATH.stat().st_size > 100000:
            self._parse_nse_csv(SCRIP_CSV_PATH)

        # 2. Load SENSEX from scrip_bse_fo.csv
        if SCRIP_BSE_PATH.exists() and SCRIP_BSE_PATH.stat().st_size > 100000:
            self._parse_bse_csv(SCRIP_BSE_PATH)

        self.is_loaded = True

    def ensure_today_master(self, force: bool = False, consumer_key: Optional[str] = None) -> bool:
        """
        Ensures the token master is up-to-date for today (first login of the day).
        """
        if not force and is_scrip_updated_today("nse_fo") and is_scrip_updated_today("bse_fo") and self.is_loaded:
            logger.info("Token master is already up-to-date for today's trading session.")
            return True

        logger.info("Updating token master for today's trading session (NSE & BSE)...")
        self.load_master(force_reload=True, consumer_key=consumer_key)
        return self.is_loaded

    def get_sorted_expiries(self, underlying: str = "NIFTY") -> List[Dict[str, Any]]:
        """Returns sorted list of active future (or today's) expiries, omitting expired dates"""
        u = underlying.upper() if underlying else "NIFTY"
        today = datetime.now().date()
        exp_dict = self.expiries.get(u, {})
        # Filter out expired contracts strictly prior to today
        exp_list = [e for e in exp_dict.values() if e["dt"].date() >= today]
        exp_list.sort(key=lambda x: x["dt"])
        return [
            {
                "code": e["code"],
                "date": e["date"],
                "display": f"{e['display']} ({'Weekly' if e['dt'].day not in [24,25,26,27,28,29,30,31] or e['dt'].weekday() not in [3, 4] else 'Monthly'})"
            }
            for e in exp_list
        ]

    def get_strikes(self, expiry_code: Optional[str] = None, underlying: str = "NIFTY") -> List[float]:
        """Returns sorted list of available strike prices for given expiry and underlying"""
        u = underlying.upper() if underlying else "NIFTY"
        strikes_map = self.strikes_by_expiry.get(u, {})
        if not expiry_code:
            expiries = self.get_sorted_expiries(underlying=u)
            if not expiries:
                return []
            expiry_code = expiries[0]["code"]
        return strikes_map.get(expiry_code.upper(), [])

    def resolve_option(self, strike: float, option_type: str, expiry_code: Optional[str] = None, underlying: str = "NIFTY") -> Optional[Instrument]:
        """Resolves exact Instrument for strike, CE/PE, expiry, and underlying (NIFTY/SENSEX)"""
        u = underlying.upper() if underlying else "NIFTY"
        if not expiry_code:
            exp = self.get_sorted_expiries(underlying=u)
            if not exp:
                return None
            expiry_code = exp[0]["code"]

        exp_code = expiry_code.upper()
        opt_type = option_type.upper()
        stk = round(float(strike), 2)

        key_underlying = (u, exp_code, stk, opt_type)
        if key_underlying in self.lookup_map:
            return self.lookup_map[key_underlying]

        # Check generic lookup for Nifty backwards-compatibility
        if u == "NIFTY":
            key_generic = (exp_code, stk, opt_type)
            if key_generic in self.lookup_map:
                return self.lookup_map[key_generic]

        # Try nearest strike match within 2.5 points if exact not found
        available = self.strikes_by_expiry.get(u, {}).get(exp_code, [])
        for s in available:
            if abs(s - stk) <= 2.5:
                alt_key = (u, exp_code, s, opt_type)
                if alt_key in self.lookup_map:
                    return self.lookup_map[alt_key]
                if u == "NIFTY":
                    alt_key_gen = (exp_code, s, opt_type)
                    if alt_key_gen in self.lookup_map:
                        return self.lookup_map[alt_key_gen]

        return None

    def get_option_chain_snapshot(self, spot_price: float, expiry_code: Optional[str] = None, strike_count: int = 10, underlying: str = "NIFTY") -> Dict[str, Any]:
        """Returns chain centered around ATM for the selected expiry and underlying"""
        u = underlying.upper() if underlying else "NIFTY"
        expiries = self.get_sorted_expiries(underlying=u)
        if not expiries:
            return {"expiry": None, "strikes": [], "chain": []}

        if not expiry_code:
            expiry_code = expiries[0]["code"]

        exp_code = expiry_code.upper()
        strikes = self.strikes_by_expiry.get(u, {}).get(exp_code, [])
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
            ce_inst = self.lookup_map.get((u, exp_code, stk, "CE")) or self.lookup_map.get((exp_code, stk, "CE"))
            pe_inst = self.lookup_map.get((u, exp_code, stk, "PE")) or self.lookup_map.get((exp_code, stk, "PE"))
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
        expiry_code: Optional[str] = None,
        underlying: str = "NIFTY"
    ) -> float:
        """
        Calculates realistic, expiry-aware option premium based on Black-Scholes volatility time-decay.
        Properly differentiates between near-week, next-week, and monthly expiries for both NIFTY and SENSEX.
        """
        u = underlying.upper() if underlying else "NIFTY"
        exp_code = str(expiry_code or "").upper()
        dte = 2.0  # fallback
        exp_dict = self.expiries.get(u, {})
        if exp_code and exp_code in exp_dict:
            exp_info = exp_dict[exp_code]
            exp_dt = exp_info.get("dt")
            if exp_dt:
                from datetime import date
                cur_date = date.today()
                exp_date = exp_dt.date() if hasattr(exp_dt, "date") else exp_dt
                diff = (exp_date - cur_date).days
                dte = max(0.35, float(diff) + 0.35)

        # Scale ATM extrinsic and curve width by spot level (e.g. SENSEX ~80k vs NIFTY ~24k)
        scale = max(0.5, spot_price / 24000.0)
        atm_extrinsic = max(6.0 * scale, 36.0 * scale * math.sqrt(dte))
        
        # Bell curve width scales with DTE and spot
        dist = abs(spot_price - strike)
        curve_width = (160.0 + 20.0 * math.sqrt(dte)) * scale
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
        spread_width: Optional[float] = None,
        wing_width: Optional[float] = None,
        lots: int = 1,
        main_strike: Optional[float] = None,
        hedge_distance: Optional[float] = None,
        underlying: str = "NIFTY"
    ) -> List[Dict[str, Any]]:
        """
        Builds properly sequenced and resolved strategy legs with exact Kotak tokens and symbols.
        Supports customizable main strike and hedge distance (Sensibull style).
        BUY legs are placed first for margin reduction. Supports both NIFTY (NSE) and SENSEX (BSE).
        """
        u = underlying.upper() if underlying else "NIFTY"
        step = 100.0 if u == "SENSEX" else 50.0
        default_lot_size = 20 if u == "SENSEX" else 65
        default_spread = 200.0 if u == "SENSEX" else 100.0
        exchange_seg = "bse_fo" if u == "SENSEX" else "nse_fo"

        expiries = self.get_sorted_expiries(underlying=u)
        if not expiries:
            return []
        if not expiry_code:
            expiry_code = expiries[0]["code"]

        exp_code = expiry_code.upper()
        strikes = self.strikes_by_expiry.get(u, {}).get(exp_code, [])
        if not strikes:
            return []

        # Find closest ATM strike (rounded to nearest step)
        atm_strike = min(strikes, key=lambda s: abs(s - spot_price))
        atm_strike = round(atm_strike / step) * step

        # Anchor strike (Main strike selected by user or default ATM)
        if main_strike is not None and float(main_strike) > 0:
            anchor_strike = round(float(main_strike) / step) * step
        else:
            anchor_strike = atm_strike

        # Effective hedge distance
        effective_hedge = float(hedge_distance if hedge_distance is not None and hedge_distance > 0 else (spread_width or default_spread))
        effective_hedge = max(step, round(effective_hedge / step) * step)

        legs_config = []
        strat_type = strategy_type.upper()

        if strat_type in ["BULL_CALL_SPREAD", "BULL_CALL"]:
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike + effective_hedge, "option_type": "CE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["BEAR_PUT_SPREAD", "BEAR_PUT"]:
            legs_config = [
                {"strike": anchor_strike, "option_type": "PE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["BULL_PUT_SPREAD", "BULL_PUT_CREDIT"]:
            legs_config = [
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["BEAR_CALL_SPREAD", "BEAR_CALL_CREDIT"]:
            legs_config = [
                {"strike": anchor_strike + effective_hedge, "option_type": "CE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["IRON_CONDOR", "CONDOR"]:
            wing = effective_hedge
            put_sell = anchor_strike - step
            put_buy = put_sell - wing
            call_sell = anchor_strike + step
            call_buy = call_sell + wing

            legs_config = [
                {"strike": put_buy, "option_type": "PE", "action": "BUY", "lots": 1},
                {"strike": call_buy, "option_type": "CE", "action": "BUY", "lots": 1},
                {"strike": put_sell, "option_type": "PE", "action": "SELL", "lots": 1},
                {"strike": call_sell, "option_type": "CE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["SHORT_STRADDLE"]:
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL", "lots": 1},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL", "lots": 1}
            ]
        elif strat_type in ["LONG_STRADDLE"]:
            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike, "option_type": "PE", "action": "BUY", "lots": 1}
            ]
        elif strat_type in ["CALENDAR_SPREAD", "CALENDAR"]:
            near_exp = exp_code
            far_exp = exp_code
            for i, e in enumerate(expiries):
                if e["code"].upper() == exp_code and (i + 1) < len(expiries):
                    far_exp = expiries[i + 1]["code"].upper()
                    break
            if far_exp == near_exp and len(expiries) > 1:
                far_exp = expiries[1]["code"].upper()

            legs_config = [
                {"strike": anchor_strike, "option_type": "CE", "action": "BUY", "expiry": far_exp, "lots": 1},
                {"strike": anchor_strike, "option_type": "CE", "action": "SELL", "expiry": near_exp, "lots": 1}
            ]
        else:
            legs_config = [
                {"strike": anchor_strike - effective_hedge, "option_type": "PE", "action": "BUY", "lots": 1},
                {"strike": anchor_strike, "option_type": "PE", "action": "SELL", "lots": 1}
            ]

        resolved_legs = []
        for cfg in legs_config:
            leg_exp = cfg.get("expiry", exp_code)
            inst = self.resolve_option(cfg["strike"], cfg["option_type"], leg_exp, underlying=u)
            leg_lots = int(cfg.get("lots") or 1)
            lot_size = inst.lot_size if inst else default_lot_size
            qty = lot_size * leg_lots * lots
            if inst:
                price = 0.0
                try:
                    from backend.market_engine import market_engine
                    if market_engine:
                        price = market_engine.get_option_price(inst.trading_symbol, inst.strike, inst.option_type)
                except Exception:
                    pass

                if price <= 0.0:
                    price = self.estimate_option_price(spot_price, inst.strike, inst.option_type, inst.expiry_code, underlying=u)

                resolved_legs.append({
                    "token": inst.token,
                    "trading_symbol": inst.trading_symbol,
                    "strike": inst.strike,
                    "option_type": inst.option_type,
                    "action": cfg["action"],
                    "lots": leg_lots,
                    "quantity": qty,
                    "price": price,
                    "entry_price": price,
                    "lot_size": inst.lot_size,
                    "expiry": inst.expiry_code,
                    "expiry_date": inst.expiry_date,
                    "exchange_segment": inst.exchange_segment,
                    "product": "NRML"
                })
            else:
                logger.warning(f"Could not resolve instrument for strike {cfg['strike']} {cfg['option_type']} {exp_code} ({u})")

        return resolved_legs

    def resolve_custom_legs(
        self,
        custom_legs: List[Dict[str, Any]],
        spot_price: float,
        default_expiry: Optional[str] = None,
        lots: int = 1,
        underlying: str = "NIFTY"
    ) -> List[Dict[str, Any]]:
        """
        Takes user-customized legs (with edited strikes, action, expiry, option_type, lots, quantity),
        resolves exact scrip master tokens & trading symbols, and estimates/fetches real-time price.
        Supports both NIFTY (NSE) and SENSEX (BSE).
        """
        u = underlying.upper() if underlying else "NIFTY"
        step = 100.0 if u == "SENSEX" else 50.0
        default_lot_size = 20 if u == "SENSEX" else 65
        default_segment = "bse_fo" if u == "SENSEX" else "nse_fo"

        expiries = self.get_sorted_expiries(underlying=u)
        if not default_expiry and expiries:
            default_expiry = expiries[0]["code"]

        resolved = []
        for leg in custom_legs:
            try:
                stk = round(float(leg.get("strike", spot_price)) / step) * step
            except Exception:
                stk = round(spot_price / step) * step

            opt_type = str(leg.get("option_type", "CE")).upper()
            act = str(leg.get("action", "BUY")).upper()
            act = "SELL" if act.startswith("S") else "BUY"
            leg_exp = str(leg.get("expiry") or default_expiry or "").upper()

            inst = self.resolve_option(stk, opt_type, leg_exp, underlying=u)
            lot_size = inst.lot_size if inst else default_lot_size
            leg_lots = max(1, int(leg.get("lots") or 1))
            qty = int(leg.get("quantity") or (lot_size * leg_lots * lots))

            if inst:
                trading_symbol = inst.trading_symbol
                token = inst.token
                expiry_date = inst.expiry_date
                expiry_code = inst.expiry_code
                exchange_segment = inst.exchange_segment
            else:
                trading_symbol = leg.get("trading_symbol") or f"{u}_{leg_exp}_{int(stk)}{opt_type}"
                token = str(leg.get("token") or "")
                expiry_date = leg.get("expiry_date") or leg_exp
                expiry_code = leg_exp
                exchange_segment = default_segment

            if leg.get("is_custom_price") and float(leg.get("price") or 0.0) > 0.0:
                price = float(leg["price"])
            else:
                price = 0.0
                try:
                    from backend.market_engine import market_engine
                    if market_engine and trading_symbol:
                        price = market_engine.get_option_price(trading_symbol, stk, opt_type)
                except Exception:
                    pass

                if price <= 0.0:
                    price = self.estimate_option_price(spot_price, stk, opt_type, expiry_code, underlying=u)

            resolved.append({
                "token": token,
                "trading_symbol": trading_symbol,
                "strike": stk,
                "option_type": opt_type,
                "action": act,
                "lots": leg_lots,
                "quantity": qty,
                "price": price,
                "entry_price": price,
                "is_custom_price": bool(leg.get("is_custom_price")),
                "lot_size": lot_size,
                "expiry": expiry_code,
                "expiry_date": expiry_date,
                "exchange_segment": exchange_segment,
                "product": "NRML"
            })
        return resolved

    def compute_payoff_profile(
        self,
        legs: List[Dict[str, Any]],
        spot_price: float,
        underlying: str = "NIFTY"
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

        u = underlying.upper() if underlying else "NIFTY"
        step = 50.0 if u == "SENSEX" else 25.0
        grid_round = 100.0 if u == "SENSEX" else 50.0
        buffer_pts = 1500.0 if u == "SENSEX" else 600.0
        base_lot_size = 20 if u == "SENSEX" else 65

        strikes = [float(l["strike"]) for l in legs]
        min_stk = min(strikes) if strikes else spot_price - buffer_pts
        max_stk = max(strikes) if strikes else spot_price + buffer_pts

        # Calculate net premium
        net_prem = 0.0
        for l in legs:
            act = str(l.get("action", "")).upper()
            prc = float(l.get("price") or l.get("entry_price") or 0.0)
            qty = abs(int(l.get("quantity") or base_lot_size))
            if act.startswith("B"):
                net_prem -= prc * qty
            else:
                net_prem += prc * qty

        # Evaluation range
        eval_min = min(min_stk, spot_price) - buffer_pts
        eval_max = max(max_stk, spot_price) + buffer_pts
        eval_min = round(eval_min / grid_round) * grid_round
        eval_max = round(eval_max / grid_round) * grid_round

        num_steps = int((eval_max - eval_min) / step) + 1
        sample_spots = sorted(set([eval_min + i * step for i in range(num_steps)] + strikes + [spot_price]))

        # Check for multiple expiries (Calendar Spread modeling)
        leg_expiries = [l.get("expiry") for l in legs if l.get("expiry")]
        sorted_exp_codes = [e["code"].upper() for e in self.get_sorted_expiries(underlying=u)]
        
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
                qty = abs(int(leg.get("quantity") or base_lot_size))
                leg_exp = str(leg.get("expiry") or "").upper()
                is_far_expiry = bool(has_calendar and leg_exp and leg_exp != nearest_expiry)

                if opt == "CE":
                    intrinsic = max(0.0, s - k)
                else:
                    intrinsic = max(0.0, k - s)

                if is_far_expiry:
                    dist = abs(s - k)
                    decay_width = 700.0 if u == "SENSEX" else 220.0
                    remaining_extrinsic = max(5.0, prc * 0.75 * math.exp(-0.5 * ((dist / decay_width) ** 2)))
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

        pnl_far_left = _pnl_at_spot(max(100.0, eval_min - 10000.0))
        pnl_far_right = _pnl_at_spot(eval_max + 10000.0)

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

        # Deduplicate breakevens within 10 points for Sensex, 5 for Nifty
        be_tol = 10.0 if u == "SENSEX" else 5.0
        cleaned_be = []
        for be in sorted(breakevens):
            if not cleaned_be or abs(be - cleaned_be[-1]) > be_tol:
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

        # Margin Required Estimation (SPAN + Exposure with Multi-Leg Strategy Hedge Benefit)
        sell_legs = [l for l in legs if str(l.get("action", "")).upper() == "SELL"]
        buy_legs = [l for l in legs if str(l.get("action", "")).upper() == "BUY"]
        total_buy_prem = sum(
            float(l.get("price", 0)) * int(l.get("quantity", base_lot_size))
            for l in buy_legs
        )
        total_sell_prem = sum(
            float(l.get("price", 0)) * int(l.get("quantity", base_lot_size))
            for l in sell_legs
        )
        total_qty = max([int(l.get("quantity", base_lot_size)) for l in legs], default=base_lot_size)
        num_lots = max(1, total_qty // base_lot_size)
        naked_margin = 150000.0 if u == "SENSEX" else 125000.0
        spread_base = 25000.0 if u == "SENSEX" else 18000.0
        credit_min = 35000.0 if u == "SENSEX" else 28000.0
        condor_min = 45000.0 if u == "SENSEX" else 35000.0

        if not sell_legs:
            margin_required = max(0.0, total_buy_prem)
        elif sell_legs and not buy_legs:
            mult = 1.35 if len(sell_legs) >= 2 else 1.0
            margin_required = naked_margin * num_lots * mult
        else:
            is_debit = (total_buy_prem > total_sell_prem)
            if is_debit:
                margin_required = max(total_buy_prem, abs(max_loss) if max_loss else 0.0)
            else:
                spread_loss = abs(max_loss) if (max_loss is not None and max_loss < 0) else (spread_base * num_lots)
                if len(sell_legs) <= len(buy_legs):
                    if len(sell_legs) == 1:
                        margin_required = max(spread_loss + (spread_base * num_lots), credit_min * num_lots)
                    else:
                        margin_required = max(spread_loss + ((spread_base + 2000.0) * num_lots), condor_min * num_lots)
                else:
                    excess_shorts = len(sell_legs) - len(buy_legs)
                    margin_required = (credit_min * num_lots) + (naked_margin * excess_shorts * num_lots)

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

    def generate_strategy_name(self, strategy_type: str, legs: List[Dict[str, Any]], underlying: str = "NIFTY") -> str:
        """
        Auto-generates clean Sensibull-style strategy names incorporating the exact leg strikes and expiry.
        e.g. Bull Put Spread (25100 PE / 24900 PE) - 27-Oct-2026
             SENSEX Iron Condor (79400 PE / 79600 PE / 79800 CE / 80000 CE) - 27-Oct-2026
        """
        u = underlying.upper() if underlying else "NIFTY"
        if not legs:
            return f"{u} Strategy"

        strat_type = strategy_type.upper()
        # Sort legs: PE first then CE; within that by strike
        sorted_legs = sorted(legs, key=lambda l: (l.get("option_type", ""), float(l.get("strike", 0))))
        legs_desc = " / ".join(f"{int(l['strike'])} {l['option_type']}" for l in sorted_legs)

        # Extract expiry
        expiry_label = ""
        exp_dict = self.expiries.get(u, {})
        for l in legs:
            exp_code = l.get("expiry") or l.get("expiry_code")
            if exp_code and exp_code in exp_dict:
                expiry_label = exp_dict[exp_code].get("display", exp_code)
                break
            elif l.get("expiry_date"):
                expiry_label = str(l.get("expiry_date"))
                break
            elif exp_code:
                expiry_label = str(exp_code)
                break

        exp_suffix = f" - {expiry_label}" if expiry_label else ""
        prefix = f"{u} " if u == "SENSEX" else ""

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
        elif "CUSTOM" in strat_type:
            base = f"Custom Strategy ({legs_desc})"
        else:
            title = strategy_type.replace("_", " ").title()
            base = f"{title} ({legs_desc})"

        return f"{prefix}{base}{exp_suffix}"

