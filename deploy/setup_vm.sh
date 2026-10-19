#!/bin/bash
# ==============================================================================
# Setup script for VM / Cloud Server (GCP, AWS, DigitalOcean, Debian/Ubuntu)
# ==============================================================================

set -e

# Delegate to root setup.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"
chmod +x setup.sh
./setup.sh
