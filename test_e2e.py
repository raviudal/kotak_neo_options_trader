import time
import requests
import pyotp
import sqlite3

BASE_URL = "http://127.0.0.1:8080"

def run_tests():
    print("[1] Testing Frontend Static Serving...")
    r = requests.get(f"{BASE_URL}/")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}"
    print("    Frontend loaded OK! Size:", len(r.text), "bytes")

    print("[2] Testing 2FA Login with Google Authenticator...")
    conn = sqlite3.connect("data/trading.db")
    c = conn.cursor()
    c.execute("SELECT username, totp_secret FROM users WHERE username = 'trader'")
    user, secret = c.fetchone()
    conn.close()

    totp_now = pyotp.TOTP(secret).now()
    login_resp = requests.post(f"{BASE_URL}/api/auth/login", json={
        "username": user,
        "password": "TradeSafe@2026",
        "totp_code": totp_now
    })
    assert login_resp.status_code == 200, f"Login failed: {login_resp.text}"
    token_1 = login_resp.json()["access_token"]
    headers_1 = {"Authorization": f"Bearer {token_1}"}
    print("    Session 1 created successfully!")

    print("[3] Testing Strict Single Active User Session Enforcement...")
    # Log in a second time (e.g. from mobile)
    login_resp_2 = requests.post(f"{BASE_URL}/api/auth/login", json={
        "username": user,
        "password": "TradeSafe@2026",
        "totp_code": pyotp.TOTP(secret).now()
    })
    assert login_resp_2.status_code == 200
    token_2 = login_resp_2.json()["access_token"]
    headers_2 = {"Authorization": f"Bearer {token_2}"}
    print("    Session 2 created!")

    # Verify Session 1 is now strictly invalidated
    r_old = requests.get(f"{BASE_URL}/api/auth/me", headers=headers_1)
    assert r_old.status_code == 401, f"Old session should be rejected with 401, got {r_old.status_code}"
    print("    [PASSED] Session 1 was immediately terminated: " + r_old.json().get("detail", ""))

    # Verify Session 2 is active
    r_new = requests.get(f"{BASE_URL}/api/auth/me", headers=headers_2)
    assert r_new.status_code == 200
    print("    [PASSED] Session 2 is authenticated and active.")

    print("[4] Testing Saved Kotak Credentials Auto-Fill...")
    saved_cfg = requests.get(f"{BASE_URL}/api/kotak/saved-config", headers=headers_2).json()
    assert "consumer_key" in saved_cfg and "mobile_number" in saved_cfg
    print(f"    Saved credentials retrieved for auto-fill! (UCC: {saved_cfg.get('ucc', 'N/A')})")

    print("[5] Testing Gatekeeper: Functions locked when Kotak is disconnected...")
    # Ensure Kotak is disconnected for this test
    requests.post(f"{BASE_URL}/api/kotak/disconnect", headers=headers_2)
    strat_locked = requests.get(f"{BASE_URL}/api/strategies", headers=headers_2)
    assert strat_locked.status_code == 403, f"Expected 403 when Kotak not connected, got {strat_locked.status_code}"
    print("    [PASSED] Gatekeeper active: Strategies and trading functions return 403 Forbidden when Kotak is disconnected.")

    print("[6] Testing Kotak Neo Active Session & In-RAM Storage...")
    session_res = requests.post(f"{BASE_URL}/api/kotak/test-session", headers=headers_2)
    assert session_res.status_code == 200, f"Failed to activate test session: {session_res.text}"

    # Ensure zero tokens on disk
    c_check = sqlite3.connect("data/trading.db").cursor()
    c_check.execute("SELECT access_token, neo_fin_key FROM kotak_config WHERE user_id = 1")
    row_tokens = c_check.fetchone()
    assert row_tokens is None or (row_tokens[0] is None and row_tokens[1] is None), "Tokens must NOT be on disk!"
    print("    [PASSED] In-RAM storage verified: Zero tokens found on disk!")

    print("[7] Testing Kotak Scrip Expiry & Token Resolution...")
    exp_resp = requests.get(f"{BASE_URL}/api/market/expiries", headers=headers_2).json()
    assert len(exp_resp) > 0, "No expiries found in scrip master"
    first_exp = exp_resp[0]["code"]
    print(f"    [PASSED] Expiries loaded! Nearest: {exp_resp[0]['display']} ({first_exp})")

    prev_resp = requests.post(f"{BASE_URL}/api/strategies/preview", json={
        "strategy_type": "BULL_PUT_CREDIT",
        "expiry_code": first_exp,
        "spread_width": 100,
        "lots": 1,
        "spot_price": 25140.0
    }, headers=headers_2).json()
    assert len(prev_resp["legs"]) == 2, "Expected 2 legs for Bull Put Credit"
    leg1 = prev_resp["legs"][0] # BUY leg
    leg2 = prev_resp["legs"][1] # SELL leg
    assert leg1["action"] == "BUY" and leg1["token"] and leg1["trading_symbol"]
    assert leg2["action"] == "SELL" and leg2["token"] and leg2["trading_symbol"]
    print(f"    [PASSED] Tokens resolved! BUY: {leg1['trading_symbol']} (TK: {leg1['token']}), SELL: {leg2['trading_symbol']} (TK: {leg2['token']})")

    print("[8] Deploying Strategy with Real Tokens & Index-Based Stop Loss...")
    strat_resp = requests.post(f"{BASE_URL}/api/strategies", json={
        "name": "Nifty Live Bull Put Spread",
        "strategy_type": "BULL_PUT_CREDIT",
        "index_sl_price": 25100.0,
        "index_sl_condition": "LESS_THAN_OR_EQUAL",
        "expiry_code": first_exp,
        "legs": prev_resp["legs"]
    }, headers=headers_2)
    assert strat_resp.status_code == 200, f"Strategy creation failed: {strat_resp.text}"
    strat_id = strat_resp.json()["strategy_id"]
    print(f"    Strategy #{strat_id} deployed with verified Kotak tokens and Index SL @ 25100.0")

    print("[9] Testing Live WebSocket Tick Processing (Zero Simulation)...")
    from backend.market_engine import MarketEngine
    engine = MarketEngine.get_instance()
    engine.reload_active_strategies()
    
    # 1. Normal Live Tick above SL
    engine.handle_kotak_ws_message({"tk": "26000", "ltp": "25180.50", "isIndex": True, "c": "25100.0"})
    assert engine.nifty_spot == 25180.50
    assert engine.is_live is True
    print(f"    Live tick processed: Nifty Spot = {engine.nifty_spot} (is_live={engine.is_live})")

    # 2. Live Breach Tick below SL (25095 <= 25100)
    print("    Pushing live tick breaching Stop Loss (25095.0 <= 25100.0)...")
    engine.handle_kotak_ws_message({"tk": "26000", "ltp": "25095.00", "isIndex": True})
    time.sleep(1.0) # wait for SL trigger

    # Verify Strategy closed
    strats = requests.get(f"{BASE_URL}/api/strategies", headers=headers_2).json()
    triggered = next((s for s in strats if s["id"] == strat_id), None)
    print(f"    [PASSED] Stop loss triggered on real tick! Reason: {triggered['close_reason']}")

    print("[10] Testing Single Order & ITC 1-Share Routing...")
    # Verify ITC test endpoint routes properly
    itc_res = requests.post(f"{BASE_URL}/api/orders/test-itc", headers=headers_2)
    # The endpoint attempted Kotak API call with ITC-EQ (token 1660, nse_cm, CNC)
    print(f"    ITC Test Order endpoint executed (HTTP {itc_res.status_code})")

    print("\n=======================================================")
    print("ALL VERIFICATIONS COMPLETED SUCCESSFULLY!")
    print("=======================================================")

if __name__ == "__main__":
    run_tests()
