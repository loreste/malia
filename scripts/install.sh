#!/usr/bin/env sh
set -e

# Malia installer for macOS and Linux.
# Downloads a prebuilt binary from GitHub releases.
# No Rust, no build tools, no dependencies required.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/loreste/malia/main/scripts/install.sh | sh
#
# Options (environment variables):
#   MALIA_VERSION   - release tag (default: latest)
#   MALIA_INSTALL_DIR - install location (default: ~/.malia)

INSTALL_DIR="${MALIA_INSTALL_DIR:-$HOME/.malia}"
BIN_DIR="$INSTALL_DIR/bin"
REPO="loreste/malia"
VERSION="${MALIA_VERSION:-latest}"

# -- Detect platform ----------------------------------------------------------

OS="$(uname -s)"
case "$OS" in
  Darwin)  PLATFORM="darwin" ;;
  Linux)   PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, use the PowerShell installer:"
    echo "  irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex"
    exit 1 ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1 ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1 ;;
esac

LIBC=""
if [ "$PLATFORM" = "linux" ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    LIBC="-musl"
  else
    LIBC="-gnu"
  fi
fi

TARGET="${PLATFORM}-${ARCH}${LIBC}"

# -- Download ------------------------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/malia-${TARGET}.tar.gz"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/malia-${TARGET}.tar.gz"
fi

echo "Installing malia for ${TARGET}..."
echo "  from: $URL"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v curl >/dev/null 2>&1; then
  HTTP_CODE=$(curl -fsSL -w "%{http_code}" "$URL" -o "$TMP/malia.tar.gz" 2>/dev/null) || true
  if [ "$HTTP_CODE" = "404" ] || [ ! -s "$TMP/malia.tar.gz" ]; then
    echo ""
    echo "Error: no prebuilt binary found for ${TARGET}."
    echo "Check available releases at: https://github.com/${REPO}/releases"
    echo ""
    echo "To build from source instead:"
    echo "  git clone https://github.com/${REPO}.git && cd malia && cargo build --release"
    exit 1
  fi
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/malia.tar.gz" "$URL" || {
    echo ""
    echo "Error: download failed. Check https://github.com/${REPO}/releases"
    exit 1
  }
else
  echo "Error: curl or wget required."
  exit 1
fi

# -- Install -------------------------------------------------------------------

mkdir -p "$BIN_DIR"
tar -xzf "$TMP/malia.tar.gz" -C "$BIN_DIR"
chmod 755 "$BIN_DIR/malia" 2>/dev/null || true
chmod 755 "$BIN_DIR/jse" 2>/dev/null || true

# Ensure jse alias exists.
if [ ! -f "$BIN_DIR/jse" ]; then
  ln -sf "$BIN_DIR/malia" "$BIN_DIR/jse"
fi

# Verify the binary runs.
if ! "$BIN_DIR/malia" --version >/dev/null 2>&1; then
  echo "Warning: installed binary does not appear to run on this system."
fi

# -- PATH ----------------------------------------------------------------------

SHELL_NAME="$(basename "${SHELL:-sh}")"
PROFILE=""
case "$SHELL_NAME" in
  zsh)  PROFILE="$HOME/.zshrc" ;;
  bash)
    if [ -f "$HOME/.bashrc" ]; then PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then PROFILE="$HOME/.bash_profile"
    fi ;;
  fish) PROFILE="$HOME/.config/fish/config.fish" ;;
  *)    PROFILE="$HOME/.profile" ;;
esac

if [ "$SHELL_NAME" = "fish" ]; then
  PATH_LINE="fish_add_path $BIN_DIR"
else
  PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
fi

NEED_PATH=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) NEED_PATH=1 ;;
esac

if [ "$NEED_PATH" -eq 1 ] && [ -n "$PROFILE" ]; then
  if ! grep -q "$BIN_DIR" "$PROFILE" 2>/dev/null; then
    printf "\n# Malia\n%s\n" "$PATH_LINE" >> "$PROFILE"
  fi
fi

# -- Done ----------------------------------------------------------------------

INSTALLED_VERSION=$("$BIN_DIR/malia" --version 2>/dev/null || echo "unknown")
echo ""
echo "Installed malia $INSTALLED_VERSION"
echo "  malia: $BIN_DIR/malia"
echo "  jse:   $BIN_DIR/jse"
echo ""
if [ "$NEED_PATH" -eq 1 ]; then
  echo "Run this to add it to your current shell:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
  echo "Or restart your terminal."
else
  echo "Run: malia --help"
fi
