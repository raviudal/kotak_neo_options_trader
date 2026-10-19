#!/bin/bash
set -e

PUBLIC_IP=$(curl -s -4 ifconfig.me || curl -s -4 icanhazip.com || echo "127.0.0.1")
DOMAIN=${1:-"${PUBLIC_IP}.sslip.io"}

echo "=== Domain: $DOMAIN (IP: $PUBLIC_IP) ==="
echo "=== Stopping Caddy (if present) ==="
sudo systemctl stop caddy || true
sudo systemctl disable caddy || true

echo "=== Installing Nginx & Certbot ==="
sudo apt-get update -qq
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx

echo "=== Generating Initial TLS Certificate (SAN for IP & Domain) ==="
sudo mkdir -p /etc/ssl/private /etc/ssl/certs
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/neotrader.key \
  -out /etc/ssl/certs/neotrader.crt \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN},IP:${PUBLIC_IP},DNS:localhost"

echo "=== Writing Nginx Configuration ==="
cat << EOF | sudo tee /etc/nginx/sites-available/neotrader
# HTTP on port 80: Reverse proxy to trading app
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${PUBLIC_IP} localhost _;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

# HTTPS on port 443: Full TLS encryption & WebSocket upgrade
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN} ${PUBLIC_IP} localhost _;

    ssl_certificate /etc/ssl/certs/neotrader.crt;
    ssl_certificate_key /etc/ssl/private/neotrader.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF

sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/neotrader /etc/nginx/sites-enabled/neotrader

echo "=== Testing & Starting Nginx ==="
sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx
sudo systemctl status nginx --no-pager
