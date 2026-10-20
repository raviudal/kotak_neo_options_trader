import os
import json
import logging
import time
import requests
import pyotp
from datetime import datetime, date
from typing import Dict, Any, List, Optional
from pathlib import Path
from backend.database import get_db
from backend.config import KOTAK_CONSUMER_KEY, KOTAK_MOBILE_NUMBER, KOTAK_UCC

logger = logging.getLogger("kotak_service")

# Optional environment pre-fills (empty by default for open source security)
DEFAULT_CONSUMER_KEY = KOTAK_CONSUMER_KEY
DEFAULT_MOBILE_NUMBER = KOTAK_MOBILE_NUMBER
DEFAULT_UCC = KOTAK_UCC
DEFAULT_BASE_URL = "https://mis.kotaksecurities.com/"

class KotakNeoManager:
    _instances: Dict[int, "KotakNeoManager"] = {}

    def __init__(self, user_id: int):
        self.user_id = user_id
        self.consumer_key = DEFAULT_CONSUMER_KEY
        self.mobile_number = DEFAULT_MOBILE_NUMBER
        self.ucc = DEFAULT_UCC
        self.client_name = ""
        self.mpin = ""
        self.totp_secret = ""
        
        # STRICT SECURITY: Tokens and active session state live ONLY in RAM.
        # Zero session tokens stored on disk.
        self.trade_token: Optional[str] = None
        self.trade_sid: Optional[str] = None
        self.base_url: str = "https://e41.kotaksecurities.com/"
        self.is_connected: bool = False
        self.session_created_at: Optional[datetime] = None

        self.load_config()

    @classmethod
    def get_instance(cls, user_id: int) -> "KotakNeoManager":
        if user_id not in cls._instances:
            cls._instances[user_id] = cls(user_id)
        return cls._instances[user_id]

    def load_config(self):
        """Loads static credentials (mobile, ucc, mpin, client_name) from DB for form auto-fill only."""
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT consumer_key, mobile_number, ucc, mpin, totp_secret, client_name "
                "FROM kotak_config WHERE user_id = ?",
                (self.user_id,)
            )
            row = cursor.fetchone()
            if row:
                if row["consumer_key"]: self.consumer_key = row["consumer_key"]
                if row["mobile_number"]: self.mobile_number = row["mobile_number"]
                if row["ucc"]: self.ucc = row["ucc"]
                if row["mpin"]: self.mpin = row["mpin"]
                if row["totp_secret"]: self.totp_secret = row["totp_secret"]
                if "client_name" in row.keys() and row["client_name"]: self.client_name = row["client_name"]

    def is_session_expired(self) -> bool:
        """
        Kotak Neo session expires at 11:50 PM (23:50 IST) every day.
        Also expires if date changed (past midnight).
        """
        if not self.trade_token or not self.session_created_at:
            return True

        from zoneinfo import ZoneInfo
        try:
            ist = ZoneInfo("Asia/Kolkata")
            now_ist = datetime.now(ist)
            created_ist = self.session_created_at if self.session_created_at.tzinfo else self.session_created_at.replace(tzinfo=ist)
        except Exception:
            now_ist = datetime.now()
            created_ist = self.session_created_at

        # 1. Past midnight (different date) -> Expired
        if now_ist.date() > created_ist.date():
            return True

        # 2. Daily cutoff at 11:50 PM (23:50 IST)
        # If current time is 23:50 or later, and session was created prior to 23:50 -> Expired
        if (now_ist.hour > 23) or (now_ist.hour == 23 and now_ist.minute >= 50):
            if created_ist.hour < 23 or (created_ist.hour == 23 and created_ist.minute < 50):
                return True

        return False

    def clear_ram_session(self):
        """Wipes active session from RAM immediately."""
        self.trade_token = None
        self.trade_sid = None
        self.is_connected = False
        self.session_created_at = None
        logger.info(f"Kotak Neo session cleared from RAM for user {self.user_id}.")

    def verify_session(self, force_check: bool = False) -> bool:
        """
        Actively checks Kotak login against the Kotak Neo API.
        If tokens are missing, expired, or rejected (e.g. IP mismatch or expired),
        wipes RAM session and returns False.
        """
        if not self.trade_token or not self.trade_sid:
            self.clear_ram_session()
            return False

        if self.is_session_expired():
            logger.info("Kotak Neo session reached daily evening expiration.")
            self.clear_ram_session()
            return False

        # Ping Kotak Neo positions endpoint to actively verify token authenticity
        try:
            url = f"{self.base_url}quick/user/positions"
            r = requests.get(url, headers=self.get_auth_headers(), timeout=3.0)
            if r.status_code == 200:
                self.is_connected = True
                return True
            else:
                logger.warning(f"Kotak session verification failed HTTP {r.status_code}: {r.text}")
                self.clear_ram_session()
                return False
        except Exception as e:
            logger.error(f"Error during active Kotak session verification: {e}")
            if force_check:
                self.clear_ram_session()
                return False

        return self.is_connected

    def get_saved_credentials(self) -> Dict[str, Any]:
        """Returns pre-filled credentials for the UI auto-fill"""
        self.load_config()
        return {
            "consumer_key": self.consumer_key or DEFAULT_CONSUMER_KEY or "",
            "mobile_number": self.mobile_number or DEFAULT_MOBILE_NUMBER or "",
            "ucc": self.ucc or DEFAULT_UCC or "",
            "client_name": self.client_name or "",
            "mpin": self.mpin or "",
            "has_totp_secret": bool(self.totp_secret),
            "is_connected": self.is_connected,
            "last_login_at": self.session_created_at.isoformat() if self.session_created_at else None
        }

    def get_auth_headers(self, is_quote: bool = False) -> Dict[str, str]:
        """Auth headers matching Kotak Neo TradeAPI v2 specifications"""
        if is_quote:
            return {
                "Authorization": self.consumer_key,
                "Sid": self.trade_sid or "",
                "Auth": self.trade_token or "",
                "neo-fin-key": "neotradeapi"
            }
        else:
            return {
                "Authorization": f"Bearer {self.trade_token}",
                "Sid": self.trade_sid or "",
                "Auth": self.trade_token or "",
                "neo-fin-key": "neotradeapi"
            }

    def login_totp(
        self,
        consumer_key: Optional[str] = None,
        mobile_number: Optional[str] = None,
        ucc: Optional[str] = None,
        totp: Optional[str] = None,
        mpin: Optional[str] = None,
        totp_secret: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Executes Kotak Neo v2 two-step login:
        Step 1: POST https://mis.kotaksecurities.com/login/1.0/tradeApiLogin (TOTP)
        Step 2: POST https://mis.kotaksecurities.com/login/1.0/tradeApiValidate (MPIN)
        Stores session strictly in RAM. Zero session files on disk.
        """
        self.consumer_key = (consumer_key or self.consumer_key or DEFAULT_CONSUMER_KEY).strip()
        self.mobile_number = (mobile_number or self.mobile_number or DEFAULT_MOBILE_NUMBER).strip()
        self.ucc = (ucc or self.ucc or DEFAULT_UCC).strip().upper()
        if mpin: self.mpin = mpin.strip()
        if totp_secret: self.totp_secret = totp_secret.strip()

        # Resolve TOTP
        final_totp = totp.strip() if totp and totp.strip() else None
        if not final_totp and self.totp_secret:
            try:
                final_totp = pyotp.TOTP(self.totp_secret).now()
                logger.info("Auto-generated Kotak TOTP from saved secret.")
            except Exception as e:
                return {"status": "error", "message": f"Invalid TOTP secret: {e}"}

        if not final_totp:
            return {"status": "error", "message": "Please enter your 6-digit Kotak Neo TOTP code"}

        if not self.mpin:
            return {"status": "error", "message": "Please enter your 6-digit MPIN"}

        try:
            def _unwrap_kotak(res_obj):
                if not isinstance(res_obj, dict):
                    return {}
                unwrapped = dict(res_obj)
                if isinstance(res_obj.get("data"), dict):
                    unwrapped.update(res_obj["data"])
                return unwrapped

            def _get_kotak_err(res_obj):
                if not isinstance(res_obj, dict):
                    return None
                err = res_obj.get("error")
                if err:
                    if isinstance(err, list) and len(err) > 0 and isinstance(err[0], dict):
                        return err[0].get("message") or str(err[0])
                    return str(err)
                stat = res_obj.get("stat") or res_obj.get("success")
                if str(stat).lower() in ["not_ok", "false"]:
                    return res_obj.get("errmsg") or res_obj.get("message") or "Kotak API error"
                return None

            # ── Step 1: TOTP Login ──
            login_url = "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin"
            step1_headers = {
                "Authorization": self.consumer_key,
                "neo-fin-key": "neotradeapi",
                "Content-Type": "application/json"
            }
            step1_payload = {
                "mobileNumber": self.mobile_number,
                "ucc": self.ucc,
                "totp": final_totp
            }
            logger.info("Calling Kotak Neo Step 1 (tradeApiLogin)...")
            r1 = requests.post(login_url, json=step1_payload, headers=step1_headers, timeout=12)
            try:
                res1 = r1.json()
            except Exception:
                res1 = {"raw": r1.text}

            logger.info(f"Kotak Neo Step 1 HTTP {r1.status_code}: {res1}")

            err1 = _get_kotak_err(res1)
            if r1.status_code != 200 or err1:
                return {"status": "error", "message": f"TOTP Verification failed: {err1 or r1.text}"}

            data1 = _unwrap_kotak(res1)
            view_token = data1.get("token") or data1.get("view_token")
            sid = data1.get("sid")
            if not view_token:
                return {"status": "error", "message": f"No token received from Kotak Neo TOTP login. Response: {res1}"}

            self.client_name = data1.get("greetingName") or data1.get("userName") or data1.get("clientName") or self.client_name

            # ── Step 2: MPIN Validate ──
            validate_url = "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate"
            step2_headers = {
                "Authorization": self.consumer_key,
                "sid": sid,
                "Auth": view_token,
                "neo-fin-key": "neotradeapi",
                "Content-Type": "application/json"
            }
            step2_payload = {"mpin": self.mpin}
            logger.info("Calling Kotak Neo Step 2 (tradeApiValidate)...")
            r2 = requests.post(validate_url, json=step2_payload, headers=step2_headers, timeout=12)
            try:
                res2 = r2.json()
            except Exception:
                res2 = {"raw": r2.text}

            logger.info(f"Kotak Neo Step 2 HTTP {r2.status_code}: {res2}")

            err2 = _get_kotak_err(res2)
            if r2.status_code != 200 or err2:
                return {"status": "error", "message": f"MPIN Validation failed: {err2 or r2.text}"}

            data2 = _unwrap_kotak(res2)
            self.trade_token = data2.get("token") or data2.get("trade_token")
            self.trade_sid = data2.get("sid") or sid
            raw_url = data2.get("baseUrl") or data2.get("hss_url") or data2.get("base_url") or "https://e41.kotaksecurities.com/"
            if not raw_url.endswith("/"):
                raw_url += "/"
            self.base_url = raw_url
            self.is_connected = True
            self.session_created_at = datetime.now()

            # Strictly save ONLY static details (UCC, mobile, MPIN, client_name) to DB for auto-fill.
            # NEVER save tokens, sid, or is_connected to disk!
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM kotak_config WHERE user_id = ?", (self.user_id,))
                if cursor.fetchone():
                    cursor.execute("""
                        UPDATE kotak_config 
                        SET consumer_key = ?, mobile_number = ?, ucc = ?, mpin = ?, client_name = ?, access_token = NULL, neo_fin_key = NULL, is_connected = 0
                        WHERE user_id = ?
                    """, (self.consumer_key, self.mobile_number, self.ucc, self.mpin, self.client_name, self.user_id))
                else:
                    cursor.execute("""
                        INSERT INTO kotak_config (user_id, consumer_key, mobile_number, ucc, mpin, client_name, access_token, neo_fin_key, is_connected)
                        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)
                    """, (self.user_id, self.consumer_key, self.mobile_number, self.ucc, self.mpin, self.client_name))
                conn.commit()

            logger.info(f"✅ Kotak Neo login successful for {self.client_name} ({self.ucc}) [In-RAM Session Active]")

            # Download / ensure updated token master for today upon the first login of the day!
            try:
                from backend.instrument_master import InstrumentMaster
                InstrumentMaster.get_instance().ensure_today_master(consumer_key=self.consumer_key)
            except Exception as e:
                logger.warning(f"Could not check/update token master after login: {e}")

            return {
                "status": "success",
                "message": f"Successfully authenticated with Kotak Neo! Welcome {self.client_name}.",
                "client_name": self.client_name,
                "ucc": self.ucc
            }
        except Exception as e:
            logger.error(f"Kotak login exception: {e}")
            return {"status": "error", "message": str(e)}

    def disconnect(self):
        """Disconnects and wipes all RAM session tokens"""
        self.clear_ram_session()
        return {"status": "success", "message": "Disconnected from Kotak Neo"}

    def get_status(self) -> Dict[str, Any]:
        """Returns Kotak Neo connectivity status after active verification"""
        self.load_config()
        is_active = self.verify_session()
        return {
            "is_connected": is_active,
            "client_name": self.client_name or (self.ucc if self.ucc else "Trader"),
            "ucc": self.ucc or DEFAULT_UCC,
            "mobile_number": (self.mobile_number[:5] + "******" + self.mobile_number[-2:]) if self.mobile_number and len(self.mobile_number) >= 8 else self.mobile_number,
            "last_login_at": self.session_created_at.isoformat() if self.session_created_at else None,
            "base_url": self.base_url
        }

    def get_nifty_quote(self) -> Optional[Dict[str, Any]]:
        """Fetches live real-time quote for Nifty 50 from Kotak Neo REST quote API"""
        if not self.is_connected or not self.trade_token:
            return None
        try:
            url = f"{self.base_url}script-details/1.0/quotes/neosymbol/nse_cm%7CNifty%2050"
            r = requests.get(url, headers=self.get_auth_headers(is_quote=True), timeout=4)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and len(data) > 0:
                    item = data[0]
                    ohlc = item.get("ohlc", {})
                    return {
                        "symbol": "NIFTY 50",
                        "spot": float(item.get("ltp", 0)),
                        "change": float(item.get("change", 0)),
                        "pct_change": float(item.get("per_change", 0)),
                        "open": float(ohlc.get("open", 0)),
                        "high": float(ohlc.get("high", 0)),
                        "low": float(ohlc.get("low", 0)),
                        "prev_close": float(ohlc.get("close", 0)),
                        "is_live": True,
                        "timestamp": datetime.now().isoformat()
                    }
        except Exception as e:
            logger.error(f"Error fetching live Nifty quote: {e}")
        return None

    def _probe_live_available_margin(self) -> Optional[float]:
        """Probes /quick/user/check-margin to read real live avlMrgn / avlCash from Kotak Neo broker RMS"""
        try:
            url = f"{self.base_url}quick/user/check-margin?sId={self.trade_sid}"
            payload = {
                "jData": json.dumps({
                    "brkName": "KOTAK",
                    "brnchId": "ONLINE",
                    "exSeg": "nse_fo",
                    "prc": "100.00",
                    "prcTp": "L",
                    "prod": "NRML",
                    "qty": "65",
                    "tok": "26000",
                    "trnsTp": "B"
                })
            }
            r = requests.post(url, headers=self.get_auth_headers(), data=payload, timeout=4)
            if r.status_code == 200:
                resp = r.json()
                d = resp.get("data") if isinstance(resp, dict) else resp
                if isinstance(d, list) and len(d) > 0:
                    d = d[0]
                if isinstance(d, dict):
                    for k in ["avlMrgn", "avlCash", "available_margin"]:
                        v = d.get(k)
                        if v is not None:
                            try:
                                num = float(str(v).replace(",", "").strip())
                                if num > 0:
                                    return num
                            except Exception:
                                pass
        except Exception as e:
            logger.debug(f"Probe available margin exception: {e}")
        return None

    def get_limits(self) -> Dict[str, Any]:
        """Fetches account margin and available limits from Kotak Neo RMS"""
        if not self.is_connected or not self.trade_token:
            return {"error": "Kotak Neo API is not connected", "is_connected": False}
        try:
            url = f"{self.base_url}quick/user/limits?sId={self.trade_sid}"
            data = {"jData": json.dumps({"seg": "ALL", "exch": "ALL", "prod": "ALL"})}
            r = requests.post(url, headers=self.get_auth_headers(), data=data, timeout=8)
            logger.info(f"Kotak limits raw HTTP {r.status_code}: {r.text[:300]}")
            if r.status_code == 200:
                raw = r.json()
                d = raw
                if isinstance(d, dict) and "data" in d:
                    d = d["data"]
                if isinstance(d, list) and len(d) > 0:
                    d = d[0]
                if not isinstance(d, dict):
                    d = raw if isinstance(raw, dict) else {}

                def _to_float(v):
                    if v is None: return 0.0
                    try:
                        return float(str(v).replace(",", "").strip())
                    except Exception:
                        return 0.0

                avl_mrgn = _to_float(d.get("avlMrgn") or d.get("available_margin"))
                avl_cash = _to_float(d.get("avlCash") or d.get("Cash") or d.get("available_cash"))
                net = _to_float(d.get("Net") or d.get("net"))
                collateral = _to_float(d.get("Collateral") or d.get("CollateralValue"))
                utilized = _to_float(d.get("totMrgnUsd") or d.get("mrgnUsd") or d.get("AmountUtilizedPrsnt"))
                realized_pnl = _to_float(d.get("RealizedMtomPrsnt"))

                if avl_mrgn > 0:
                    best_avail = avl_mrgn
                elif net > 0:
                    best_avail = net
                elif (avl_cash + collateral) > 0:
                    best_avail = avl_cash + collateral
                elif avl_cash > 0:
                    best_avail = avl_cash
                else:
                    best_avail = 0.0

                # If limits response didn't supply positive balance, attempt probe check-margin
                if best_avail <= 0.0:
                    probed = self._probe_live_available_margin()
                    if probed and probed > 0:
                        best_avail = probed
                        if avl_cash <= 0:
                            avl_cash = probed

                return {
                    "available_margin": round(best_avail, 2),
                    "available_cash": round(avl_cash or best_avail, 2),
                    "collateral": round(collateral, 2),
                    "utilized_margin": round(utilized, 2),
                    "realized_pnl": round(realized_pnl, 2),
                    "client": d.get("EntityId") or self.ucc or "",
                    "is_connected": True,
                    "raw": raw
                }
            return {"error": r.text, "is_connected": False}
        except Exception as e:
            logger.error(f"Error fetching limits: {e}")
            return {"error": str(e), "is_connected": False}

    def check_order_margin(self, legs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Directly queries Kotak Neo /quick/user/check-margin endpoint for strategy legs.
        Fetches live broker RMS required margin and available margin.
        """
        if not self.is_connected or not self.trade_token:
            return {"error": "Kotak Neo API is not connected", "is_connected": False}

        results = []
        total_broker_margin = 0.0
        broker_avail_margin = None
        broker_avail_cash = None

        url = f"{self.base_url}quick/user/check-margin?sId={self.trade_sid}"

        for leg in legs:
            try:
                tok = str(leg.get("token") or "")
                action = "B" if str(leg.get("action", "")).upper() == "BUY" else "S"
                qty = str(int(leg.get("quantity") or 65))
                price = f"{float(leg.get('price') or 0.0):.2f}"
                seg = str(leg.get("exchange_segment") or "nse_fo")
                prod = str(leg.get("product") or "NRML")

                payload = {
                    "jData": json.dumps({
                        "brkName": "KOTAK",
                        "brnchId": "ONLINE",
                        "exSeg": seg,
                        "prc": price,
                        "prcTp": "L" if float(price) > 0 else "MKT",
                        "prod": prod,
                        "qty": qty,
                        "tok": tok,
                        "trnsTp": action
                    })
                }

                r = requests.post(url, headers=self.get_auth_headers(), data=payload, timeout=6)
                if r.status_code == 200:
                    resp_json = r.json()
                    data = resp_json.get("data") if isinstance(resp_json, dict) else {}
                    if isinstance(data, list) and len(data) > 0:
                        data = data[0]
                    if not isinstance(data, dict):
                        data = resp_json if isinstance(resp_json, dict) else {}

                    req_mrgn = float(data.get("reqdMrgn") or data.get("ordMrgn") or 0.0)
                    total_broker_margin += req_mrgn

                    if data.get("avlMrgn") is not None:
                        broker_avail_margin = float(data.get("avlMrgn") or 0.0)
                    if data.get("avlCash") is not None:
                        broker_avail_cash = float(data.get("avlCash") or 0.0)

                    results.append({
                        "token": tok,
                        "symbol": leg.get("trading_symbol", ""),
                        "action": action,
                        "reqd_margin": req_mrgn,
                        "raw": data
                    })
            except Exception as e:
                logger.warning(f"Error checking margin on Kotak for leg {leg}: {e}")

        return {
            "is_connected": True,
            "broker_total_margin": round(total_broker_margin, 2),
            "broker_available_margin": broker_avail_margin,
            "broker_available_cash": broker_avail_cash,
            "leg_details": results
        }

    def get_positions(self) -> List[Dict[str, Any]]:
        """Fetches live broker open/closed positions"""
        if not self.is_connected or not self.trade_token:
            return []
        try:
            url = f"{self.base_url}quick/user/positions"
            r = requests.get(url, headers=self.get_auth_headers(), timeout=8)
            if r.status_code == 200:
                res = r.json()
                return res.get("data", [])
        except Exception as e:
            logger.error(f"Error fetching positions: {e}")
        return []

    def get_instrument_ltp(self, exchange_segment: str, token: str, symbol: Optional[str] = None) -> float:
        """Fetches live LTP for any instrument from Kotak quote API trying both token and symbol"""
        if not self.is_connected or not self.trade_token:
            return 0.0
        
        targets = []
        if token:
            targets.append(f"{exchange_segment}|{token}")
        if symbol:
            targets.append(f"{exchange_segment}|{symbol}")
            clean_sym = symbol.replace("-EQ", "").replace("-BE", "").strip()
            if clean_sym != symbol:
                targets.append(f"{exchange_segment}|{clean_sym}")

        import urllib.parse
        for target in targets:
            neo_symbol = urllib.parse.quote(target)
            for endpoint in [f"script-details/1.0/quotes/neosymbol/{neo_symbol}/ltp", f"script-details/1.0/quotes/neosymbol/{neo_symbol}"]:
                try:
                    url = f"{self.base_url}{endpoint}"
                    r = requests.get(url, headers=self.get_auth_headers(is_quote=True), timeout=3.5)
                    if r.status_code == 200:
                        data = r.json()
                        ltp_val = None
                        if isinstance(data, list) and len(data) > 0:
                            first = data[0]
                            ltp_val = first.get("ltp") or first.get("lastPrice") or first.get("lp") or first.get("close")
                        elif isinstance(data, dict):
                            data_arr = data.get("data") or data.get("result")
                            if isinstance(data_arr, list) and len(data_arr) > 0:
                                ltp_val = data_arr[0].get("ltp") or data_arr[0].get("lastPrice")
                            else:
                                ltp_val = data.get("ltp") or data.get("lastPrice")
                        if ltp_val and float(ltp_val) > 0:
                            return float(ltp_val)
                except Exception:
                    continue
        return 0.0

    def get_order_book(self) -> List[Dict[str, Any]]:
        """Fetches live order book from Kotak Neo API"""
        if not self.is_connected or not self.trade_token:
            return []
        for url in [
            f"{self.base_url}quick/user/orders?sId={self.trade_sid}",
            f"{self.base_url}quick/user/orders"
        ]:
            try:
                r = requests.get(url, headers=self.get_auth_headers(), timeout=6)
                if r.status_code == 200:
                    res = r.json()
                    data = res.get("data") if isinstance(res, dict) else res
                    if isinstance(data, list):
                        return data
            except Exception as e:
                logger.error(f"Error fetching order book from {url}: {e}")
        return []

    def get_trade_book(self) -> List[Dict[str, Any]]:
        """Fetches live trade book from Kotak Neo API"""
        if not self.is_connected or not self.trade_token:
            return []
        for url in [
            f"{self.base_url}quick/user/trades?sId={self.trade_sid}",
            f"{self.base_url}quick/user/trades"
        ]:
            try:
                r = requests.get(url, headers=self.get_auth_headers(), timeout=6)
                if r.status_code == 200:
                    res = r.json()
                    data = res.get("data") if isinstance(res, dict) else res
                    if isinstance(data, list):
                        return data
            except Exception as e:
                logger.error(f"Error fetching trade book from {url}: {e}")
        return []

    def get_order_history(self, order_id: str) -> List[Dict[str, Any]]:
        """Fetches execution trail / order status history for a specific order from Kotak Neo API"""
        if not self.is_connected or not self.trade_token or not order_id:
            return []
        for url in [
            f"{self.base_url}quick/order/history?nOrdNo={order_id}&sId={self.trade_sid}",
            f"{self.base_url}quick/order/history?nOrdNo={order_id}"
        ]:
            try:
                r = requests.get(url, headers=self.get_auth_headers(), timeout=6)
                if r.status_code == 200:
                    res = r.json()
                    data = res.get("data") if isinstance(res, dict) else res
                    if isinstance(data, list):
                        return data
                    elif isinstance(data, dict):
                        return [data]
            except Exception as e:
                logger.warning(f"Error fetching order history for {order_id} from {url}: {e}")
        return []

    def get_order_fill_price(
        self,
        order_id: str,
        symbol: Optional[str] = None,
        action: Optional[str] = None
    ) -> Optional[float]:
        """
        Retrieves the exact executed fill price from Kotak Neo for an order.
        Searches:
        1. Order History API (quick/order/history?nOrdNo=...)
        2. Order Book API (quick/user/orders)
        3. Trade Book API (quick/user/trades)
        4. Positions API (quick/user/positions)
        """
        if not order_id:
            return None

        clean_oid = str(order_id).strip()

        def _extract_price(item: Dict[str, Any]) -> Optional[float]:
            if not isinstance(item, dict):
                return None
            for k in ["avgPrc", "avgPrice", "flPr", "flPrc", "trdPrice", "fldPrc"]:
                val = item.get(k)
                if val is not None:
                    try:
                        p = float(val)
                        if p > 0:
                            return round(p, 2)
                    except (ValueError, TypeError):
                        pass

            stat = str(item.get("ordSt") or item.get("stat") or item.get("status") or "").lower()
            fl_qty = 0.0
            for q_key in ["flQty", "trdQty", "fldQty", "qty"]:
                try:
                    if item.get(q_key) is not None:
                        fl_qty = float(item[q_key])
                        break
                except (ValueError, TypeError):
                    pass

            if fl_qty > 0 or any(s in stat for s in ["trad", "complete", "executed"]):
                for k in ["prc", "price"]:
                    val = item.get(k)
                    if val is not None:
                        try:
                            p = float(val)
                            if p > 0:
                                return round(p, 2)
                        except (ValueError, TypeError):
                            pass
            return None

        # 1. Try Order History
        history = self.get_order_history(clean_oid)
        for h in history:
            p = _extract_price(h)
            if p:
                logger.info(f"Retrieved fill price {p} for order #{clean_oid} from Order History")
                return p

        # 2. Try Order Book
        orders = self.get_order_book()
        for o in orders:
            item_oid = str(o.get("nOrdNo") or o.get("ordId") or o.get("orderId") or "").strip()
            if item_oid == clean_oid:
                p = _extract_price(o)
                if p:
                    logger.info(f"Retrieved fill price {p} for order #{clean_oid} from Order Book")
                    return p

        # 3. Try Trade Book
        trades = self.get_trade_book()
        for t in trades:
            item_oid = str(t.get("nOrdNo") or t.get("ordId") or t.get("orderId") or "").strip()
            if item_oid == clean_oid:
                p = _extract_price(t)
                if p:
                    logger.info(f"Retrieved fill price {p} for order #{clean_oid} from Trade Book")
                    return p

        # 4. Try Positions by symbol if available
        if symbol:
            clean_sym = symbol.strip().upper()
            positions = self.get_positions()
            for pos in positions:
                pos_sym = str(pos.get("trdSym") or pos.get("sym") or pos.get("symbol") or "").strip().upper()
                if pos_sym == clean_sym or (clean_sym and clean_sym in pos_sym):
                    is_buy = str(action or "").upper().startswith("B")
                    price_keys = ["buyAvgPrc", "buyPrc", "bAvgPrc", "avgBuyPrice"] if is_buy else ["sellAvgPrc", "sellPrc", "sAvgPrc", "avgSellPrice"]
                    for k in price_keys + ["avgPrc", "flPr"]:
                        val = pos.get(k)
                        if val is not None:
                            try:
                                p = float(val)
                                if p > 0:
                                    logger.info(f"Retrieved fill price {p} for {clean_sym} from Positions Book")
                                    return round(p, 2)
                            except (ValueError, TypeError):
                                pass

        return None

    def sync_strategy_fill_prices(self, strategy_id: int) -> Dict[str, Any]:
        """
        Synchronizes actual execution fill prices from Kotak Neo for all legs of a strategy:
        1. Queries each leg's order_id via Kotak API.
        2. Updates strategy_legs.entry_price with the actual broker executed price.
        3. Recalculates net_premium, max_profit, max_loss, breakevens, and risk_reward.
        4. Persists the updated metrics to SQLite and refreshes active strategies cache.
        """
        from backend.database import get_db
        from backend.instrument_master import InstrumentMaster
        from backend.market_engine import market_engine

        master = InstrumentMaster.get_instance()
        updated_legs = []

        try:
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    SELECT id, strategy_id, instrument_token, trading_symbol, strike, option_type, action,
                           quantity, entry_price, order_id, execution_status
                    FROM strategy_legs
                    WHERE strategy_id = ?
                """, (strategy_id,))
                legs = [dict(r) for r in cursor.fetchall()]

                if not legs:
                    return {"status": "error", "message": f"No legs found for strategy {strategy_id}"}

                legs_changed = False
                for leg in legs:
                    oid = leg.get("order_id")
                    if oid:
                        fill_price = self.get_order_fill_price(oid, leg.get("trading_symbol"), leg.get("action"))
                        if fill_price and fill_price > 0:
                            if abs(float(leg.get("entry_price") or 0.0) - fill_price) > 0.001:
                                legs_changed = True
                                leg["entry_price"] = fill_price
                                leg["price"] = fill_price
                                cursor.execute("""
                                    UPDATE strategy_legs
                                    SET entry_price = ?, execution_status = 'TRADED'
                                    WHERE id = ?
                                """, (fill_price, leg["id"]))
                                logger.info(f"Updated leg #{leg['id']} ({leg['trading_symbol']}) fill price to {fill_price}")
                            updated_legs.append({"leg_id": leg["id"], "symbol": leg["trading_symbol"], "fill_price": fill_price})

                    # Sync exit fill price if exit_order_id exists
                    exit_oid = leg.get("exit_order_id")
                    if exit_oid:
                        exit_act = "BUY" if str(leg.get("action") or "").upper().startswith("S") else "SELL"
                        exit_fill = self.get_order_fill_price(exit_oid, leg.get("trading_symbol"), exit_act)
                        if exit_fill and exit_fill > 0:
                            leg["exit_price"] = exit_fill
                            cursor.execute("""
                                UPDATE strategy_legs
                                SET exit_price = ?
                                WHERE id = ?
                            """, (exit_fill, leg["id"]))
                            logger.info(f"Updated leg #{leg['id']} ({leg['trading_symbol']}) exit fill price to {exit_fill}")

                # Compute updated net_premium and payoff metrics / realized PnL
                cursor.execute("SELECT status, entry_index_price, strategy_type FROM strategies WHERE id = ?", (strategy_id,))
                strat_row = cursor.fetchone()
                strat_status = strat_row["status"] if strat_row else "ACTIVE"
                spot = (strat_row["entry_index_price"] if strat_row and strat_row["entry_index_price"] else (market_engine.nifty_spot or 25100.0))

                payoff = master.compute_payoff_profile(legs, spot)
                new_net_prem = payoff.get("net_premium", 0.0)
                new_max_profit = payoff.get("max_profit")
                new_max_loss = payoff.get("max_loss")
                new_be_low = payoff.get("breakeven_low")
                new_be_high = payoff.get("breakeven_high")
                new_rr = payoff.get("risk_reward")

                # If strategy is closed or triggered SL, compute exact realized PnL
                if strat_status in ["CLOSED", "TRIGGERED_SL"]:
                    total_realized_pnl = 0.0
                    for leg in legs:
                        en_p = float(leg.get("entry_price") or 0.0)
                        ex_p = float(leg.get("exit_price") or 0.0)
                        qty = abs(int(leg.get("quantity") or 0))
                        is_buy = str(leg.get("action") or "").upper().startswith("B")
                        if ex_p > 0 and en_p > 0:
                            total_realized_pnl += ((ex_p - en_p) * qty if is_buy else (en_p - ex_p) * qty)
                    
                    cursor.execute("""
                        UPDATE strategies
                        SET realized_pnl = ?, net_premium = ?
                        WHERE id = ?
                    """, (round(total_realized_pnl, 2), new_net_prem, strategy_id))
                else:
                    cursor.execute("""
                        UPDATE strategies
                        SET net_premium = ?, max_profit = ?, max_loss = ?,
                            breakeven_low = ?, breakeven_high = ?, risk_reward = ?
                        WHERE id = ?
                    """, (new_net_prem, new_max_profit, new_max_loss, new_be_low, new_be_high, new_rr, strategy_id))
                conn.commit()

            # Refresh market engine active strategies cache
            market_engine.reload_active_strategies()

            return {
                "status": "success",
                "strategy_id": strategy_id,
                "legs_updated": len(updated_legs),
                "legs": updated_legs,
                "max_profit": new_max_profit,
                "max_loss": new_max_loss,
                "breakeven_low": new_be_low,
                "breakeven_high": new_be_high,
                "risk_reward": new_rr,
                "net_premium": new_net_prem
            }
        except Exception as e:
            logger.error(f"Error in sync_strategy_fill_prices for strategy {strategy_id}: {e}")
            return {"status": "error", "message": str(e)}

    def log_order_to_db(
        self,
        strategy_id: Optional[int],
        symbol: str,
        segment: str,
        trans_type: str,
        qty: int,
        price: float,
        trigger_price: float,
        order_type: str,
        product: str,
        tag: str,
        token: str,
        is_amo: str,
        sent_payload: str,
        received_response: str,
        http_status: int,
        latency_ms: int,
        status: str,
        order_id: Optional[str],
        error_message: Optional[str]
    ):
        """SEBI Mandated Log Keeping: Stores full details of every order request and broker response."""
        try:
            with get_db() as conn:
                conn.execute("""
                    INSERT INTO order_logs
                    (user_id, strategy_id, timestamp, trading_symbol, exchange_segment, transaction_type, 
                     quantity, price, trigger_price, order_type, product, tag, token, is_amo, 
                     sent_payload, received_response, http_status, latency_ms, status, order_id, error_message)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    self.user_id, strategy_id, datetime.now().isoformat(), symbol, segment, trans_type,
                    qty, price, trigger_price, order_type, product, tag, token, is_amo,
                    sent_payload, received_response, http_status, latency_ms, status, order_id, error_message
                ))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to write SEBI order log to database: {e}")

    def place_order_leg(
        self,
        leg: Dict[str, Any],
        strategy_id: Optional[int] = None,
        is_exit: bool = False
    ) -> Dict[str, Any]:
        """
        Places live order on Kotak Neo API with SEBI-compliant order logging,
        intelligent Market-to-Limit fallback for after-hours/weekends, and token verification.
        """
        if not self.is_connected or not self.trade_token:
            return {
                "status": "error",
                "order_id": None,
                "message": "Cannot place order: Kotak Neo API is not connected. Please log in.",
                "trading_symbol": leg.get("trading_symbol", "")
            }

        if self.is_session_expired():
            self.clear_ram_session()
            return {
                "status": "error",
                "order_id": None,
                "message": "Kotak Neo session has expired for the day (11:50 PM cutoff). Please log in fresh.",
                "trading_symbol": leg.get("trading_symbol", "")
            }

        from backend.instrument_master import InstrumentMaster
        master = InstrumentMaster.get_instance()

        trans_type = "B" if leg.get("action", "").upper().startswith("B") else "S"
        qty = abs(int(leg.get("quantity", 1)))
        symbol = leg.get("trading_symbol", "").strip()
        token = str(leg.get("token") or "").strip()
        raw_order_type = str(leg.get("order_type") or "MKT").strip().upper()
        if raw_order_type in ["M", "MARKET", "MKT"]:
            requested_order_type = "MKT"
        elif raw_order_type in ["L", "LIMIT"]:
            requested_order_type = "L"
        else:
            requested_order_type = raw_order_type
        raw_price = float(leg.get("price") or 0.0)
        trigger_price = float(leg.get("trigger_price") or 0.0)

        # Generate guaranteed unique Client Order ID (ig) to prevent Kotak RMS "Client OrderID already exists"
        import uuid
        salt = uuid.uuid4().hex[:5]
        custom_tag = leg.get("tag")
        if custom_tag:
            clean_tag = "".join(c for c in str(custom_tag) if c.isalnum() or c == "_")[:12]
            tag = f"{clean_tag}_{salt}"
        elif strategy_id:
            tag_type = "X" if is_exit else "E"
            tok_short = token[-4:] if token else (symbol[-4:] if symbol else "0000")
            tag = f"{tag_type}{strategy_id}_{trans_type}{tok_short}_{salt}"
        else:
            tok_short = token[-4:] if token else "0000"
            tag = f"KNT_{trans_type}{tok_short}_{salt}"

        # Resolve ITC test share or Cash Market instruments
        if symbol.upper() in ["ITC", "ITC-EQ"] or token == "1660":
            symbol = "ITC-EQ"
            token = "1660"
            exchange_segment = "nse_cm"
            product = leg.get("product") or "CNC"
        else:
            exchange_segment = leg.get("exchange_segment", "nse_fo")
            product = leg.get("product", "NRML")

        # Auto-resolve token and trading symbol for options if missing but strike/type given
        if (not token or not symbol) and leg.get("strike") and leg.get("option_type"):
            inst = master.resolve_option(leg["strike"], leg["option_type"], leg.get("expiry"))
            if inst:
                token = inst.token
                symbol = inst.trading_symbol
                leg["token"] = token
                leg["trading_symbol"] = symbol

        # Kotak Neo Order Routing: Market (MKT) and Limit (L using live quote)
        active_order_type = requested_order_type
        effective_price = raw_price

        if active_order_type in ["L", "SL"]:
            if effective_price <= 0:
                quote_ltp = self.get_instrument_ltp(exchange_segment, token, symbol)
                if quote_ltp > 0:
                    effective_price = quote_ltp
                else:
                    effective_price = float(leg.get("entry_price") or 100.0)
            effective_price = round(round(effective_price / 0.05) * 0.05, 2)
            price_str = f"{effective_price:.2f}"
        else:
            price_str = "0"

        tp_val = round(round(trigger_price / 0.05) * 0.05, 2) if trigger_price > 0 else 0.0

        def _do_send_order(o_type: str, prc_str: str):
            inner = {
                "am": "NO",
                "dq": "0",
                "es": exchange_segment,
                "mp": "0",
                "pc": product,
                "pf": "N",
                "pr": prc_str,
                "pt": o_type,
                "qt": str(qty),
                "rt": "DAY",
                "tp": f"{tp_val:.2f}" if o_type in ["SL", "SL-M"] else "0",
                "ts": symbol,
                "tt": trans_type,
                "ig": tag,
                "tk": token,
                "os": "neotradeapi"
            }
            form_payload = {"jData": json.dumps(inner)}
            url = f"{self.base_url}quick/order/rule/ms/place?sId={self.trade_sid}"

            proxies = None
            import socket
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                    sock.settimeout(0.2)
                    if sock.connect_ex(("127.0.0.1", 1080)) == 0:
                        proxies = {"http": "socks5://127.0.0.1:1080", "https": "socks5://127.0.0.1:1080"}
            except Exception:
                pass

            t0 = time.time()
            resp = requests.post(url, headers=self.get_auth_headers(), data=form_payload, timeout=12, proxies=proxies)
            lat_ms = int((time.time() - t0) * 1000)
            return inner, form_payload, resp, lat_ms

        logger.info(f"Submitting Kotak Order: {symbol} ({trans_type} {qty} @ {price_str}, Type: {active_order_type}, Seg: {exchange_segment})...")
        inner_payload, form_data, r, latency_ms = _do_send_order(active_order_type, price_str)

        try:
            res = r.json()
        except Exception:
            res = {"raw": r.text}

        data = res.get("data", {}) if isinstance(res, dict) and isinstance(res.get("data"), dict) else (res if isinstance(res, dict) else {})
        order_id = data.get("nOrdNo") or res.get("order_id") or data.get("order_id") or res.get("nOrdNo") or res.get("ordNo")
        stat = str(res.get("stat") or res.get("success") or res.get("stCode") or "").lower()

        err_msg = res.get("errMsg") or res.get("message") or data.get("errMsg") or res.get("error") or ""
        if isinstance(err_msg, list) and len(err_msg) > 0:
            err_msg = err_msg[0].get("message") if isinstance(err_msg[0], dict) else str(err_msg[0])
        err_msg = str(err_msg).strip()

        # If Kotak RMS rejected because Market order LTP was unavailable, automatically retry as Limit order with live quote LTP
        if not order_id and ("Last Traded Price" in err_msg or "limit order" in err_msg.lower()) and active_order_type != "L":
            logger.info("Kotak RMS requested limit order instead of market order. Retrying as Limit order with live quote LTP...")
            quote_ltp = self.get_instrument_ltp(exchange_segment, token, symbol)
            if quote_ltp > 0:
                active_order_type = "L"
                quote_ltp = round(round(quote_ltp / 0.05) * 0.05, 2)
                price_str = f"{quote_ltp:.2f}"
                inner_payload, form_data, r, latency_ms = _do_send_order(active_order_type, price_str)
                try:
                    res = r.json()
                except Exception:
                    res = {"raw": r.text}
                data = res.get("data", {}) if isinstance(res, dict) and isinstance(res.get("data"), dict) else (res if isinstance(res, dict) else {})
                order_id = data.get("nOrdNo") or res.get("order_id") or data.get("order_id") or res.get("nOrdNo") or res.get("ordNo")
                stat = str(res.get("stat") or res.get("success") or res.get("stCode") or "").lower()
                err_msg = res.get("errMsg") or res.get("message") or data.get("errMsg") or res.get("error") or ""
                if isinstance(err_msg, list) and len(err_msg) > 0:
                    err_msg = err_msg[0].get("message") if isinstance(err_msg[0], dict) else str(err_msg[0])
                err_msg = str(err_msg).strip()

        is_success = bool(order_id and stat not in ["not_ok", "false", "1011", "1012"])
        status_str = "SUCCESS" if is_success else "REJECTED"

        # SEBI MANDATED AUDIT LOGGING: Persist all parameters and broker response to SQLite
        self.log_order_to_db(
            strategy_id=strategy_id,
            symbol=symbol,
            segment=exchange_segment,
            trans_type=trans_type,
            qty=qty,
            price=float(price_str),
            trigger_price=trigger_price,
            order_type=active_order_type,
            product=product,
            tag=tag,
            token=token,
            is_amo="NO",
            sent_payload=json.dumps(inner_payload),
            received_response=r.text,
            http_status=r.status_code,
            latency_ms=latency_ms,
            status=status_str,
            order_id=str(order_id) if order_id else None,
            error_message=err_msg if not is_success else None
        )

        leg_id = leg.get("leg_id")
        full_action = "BUY" if trans_type == "B" else "SELL"
        if is_success:
            logger.info(f"✔ Kotak Order SUCCESS: #{order_id} for {symbol} ({trans_type} {qty} @ {price_str}) [{latency_ms} ms]")
            return {
                "status": "success",
                "leg_id": leg_id,
                "order_id": str(order_id),
                "trading_symbol": symbol,
                "token": token,
                "action": full_action,
                "trans_type": trans_type,
                "quantity": qty,
                "price": price_str,
                "order_type": active_order_type,
                "product": product,
                "exchange_segment": exchange_segment,
                "latency_ms": latency_ms,
                "message": f"Order #{order_id} placed successfully for {symbol}"
            }
        else:
            final_err = err_msg or "Order rejected by broker RMS"
            logger.error(f"❌ Kotak RMS Order Rejection: {final_err} (HTTP {r.status_code})")
            return {
                "status": "error",
                "leg_id": leg_id,
                "order_id": None,
                "message": final_err,
                "trading_symbol": symbol,
                "token": token,
                "action": full_action,
                "trans_type": trans_type,
                "quantity": qty,
                "price": price_str,
                "order_type": active_order_type,
                "http_status": r.status_code,
                "latency_ms": latency_ms
            }

    def execute_multi_leg_strategy(
        self,
        legs: List[Dict[str, Any]],
        is_exit: bool = False,
        strategy_id: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """
        Executes spread/condor legs with strict margin sequencing and saves broker order IDs:
        - When ENTERING:
            1. Place BUY (hedge) legs first to get exchange margin reduction.
            2. Place SELL legs after BUY legs are acknowledged.
        - When EXITING (e.g. Stop-Loss Trigger):
            1. Place BUY (cover short positions) legs first to remove margin deficit.
            2. Place SELL (exit hedge positions) legs second.
        Records every order ID to strategy_legs and logs SEBI audit records.
        """
        buy_legs = [l for l in legs if l.get("action", "").upper().startswith("B")]
        sell_legs = [l for l in legs if l.get("action", "").upper().startswith("S")]

        ordered_legs = (buy_legs + sell_legs) if not is_exit else (buy_legs + sell_legs)
        results = []

        all_success = True
        has_success = False

        for leg in ordered_legs:
            res = self.place_order_leg(leg, strategy_id=strategy_id, is_exit=is_exit)
            results.append(res)
            
            # If strategy_id is provided, record the broker order ID and status in SQLite
            leg_id = leg.get("leg_id") or res.get("leg_id")
            if strategy_id:
                try:
                    with get_db() as conn:
                        act_val = res.get("action") or ("BUY" if str(res.get("trans_type") or "").upper().startswith("B") else "SELL")
                        stat_text = "SUCCESS" if res.get("status") == "success" else "REJECTED"
                        msg_text = res.get("message") or (f"Order #{res.get('order_id')} placed" if res.get("order_id") else "Order rejected")
                        
                        if not is_exit:
                            if leg_id:
                                conn.execute("""
                                    UPDATE strategy_legs
                                    SET order_id = ?, execution_status = ?, execution_message = ?, executed_at = ?
                                    WHERE id = ?
                                """, (
                                    res.get("order_id"),
                                    stat_text,
                                    msg_text,
                                    datetime.now().isoformat(),
                                    leg_id
                                ))
                            else:
                                conn.execute("""
                                    UPDATE strategy_legs
                                    SET order_id = ?, execution_status = ?, execution_message = ?, executed_at = ?
                                    WHERE strategy_id = ? AND trading_symbol = ? AND (action = ? OR action LIKE ?)
                                """, (
                                    res.get("order_id"),
                                    stat_text,
                                    msg_text,
                                    datetime.now().isoformat(),
                                    strategy_id,
                                    res.get("trading_symbol"),
                                    act_val,
                                    f"{res.get('trans_type') or act_val[:1]}%"
                                ))
                        else:
                            if leg_id:
                                conn.execute("""
                                    UPDATE strategy_legs
                                    SET exit_order_id = ?, exit_executed_at = ?
                                    WHERE id = ?
                                """, (
                                    res.get("order_id"),
                                    datetime.now().isoformat(),
                                    leg_id
                                ))
                            else:
                                conn.execute("""
                                    UPDATE strategy_legs
                                    SET exit_order_id = ?, exit_executed_at = ?
                                    WHERE strategy_id = ? AND trading_symbol = ?
                                """, (
                                    res.get("order_id"),
                                    datetime.now().isoformat(),
                                    strategy_id,
                                    res.get("trading_symbol")
                                ))
                        conn.commit()
                except Exception as e:
                    logger.error(f"Failed to update strategy_legs order ID: {e}")

            if res.get("status") == "success":
                has_success = True
            else:
                all_success = False

            time.sleep(0.08)

        # Update overall strategy order_status
        if strategy_id:
            try:
                if is_exit:
                    order_stat = "EXIT_PLACED" if all_success else ("PARTIAL_EXIT" if has_success else "EXIT_REJECTED")
                else:
                    order_stat = "ALL_PLACED" if all_success else ("PARTIAL_PLACED" if has_success else "ALL_REJECTED")
                with get_db() as conn:
                    conn.execute("UPDATE strategies SET order_status = ? WHERE id = ?", (order_stat, strategy_id))
                    conn.commit()
            except Exception as e:
                logger.error(f"Failed to update strategy order_status: {e}")

        return results
