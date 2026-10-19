#!/bin/bash
# ==============================================================================
# NeoTrader - 1-Click VM Self-Hosting Setup Script
# Works on: Ubuntu 20.04/22.04/24.04 LTS & Debian 11/12
# Tested on: GCP Free Tier e2-micro, AWS EC2, DigitalOcean Droplets, Hetzner
# ==============================================================================

set -e

# Styling
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}==================================================================${NC}"
echo -e "${BLUE}🚀 Kotak Neo Options Trading Engine - Automated Host Installer${NC}"
echo -e "${BLUE}==================================================================${NC}"

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_USER="$(whoami)"

echo -e "📂 Installation directory: ${YELLOW}${CURRENT_DIR}${NC}"
echo -e "👤 Service User         : ${YELLOW}${CURRENT_USER}${NC}"

# 1. Check RAM & Configure 2GB Swap if Memory < 2GB
echo -e "\n${BLUE}[1/6] Checking system memory & swap...${NC}"
TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
echo "Detected RAM: ${TOTAL_RAM_MB} MB"

if [ "$TOTAL_RAM_MB" -lt 2000 ]; then
    if [ ! -f /swapfile ]; then
        echo -e "${YELLOW}Configuring 2GB Swap file for stability on low-memory VMs...${NC}"
        sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile
        if ! grep -q '/swapfile' /etc/fstab; then
            echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
        fi
        echo -e "${GREEN}✔ Swapfile configured successfully.${NC}"
    else
        echo "Swapfile already exists."
    fi
fi

# 2. Update System & Install Core Packages
echo -e "\n${BLUE}[2/6] Installing dependencies (Python 3, venv, Git, Node.js 20 LTS)...${NC}"
sudo apt-get update -y
sudo apt-get install -y python3 python3-pip python3-venv git curl ca-certificates gnupg

# Install Node.js 20 LTS if node is missing or outdated
if ! command -v node &> /dev/null; then
    echo "Installing Node.js 20 LTS..."
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
    sudo apt-get update -y
    sudo apt-get install -y nodejs
else
    echo "Node.js is already installed ($(node -v))."
fi

# 3. Setup Python Virtual Environment
echo -e "\n${BLUE}[3/6] Setting up Python virtual environment...${NC}"
cd "$CURRENT_DIR"
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 4. Build Frontend Assets
echo -e "\n${BLUE}[4/6] Checking & Building Frontend Assets...${NC}"
if [ ! -d "frontend/dist" ] || [ ! -f "frontend/dist/index.html" ]; then
    echo "Building production frontend UI..."
    cd frontend
    npm install
    npm run build
    cd "$CURRENT_DIR"
    echo -e "${GREEN}✔ Frontend build complete.${NC}"
else
    echo -e "${GREEN}✔ Pre-built frontend dist already present.${NC}"
fi

# 5. Environment & Database Configuration
echo -e "\n${BLUE}[5/6] Initializing Database & Environment...${NC}"
mkdir -p data
if [ ! -f ".env" ]; then
    echo "Generating new .env from .env.example..."
    cp .env.example .env
    RANDOM_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    sed -i "s/replace-with-a-random-secure-secret-key-32-chars/${RANDOM_SECRET}/g" .env
    echo -e "${GREEN}✔ Created .env with random secure APP_SECRET_KEY.${NC}"
fi

# Run Database Schema Migrations
venv/bin/python -m backend.database

# 6. Configure Systemd Background Service
echo -e "\n${BLUE}[6/6] Configuring systemd background service (neotrader.service)...${NC}"
sudo tee /etc/systemd/system/neotrader.service > /dev/null <<EOF
[Unit]
Description=Kotak Neo Options Engine
After=network.target

[Service]
User=$CURRENT_USER
WorkingDirectory=$CURRENT_DIR
ExecStart=$CURRENT_DIR/venv/bin/python $CURRENT_DIR/run.py
Restart=always
RestartSec=5
Environment=PORT=8080
Environment=HOST=0.0.0.0
EnvironmentFile=-$CURRENT_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable neotrader.service
sudo systemctl restart neotrader.service

# Get Public or Local IP
PUBLIC_IP=$(curl -s -m 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "\n${GREEN}==================================================================${NC}"
echo -e "${GREEN}✅ NeoTrader installed and running successfully!${NC}"
echo -e "${GREEN}==================================================================${NC}"
echo -e "Web Terminal URL : ${YELLOW}http://${PUBLIC_IP}:8080${NC}"
echo -e "Localhost URL    : ${YELLOW}http://localhost:8080${NC}"
echo -e "\n${BLUE}Next Steps:${NC}"
echo -e "1. Open ${YELLOW}http://${PUBLIC_IP}:8080${NC} in your browser."
echo -e "2. Click ${YELLOW}'Register New User'${NC} to create your personal account."
echo -e "3. Scan the QR code in Google Authenticator and enter your 6-digit code."
echo -e "4. Enter your Kotak Neo API Consumer Key, UCC, MPIN, and TOTP to start trading."
echo -e "\n${BLUE}Useful Commands:${NC}"
echo -e "• Check Status : ${YELLOW}sudo systemctl status neotrader${NC}"
echo -e "• View Live Log: ${YELLOW}sudo journalctl -u neotrader -f${NC}"
echo -e "• Restart App  : ${YELLOW}sudo systemctl restart neotrader${NC}"
echo -e "${GREEN}==================================================================${NC}"
