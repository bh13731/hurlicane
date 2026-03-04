#!/usr/bin/env bash
#
# Hurlicane EC2 Setup Script
#
# Usage:
#   curl -fsSL <raw-url> | bash
#   -- or --
#   ./scripts/setup-ec2.sh
#
# Supports Amazon Linux 2023 and Ubuntu/Debian.
# Run as ec2-user (or ubuntu) — uses sudo where needed.
#
set -euo pipefail

REPO_URL="https://github.com/lightsparkdev/hurlicane.git"
BRANCH="aaryaman-main"
INSTALL_DIR="$HOME/hurlicane"
NODE_VERSION="22"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { echo -e "\033[1;34m[setup]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[setup]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[setup]\033[0m $*"; }
fail()  { echo -e "\033[1;31m[setup]\033[0m $*"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  else
    echo "unknown"
  fi
}

# ── System Dependencies ─────────────────────────────────────────────────────

install_system_deps() {
  local os
  os=$(detect_os)
  info "Detected OS: $os"

  case "$os" in
    amzn|rhel|centos|fedora)
      info "Installing system packages via yum..."
      sudo yum update -y -q
      sudo yum groupinstall -y "Development Tools" 2>/dev/null || sudo yum install -y gcc gcc-c++ make
      sudo yum install -y git tmux python3
      # curl-minimal (AL2023 default) conflicts with full curl; only install if neither exists
      command_exists curl || sudo yum install -y curl
      ;;
    ubuntu|debian)
      info "Installing system packages via apt..."
      sudo apt-get update -qq
      sudo apt-get install -y build-essential git tmux python3 curl
      ;;
    *)
      fail "Unsupported OS: $os. Install manually: git, tmux, python3, curl, and C++ build tools."
      ;;
  esac

  ok "System dependencies installed"
}

# ── Node.js ──────────────────────────────────────────────────────────────────

install_node() {
  if command_exists node; then
    local current
    current=$(node --version | sed 's/v//' | cut -d. -f1)
    if [ "$current" -ge "$NODE_VERSION" ]; then
      ok "Node.js $(node --version) already installed"
      return
    fi
    warn "Node.js v$current is too old (need >= $NODE_VERSION), upgrading..."
  fi

  info "Installing Node.js $NODE_VERSION via nvm..."

  # Install nvm if missing
  if [ ! -d "$HOME/.nvm" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi

  # Source nvm
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"

  ok "Node.js $(node --version) installed"
}

# Ensure nvm is loaded for the rest of the script
load_nvm() {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
}

# ── GitHub CLI ───────────────────────────────────────────────────────────────

install_gh() {
  if command_exists gh; then
    ok "GitHub CLI already installed"
  else
    info "Installing GitHub CLI..."
    local os
    os=$(detect_os)
    case "$os" in
      amzn|rhel|centos|fedora)
        sudo yum install -y yum-utils
        sudo yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
        sudo yum install -y gh
        ;;
      ubuntu|debian)
        curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli-stable.list > /dev/null
        sudo apt-get update -qq
        sudo apt-get install -y gh
        ;;
    esac
    ok "GitHub CLI installed"
  fi
}

setup_github_auth() {
  # Check if already authenticated
  if gh auth status &>/dev/null; then
    ok "GitHub CLI already authenticated"
    return
  fi

  info "GitHub authentication required for cloning private repos and PR operations"
  echo ""
  echo "  Options:"
  echo "    1) Paste a personal access token (classic, with repo scope)"
  echo "    2) Skip (you'll need to set up auth manually later)"
  echo ""
  read -rp "  GitHub personal access token (or press Enter to skip): " gh_token

  if [ -n "$gh_token" ]; then
    echo "$gh_token" | gh auth login --with-token
    ok "GitHub CLI authenticated"
  else
    warn "Skipping GitHub auth — clone and PR features may not work"
  fi
}

# ── Claude Code CLI ──────────────────────────────────────────────────────────

