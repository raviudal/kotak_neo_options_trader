# NeoTrader | Kotak Neo Nifty Options Engine with Live Index Stop Loss

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/)
[![React 18](https://img.shields.io/badge/react-18-cyan.svg)](https://react.dev/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-green.svg)](https://fastapi.tiangolo.com/)

A high-performance, resource-efficient algorithmic options trading terminal built for the **Kotak Neo TradeAPI v2**. Designed specifically for **Nifty 50 multi-leg options strategies** with **real-time underlying index-based stop loss** and accessible seamlessly from **desktop and mobile browsers**.

Engineered to run reliably 24/7 on low-resource cloud servers (e.g., Google Cloud Free Tier **`e2-micro`** VM with 1 GB RAM, AWS EC2, or DigitalOcean Droplets).

---

## 🌟 Key Features

### 1. Dual Flexible Stop Loss Mechanisms (<0.1ms in-memory evaluation)
Traditional option stop-losses suffer from severe implied volatility (IV) spikes, illiquid order books, and wide bid-ask slippage. NeoTrader provides two institutional-grade SL models:

- **Underlying Index Spot SL**:
  - Monitors the **Nifty 50 Index Spot tick-by-tick in memory**.
  - **Live Tick SL**: Instantly triggers market exits across all legs the millisecond the index spot breaches your threshold (e.g., `NIFTY <= 24,950`).
  - **Candle Close SL**: Evaluates the stop loss strictly upon the close of 5m, 15m, 30m, or 60m candles (accurately aligned to the 9:15 AM market open), complete with a live countdown timer.

- **Strategy Net LTP Candle Close SL**:
  - Dynamically synthesizes the **Strategy Net Price** tick-by-tick from live option legs (`+1` for Long legs, `-1` for Short legs).
  - Pre-fills with a smart **5% risk buffer** automatically in the strategy builder.
  - Monitors and exits on candle close (5m, 15m, 30m, 60m) when the strategy premium exceeds your maximum loss threshold.
  - Can be monitored and modified live in the Executed Strategies book.

### 2. Margin-Safe Multi-Leg Order Sequencing
- Built-in strategy builder for:
  - **Credit Spreads** (Bull Put Spread, Bear Call Spread)
  - **Debit Spreads** (Bull Call Spread, Bear Put Spread)
  - **Iron Condors** (4 legs)
  - **Custom Multi-Legs**
- **Entry Sequencing**: Automatically places long hedge legs first to secure exchange margin relief before selling short legs.
- **Exit Sequencing**: Automatically buys back short legs first to avoid exchange margin penalty violations, then liquidates long hedges.

### 3. Bank-Grade Dual-Layer Security
- **Web App 2FA (TOTP)**: Uses Google Authenticator / 1Password with built-in QR code generator and strict single-active-session enforcement.
- **Strict RAM-Only Broker Session**: Kotak Neo session tokens live **exclusively in RAM** and are automatically wiped on restart or expiration. Zero session tokens are ever written to disk.
- **SEBI Compliance**: Full order audit trail logging with payloads, broker responses, latencies, and execution timestamps.

### 4. Ultra-Low Resource Footprint
- Single lightweight Python process (FastAPI + Uvicorn) consuming only **~70–90 MB RAM**.
- SQLite in **WAL (Write-Ahead Logging) mode** with zero background daemon overhead.
- Pre-compiled React + Vite single-page application served as static files.

---

## 🚀 Quickstart: Deploy to Any VM (1-Click Setup)

### Method 1: Automated Shell Script (Recommended for GCP / AWS / VPS)

Works on any clean **Ubuntu 20.04/22.04/24.04 LTS** or **Debian 11/12** server:

```bash
# 1. Clone the repository
git clone https://github.com/raviudal/kotak_neo_options_trader.git
cd kotak_neo_options_trader

# 2. Run the automated installer
chmod +x setup.sh
./setup.sh
```

**What the installer does automatically:**
1. Configures a 2 GB swap file to eliminate low-memory VM crashes.
2. Installs Python 3, venv, Git, and Node.js 20 LTS.
3. Sets up a Python virtual environment and installs dependencies.
4. Builds the production React frontend.
5. Generates a secure `.env` file with a cryptographically random secret key.
6. Initializes the SQLite database.
7. Registers and starts `neotrader.service` as a systemd background daemon that starts on boot and auto-restarts on any failure.

Once complete, open `http://<YOUR_SERVER_IP>:8080` in your browser!

---

### Method 2: Docker Compose

If you prefer running via Docker:

```bash
# 1. Clone and enter repo
git clone https://github.com/raviudal/kotak_neo_options_trader.git
cd kotak_neo_options_trader

# 2. Create environment file
cp .env.example .env

# 3. Start containers
docker compose up -d --build
```

Access the terminal at `http://localhost:8080` (or `http://<YOUR_SERVER_IP>:8080`).

---

### Method 3: Local Development (Manual Setup)

#### Backend Setup
```bash
# 1. Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate       # On Windows: .\venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Initialize database
python -m backend.database
```

#### Frontend Setup
```bash
cd frontend
npm install
npm run build
cd ..
```

#### Run Server
```bash
python run.py
```
Server starts on `http://localhost:8080`.

---

## 📱 First-Time User Registration & Broker Setup

### Step 1: Create Your Account & Setup 2FA
1. Open `http://<YOUR_SERVER_IP>:8080` in your desktop or mobile browser.
2. Click **Register New User**.
3. Choose a username and a password (min 6 characters), then click **Register & Setup Google 2FA**.
4. Scan the presented **QR Code** using the **Google Authenticator** app on your phone (or 1Password).
5. Enter the 6-digit code shown in your authenticator app and click **Verify & Enter Terminal**.

### Step 2: Connect Your Kotak Neo API
1. Upon logging in, the **Kotak Neo API Session** modal will appear.
2. Enter your Kotak Neo credentials:
   - **Consumer Key**: Obtain this from the [Kotak Neo Developer Portal](https://tradeapi.kotaksecurities.com/) under Applications.
   - **Mobile Number**: Your registered mobile number (e.g. `+91XXXXXXXXXX`).
   - **Client UCC**: Your Kotak Neo Client ID.
   - **MPIN**: Your 6-digit Kotak Neo MPIN.
   - **Kotak Neo TOTP**: Enter the current 6-digit code from your Kotak Neo authenticator.
3. Click **Connect to Kotak Neo API**.
4. The system validates your credentials and activates the live streaming feed and strategy execution engine!

*(Your static credentials like UCC and Mobile are securely saved in your local database for future 1-click logins; session tokens are strictly kept in RAM).*

---

## ⚙️ Environment Variables Reference

Copy `.env.example` to `.env` to customize settings:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port for the web terminal |
| `HOST` | `0.0.0.0` | Host address binding |
| `APP_SECRET_KEY` | *(Auto-generated)* | 32+ character random secret for JWT sessions |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` (24h) | JWT access token lifespan |
| `KOTAK_ENV` | `prod` | `prod` (live execution) or `sandbox` |
| `ADMIN_SEED` | `true` | Pre-seeds a default admin user (`trader` / `TradeSafe@2026`) |
| `ADMIN_USERNAME` | `trader` | Default admin username |
| `ADMIN_PASSWORD` | `TradeSafe@2026` | Default admin password |
| `KOTAK_CONSUMER_KEY` | `""` | Optional environment pre-fill for Kotak Consumer Key |
| `KOTAK_MOBILE_NUMBER` | `""` | Optional environment pre-fill for mobile number |
| `KOTAK_UCC` | `""` | Optional environment pre-fill for Client UCC |

---

## 🛠️ System Operations & Useful Commands

For servers running `neotrader.service` via systemd:

```bash
# Check service status
sudo systemctl status neotrader

# View live application logs (tail -f)
sudo journalctl -u neotrader -f

# Restart application
sudo systemctl restart neotrader

# Stop application
sudo systemctl stop neotrader
```

### Free HTTPS with Automated SSL & WebSocket Support

NeoTrader includes a 1-click script (`deploy/setup_ssl.sh`) to configure **Nginx** reverse proxying with **free Let's Encrypt TLS encryption**:

```bash
# 1. Run the SSL setup script
# (Automatically assigns free SSL via your public IP: e.g. https://<YOUR_IP>.sslip.io)
chmod +x deploy/setup_ssl.sh
./deploy/setup_ssl.sh

# Or if you have a custom domain pointing to your server IP:
./deploy/setup_ssl.sh trade.yourdomain.com
```

Then obtain an official Let's Encrypt certificate with 1 command:
```bash
sudo certbot --nginx -d trade.yourdomain.com --non-interactive --agree-tos -m your-email@example.com
```

Your trading terminal is now accessible via secure HTTPS with automated certificate renewals!

---

## 🔒 Security Architecture

1. **Zero Session Persistence**: No session tokens, auth tokens, or trade IDs are saved in SQLite or on the filesystem. If the process terminates, all tokens are instantly cleared from memory.
2. **Single-Session Enforcement**: If your account is accessed from another browser or device, older active sessions are invalidated immediately.
3. **SEBI Audit Trail**: Every API request sent to the broker and its raw JSON response are logged in `order_logs` with microsecond-level latency metrics.

---

## ⚠️ Disclaimer & Risk Warning

*Trading in derivatives (options & futures) involves substantial risk of capital loss and is not suitable for every investor. This software is provided for informational and automated execution purposes only. Past performance does not guarantee future results. The authors and contributors assume no liability for financial losses, broker API downtime, exchange connectivity failures, or unexpected slippage.*

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
