#!/bin/bash

# Oracle Cloud VM Setup Script
# Run this script on your Oracle Cloud VM after copying the files

set -e

echo "🚀 Setting up Oracle Cloud Trading Analysis Service"
echo "===================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    sudo dnf install -y nodejs npm || {
        echo "⚠️  DNF install failed, trying NodeSource..."
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo dnf install -y nodejs
    }
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Build TypeScript
echo ""
echo "🔨 Building TypeScript..."
npm run build

# Create necessary directories
echo ""
echo "📁 Creating directories..."
mkdir -p logs
mkdir -p data

# Check if vanguard.csv exists
if [ ! -f "vanguard.csv" ]; then
    echo "⚠️  WARNING: vanguard.csv not found!"
    echo "   Please copy vanguard.csv to this directory"
    exit 1
fi

# Check if .env exists
if [ ! -f ".env" ]; then
    echo ""
    echo "⚠️  .env file not found. Creating from template..."
    cp env.template .env
    echo "   Please edit .env and add your NEON_DATABASE_URL"
    echo "   Run: nano .env"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file: nano .env"
echo "2. Add your NEON_DATABASE_URL"
echo "3. Test run: npm start"
echo "4. Setup cron: crontab -e"