install_claude() {
  if command_exists claude; then
    ok "Claude Code CLI already installed"
    return
  fi

  info "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
  ok "Claude Code CLI installed"
}

# ── Clone Repo ───────────────────────────────────────────────────────────────

clone_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Repo exists, pulling latest..."
    cd "$INSTALL_DIR"
    git fetch origin
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
  else
    info "Cloning $REPO_URL ($BRANCH)..."
    git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  ok "Repo ready at $INSTALL_DIR"
}

# ── npm install ──────────────────────────────────────────────────────────────

install_deps() {
  cd "$INSTALL_DIR"
  info "Installing npm dependencies..."
  npm install
  ok "Dependencies installed"
}

# ── .env File ────────────────────────────────────────────────────────────────

setup_env() {
  cd "$INSTALL_DIR"

  if [ -f .env ]; then
    ok ".env already exists, skipping"
    return
  fi

  info "Creating .env file..."
  echo ""
  echo "  Enter your configuration (leave blank to skip optional values):"
  echo ""

  read -rp "  ANTHROPIC_API_KEY (required): " api_key
  if [ -z "$api_key" ]; then
    warn "No API key provided — you'll need to add it to .env later"
  fi

  read -rp "  AUTH_PASSWORD (recommended for public instances): " auth_pw
  read -rp "  AUTH_SECRET (optional, for persistent sessions): " auth_secret
  read -rp "  OPENAI_API_KEY (optional, for Codex agents): " openai_key

  {
    echo "NODE_OPTIONS=--experimental-sqlite"
    [ -n "$api_key" ] && echo "ANTHROPIC_API_KEY=$api_key"
    [ -n "$auth_pw" ] && echo "AUTH_PASSWORD=$auth_pw"
    [ -n "$auth_secret" ] && echo "AUTH_SECRET=$auth_secret"
    [ -n "$openai_key" ] && echo "OPENAI_API_KEY=$openai_key"
  } > .env

  chmod 600 .env
  ok ".env created (chmod 600)"
}

# ── Build ────────────────────────────────────────────────────────────────────

build_project() {
  cd "$INSTALL_DIR"
  info "Building project..."
  npm run build
  ok "Build complete"
}

# ── Shell Profile ────────────────────────────────────────────────────────────

setup_profile() {
  local profile="$HOME/.bashrc"
  local marker="# hurlicane-setup"

  if grep -q "$marker" "$profile" 2>/dev/null; then
    return
  fi

  info "Adding nvm + NODE_OPTIONS to $profile..."
  cat >> "$profile" << 'PROFILE'

# hurlicane-setup
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export NODE_OPTIONS=--experimental-sqlite
PROFILE

  ok "Shell profile updated"
}

# ── Summary ──────────────────────────────────────────────────────────────────

print_summary() {
  local ip
  ip=$(curl -s --max-time 3 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "<your-ec2-ip>")

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ok "Setup complete!"
  echo ""
  echo "  Start the server:"
  echo "    cd $INSTALL_DIR && ./scripts/start-ec2.sh"
  echo ""
  echo "  Dashboard:  http://$ip:3000"
  echo "  Eye webhook: http://$ip:4567/webhook"
  echo ""
  echo "  Manage tmux session:"
  echo "    tmux attach -t hurlicane    # view logs"
  echo "    Ctrl-B D                    # detach"
  echo "    tmux kill-session -t hurlicane  # stop"
  echo ""
  echo "  EC2 Security Group — open these inbound ports:"
  echo "    3000  Orchestrator UI"
  echo "    4567  Eye webhook (if using GitHub integration)"
  echo "    22    SSH"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo "  ╔═══════════════════════════════╗"
  echo "  ║   Hurlicane EC2 Setup         ║"
  echo "  ╚═══════════════════════════════╝"
  echo ""

  install_system_deps
  install_node
  load_nvm
  install_gh
  setup_github_auth
  install_claude
  clone_repo
  install_deps
  setup_env
  build_project
  setup_profile
  print_summary
}

main
