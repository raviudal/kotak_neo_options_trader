import sqlite3
import json
from datetime import datetime
from backend.config import DB_PATH

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for high performance and low lock contention
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 1. Users table (Username, Password, Google Authenticator Secret, Active Session)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            totp_secret TEXT NOT NULL,
            totp_enabled INTEGER DEFAULT 1,
            active_session_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """)
        
        # Ensure active_session_id column exists if table was created previously
        try:
            cursor.execute("ALTER TABLE users ADD COLUMN active_session_id TEXT;")
        except Exception:
            pass  # Already exists
        
        # 2. Kotak Neo Credentials & Session
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS kotak_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            consumer_key TEXT,
            consumer_secret TEXT,
            mobile_number TEXT,
            ucc TEXT,
            mpin TEXT,
            totp_secret TEXT,
            environment TEXT DEFAULT 'prod',
            is_connected INTEGER DEFAULT 0,
            last_login_at TIMESTAMP,
            access_token TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        );
        """)
        # Ensure zero session tokens exist on disk (strict RAM-only security)
        cursor.execute("UPDATE kotak_config SET access_token = NULL, neo_fin_key = NULL, is_connected = 0;")
        
        # 3. Option Strategies & Index-based SL
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS strategies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            strategy_type TEXT NOT NULL,
            status TEXT DEFAULT 'ACTIVE',
            index_symbol TEXT DEFAULT 'NIFTY 50',
            entry_index_price REAL,
            index_sl_price REAL NOT NULL,
            index_sl_condition TEXT NOT NULL,
            index_target_price REAL,
            total_lots INTEGER DEFAULT 1,
            net_premium REAL DEFAULT 0,
            realized_pnl REAL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            closed_at TIMESTAMP,
            close_reason TEXT,
            FOREIGN KEY (user_id) REFERENCES users (id)
        );
        """)
        
        # 4. Individual Strategy Legs
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS strategy_legs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id INTEGER NOT NULL,
            instrument_token TEXT NOT NULL,
            trading_symbol TEXT NOT NULL,
            strike REAL NOT NULL,
            option_type TEXT NOT NULL,
            action TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            entry_price REAL DEFAULT 0,
            exit_price REAL,
            order_id TEXT,
            status TEXT DEFAULT 'OPEN',
            FOREIGN KEY (strategy_id) REFERENCES strategies (id)
        );
        """)
        
        # 5. Activity and Audit Logs
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS activity_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            strategy_id INTEGER,
            log_level TEXT DEFAULT 'INFO',
            message TEXT NOT NULL,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """)

        # 6. SEBI-Mandated Order Audit Logs (records every sent payload and broker response)
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS order_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            strategy_id INTEGER,
            timestamp TEXT NOT NULL,
            trading_symbol TEXT NOT NULL,
            exchange_segment TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price REAL NOT NULL,
            trigger_price REAL DEFAULT 0,
            order_type TEXT NOT NULL,
            product TEXT NOT NULL,
            tag TEXT,
            token TEXT,
            is_amo TEXT DEFAULT 'NO',
            sent_payload TEXT NOT NULL,
            received_response TEXT NOT NULL,
            http_status INTEGER,
            latency_ms INTEGER,
            status TEXT NOT NULL,
            order_id TEXT,
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """)

        # Strategy and leg columns migrations
        for alter_sql in [
            "ALTER TABLE strategy_legs ADD COLUMN execution_status TEXT DEFAULT 'PENDING';",
            "ALTER TABLE strategy_legs ADD COLUMN execution_message TEXT;",
            "ALTER TABLE strategy_legs ADD COLUMN executed_at TIMESTAMP;",
            "ALTER TABLE strategy_legs ADD COLUMN exit_order_id TEXT;",
            "ALTER TABLE strategy_legs ADD COLUMN exit_executed_at TIMESTAMP;",
            "ALTER TABLE strategies ADD COLUMN order_status TEXT DEFAULT 'PENDING';",
            "ALTER TABLE strategies ADD COLUMN max_profit REAL;",
            "ALTER TABLE strategies ADD COLUMN max_loss REAL;",
            "ALTER TABLE strategies ADD COLUMN breakeven_low REAL;",
            "ALTER TABLE strategies ADD COLUMN breakeven_high REAL;",
            "ALTER TABLE strategies ADD COLUMN risk_reward TEXT;",
            "ALTER TABLE strategies ADD COLUMN hedge_distance REAL;",
            "ALTER TABLE strategies ADD COLUMN index_sl_mode TEXT DEFAULT 'LIVE';",
            "ALTER TABLE strategies ADD COLUMN candle_interval INTEGER DEFAULT 0;",
            "ALTER TABLE strategies ADD COLUMN sl_target_type TEXT DEFAULT 'INDEX';",
            "ALTER TABLE strategies ADD COLUMN strategy_sl_value REAL;",
            "ALTER TABLE kotak_config ADD COLUMN client_name TEXT;"
        ]:
            try:
                cursor.execute(alter_sql)
            except Exception:
                pass  # Already exists

        # Historical backfill: Map recorded order IDs from order_logs to strategy_legs
        try:
            cursor.execute("""
                UPDATE strategy_legs
                SET order_id = (
                    SELECT ol.order_id FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type = SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.status = 'SUCCESS'
                    ORDER BY ol.id ASC LIMIT 1
                ),
                execution_status = 'SUCCESS',
                execution_message = 'Executed on Kotak Neo'
                WHERE order_id IS NULL AND EXISTS (
                    SELECT 1 FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type = SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.status = 'SUCCESS'
                );
            """)
            cursor.execute("""
                UPDATE strategy_legs
                SET exit_order_id = (
                    SELECT ol.order_id FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type != SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.status = 'SUCCESS'
                    ORDER BY ol.id DESC LIMIT 1
                )
                WHERE exit_order_id IS NULL AND EXISTS (
                    SELECT 1 FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type != SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.status = 'SUCCESS'
                );
            """)

            # Backfill exit_price from order_logs where price > 0
            cursor.execute("""
                UPDATE strategy_legs
                SET exit_price = (
                    SELECT ol.price FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type != SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.price > 0
                    ORDER BY ol.id DESC LIMIT 1
                )
                WHERE (exit_price IS NULL OR exit_price = 0) AND EXISTS (
                    SELECT 1 FROM order_logs ol
                    WHERE ol.strategy_id = strategy_legs.strategy_id
                      AND ol.trading_symbol = strategy_legs.trading_symbol
                      AND ol.transaction_type != SUBSTR(strategy_legs.action, 1, 1)
                      AND ol.price > 0
                );
            """)

            # Compute realized_pnl for all closed/triggered strategies that have exit prices
            cursor.execute("""
                UPDATE strategies
                SET realized_pnl = (
                    SELECT ROUND(SUM(
                        CASE 
                            WHEN sl.action = 'BUY' THEN (COALESCE(sl.exit_price, 0) - COALESCE(sl.entry_price, 0)) * sl.quantity
                            ELSE (COALESCE(sl.entry_price, 0) - COALESCE(sl.exit_price, 0)) * sl.quantity
                        END
                    ), 2)
                    FROM strategy_legs sl
                    WHERE sl.strategy_id = strategies.id AND sl.exit_price IS NOT NULL
                )
                WHERE status IN ('CLOSED', 'TRIGGERED_SL') AND (realized_pnl IS NULL OR realized_pnl = 0)
                  AND EXISTS (
                      SELECT 1 FROM strategy_legs sl WHERE sl.strategy_id = strategies.id AND sl.exit_price IS NOT NULL
                  );
            """)
        except Exception:
            pass
        
        conn.commit()

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully at:", DB_PATH)
