#!/bin/bash
# Compile TypeScript dashboard to JavaScript for systemd service

set -e

cd "$(dirname "$0")/.."

echo "🔧 Compiling dashboard..."
npx tsc src/dashboard.ts --outDir dist --target es2020 --module commonjs --esModuleInterop --allowSyntheticDefaultImports --skipLibCheck

echo "🔄 Restarting dashboard service..."
systemctl restart kamino-dashboard

echo "✅ Dashboard compiled and restarted"
systemctl status kamino-dashboard --no-pager -l