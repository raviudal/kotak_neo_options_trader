import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = DATA_DIR / "trading.db"

# JWT Secret & Expiry
SECRET_KEY = os.getenv("APP_SECRET_KEY", "kotak-neo-nifty-options-secure-key-2026-v1")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 60 * 24))  # 24 hours

# Kotak Neo Environment ('prod' or 'sandbox')
KOTAK_ENV = os.getenv("KOTAK_ENV", "prod")

# Seed default admin user on first launch if enabled
ADMIN_SEED = os.getenv("ADMIN_SEED", "true").lower() in ("true", "1", "yes")
DEFAULT_ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "trader")
DEFAULT_ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "TradeSafe@2026")

# Optional Kotak Neo Pre-fill credentials from environment variables
KOTAK_CONSUMER_KEY = os.getenv("KOTAK_CONSUMER_KEY", "")
KOTAK_MOBILE_NUMBER = os.getenv("KOTAK_MOBILE_NUMBER", "")
KOTAK_UCC = os.getenv("KOTAK_UCC", "")
