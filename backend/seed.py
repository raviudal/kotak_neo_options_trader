import sys
import pyotp

if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

from backend.database import init_db, get_db
from backend.auth import hash_password, generate_totp_secret, get_totp_uri
from backend.config import DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD

def setup():
    init_db()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, totp_secret FROM users WHERE username = ?", (DEFAULT_ADMIN_USERNAME,))
        row = cursor.fetchone()
        if not row:
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
            print("==================================================")
            print("[SUCCESS] Default Admin User Created Successfully!")
            print(f"Username   : {DEFAULT_ADMIN_USERNAME}")
            print(f"Password   : {DEFAULT_ADMIN_PASSWORD}")
            print(f"TOTP Secret: {secret}")
            print(f"TOTP URI   : {get_totp_uri(secret, DEFAULT_ADMIN_USERNAME)}")
            print("==================================================")
        else:
            print("==================================================")
            print(f"[INFO] Admin user '{row['username']}' already exists.")
            print(f"TOTP Secret: {row['totp_secret']}")
            print(f"TOTP URI   : {get_totp_uri(row['totp_secret'], row['username'])}")
            totp = pyotp.TOTP(row['totp_secret'])
            print(f"Current Valid Code: {totp.now()}")
            print("==================================================")

if __name__ == "__main__":
    setup()
