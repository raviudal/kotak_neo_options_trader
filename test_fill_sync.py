import os
import sqlite3
from backend.database import get_db, init_db
from backend.market_engine import market_engine
from backend.instrument_master import InstrumentMaster
from backend.kotak_service import KotakNeoManager

def test_fill_and_payoff_sync():
    print("--- Testing Payoff Backfill and Fill Price Sync ---")
    init_db()

    # 1. Create a dummy active strategy with NULL max_profit and max_loss
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users LIMIT 1")
        row = cursor.fetchone()
        user_id = row["id"] if row else 1

        cursor.execute("""
            INSERT INTO strategies 
            (user_id, name, strategy_type, status, index_symbol, entry_index_price, index_sl_price, index_sl_condition, total_lots, net_premium)
            VALUES (?, ?, ?, 'ACTIVE', 'NIFTY 50', 25150.0, 25050.0, 'LESS_THAN_OR_EQUAL', 1, 0.0)
        """, (user_id, "Test Bull Call Spread", "BULL_CALL_SPREAD"))
        strat_id = cursor.lastrowid

        # Insert 2 legs with initial estimated entry price
        cursor.execute("""
            INSERT INTO strategy_legs 
            (strategy_id, instrument_token, trading_symbol, strike, option_type, action, quantity, entry_price, order_id, status)
            VALUES (?, '45001', 'NIFTY26O1925150CE', 25150.0, 'CE', 'BUY', 65, 120.0, 'ORD_TEST_BUY_123', 'OPEN')
        """, (strat_id,))
        leg1_id = cursor.lastrowid

        cursor.execute("""
            INSERT INTO strategy_legs 
            (strategy_id, instrument_token, trading_symbol, strike, option_type, action, quantity, entry_price, order_id, status)
            VALUES (?, '45002', 'NIFTY26O1925250CE', 25250.0, 'CE', 'SELL', 65, 65.0, 'ORD_TEST_SELL_456', 'OPEN')
        """, (strat_id,))
        leg2_id = cursor.lastrowid
        conn.commit()

    print(f"[1] Inserted test strategy #{strat_id} with NULL max_profit & max_loss.")

    # 2. Reload active strategies in market_engine and check auto-backfill
    market_engine.reload_active_strategies()
    active_strat = market_engine.active_strategies.get(strat_id)
    assert active_strat is not None, "Strategy not loaded into market_engine"
    print(f"[2] Reloaded active strategies. Max Profit: {active_strat.get('max_profit')}, Max Loss: {active_strat.get('max_loss')}")
    assert active_strat.get("max_profit") is not None, "max_profit should be backfilled"
    assert active_strat.get("max_loss") is not None, "max_loss should be backfilled"
    assert not (active_strat.get("max_loss") != active_strat.get("max_loss")), "max_loss should not be NaN"

    # Verify snapshot broadcast payload
    snapshot = market_engine.get_market_snapshot()
    matched_strat = next((s for s in snapshot["strategies"] if s["id"] == strat_id), None)
    assert matched_strat is not None, "Strategy missing from market snapshot"
    assert matched_strat["max_profit"] is not None, "max_profit missing from snapshot"
    assert matched_strat["max_loss"] is not None, "max_loss missing from snapshot"
    assert matched_strat["breakeven_low"] is not None, "breakeven_low missing from snapshot"
    print(f"[3] Snapshot verified: Max P: Rs.{matched_strat['max_profit']}, Max L: Rs.{matched_strat['max_loss']}, BE: {matched_strat['breakeven_low']}")

    # 3. Test Fill Price Sync with Kotak Neo Manager mock
    manager = KotakNeoManager.get_instance(user_id)
    # Mock get_order_fill_price to simulate Kotak returning exact broker trade fill prices
    def mock_get_order_fill_price(order_id, symbol=None, action=None):
        if order_id == 'ORD_TEST_BUY_123':
            return 118.50  # Real fill price was 118.50 instead of 120.0
        elif order_id == 'ORD_TEST_SELL_456':
            return 66.25  # Real fill price was 66.25 instead of 65.0
        return None

    manager.get_order_fill_price = mock_get_order_fill_price

    sync_result = manager.sync_strategy_fill_prices(strat_id)
    print(f"[4] Sync executed. Result: {sync_result}")
    assert sync_result["status"] == "success"
    assert sync_result["legs_updated"] == 2

    # Verify updated entry prices in database
    with get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT entry_price, execution_status FROM strategy_legs WHERE id = ?", (leg1_id,))
        r1 = c.fetchone()
        assert r1["entry_price"] == 118.50, f"Expected 118.50, got {r1['entry_price']}"
        assert r1["execution_status"] == "TRADED"

        c.execute("SELECT entry_price, execution_status FROM strategy_legs WHERE id = ?", (leg2_id,))
        r2 = c.fetchone()
        assert r2["entry_price"] == 66.25, f"Expected 66.25, got {r2['entry_price']}"
        assert r2["execution_status"] == "TRADED"

        # Check recalculated strategy net premium and payoff
        c.execute("SELECT max_profit, max_loss, net_premium FROM strategies WHERE id = ?", (strat_id,))
        s_row = c.fetchone()
        print(f"    Recalculated with exact fills: Net Premium: Rs.{s_row['net_premium']}, Max P: Rs.{s_row['max_profit']}, Max L: Rs.{s_row['max_loss']}")
        assert s_row["max_profit"] is not None
        assert s_row["max_loss"] is not None

        # Clean up test strategy
        c.execute("DELETE FROM strategy_legs WHERE strategy_id = ?", (strat_id,))
        c.execute("DELETE FROM strategies WHERE id = ?", (strat_id,))
        conn.commit()

    print("[PASSED] All tests passed successfully!")

if __name__ == "__main__":
    test_fill_and_payoff_sync()
