#!/usr/bin/env sh
set -e

# Malia Installer (macOS and Linux)
# Installs prebuilt native binaries for Malia and JSE.
# No Rust toolchain or build environment required.

INSTALL_DIR="${MALIA_INSTALL_DIR:-$HOME/.malia}"
BIN_DIR="$INSTALL_DIR/bin"
REPO="${MALIA_REPO:-loreste/malia}"
VERSION="${MALIA_VERSION:-latest}"

# 1. Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin)
    PLATFORM="darwin"
    ;;
  linux)
    PLATFORM="linux"
    ;;
  msys*|mingw*|cygwin*)
    echo "For Windows, please run the PowerShell installer:"
    echo "  irm https://raw.githubusercontent.com/loreste/malia/main/scripts/install.ps1 | iex"
    exit 1
    ;;
  *)
    echo "Unsupported operating system: $OS"
    exit 1
    ;;
esac

# 2. Detect Architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported CPU architecture: $ARCH"
    exit 1
    ;;
esac

# 3. Detect C library on Linux (glibc vs musl)
LIBC=""
if [ "$PLATFORM" = "linux" ]; then
  if ldd --version 2>&1 | grep -qi "musl"; then
    LIBC="-musl"
  else
    LIBC="-gnu"
  fi
fi

TARGET="${PLATFORM}-${ARCH}${LIBC}"
echo "Detected platform: ${TARGET}"

# Create destination directory
mkdir -p "$BIN_DIR"

LOCAL_BIN="$(pwd)/target/release/malia"
LOCAL_JSE="$(pwd)/target/release/jse"
if [ ! -f "$LOCAL_BIN" ] && [ -f "$(pwd)/target/debug/malia" ]; then
  LOCAL_BIN="$(pwd)/target/debug/malia"
  LOCAL_JSE="$(pwd)/target/debug/jse"
fi
if [ -f "$LOCAL_BIN" ]; then
  echo "Installing from local build: $LOCAL_BIN"
  cp "$LOCAL_BIN" "$BIN_DIR/malia"
  chmod 755 "$BIN_DIR/malia"
  if [ -f "$LOCAL_JSE" ]; then
    cp "$LOCAL_JSE" "$BIN_DIR/jse"
    chmod 755 "$BIN_DIR/jse"
  else
    ln -sf "$BIN_DIR/malia" "$BIN_DIR/jse"
  fi
else
  # Download prebuilt binary
  DOWNLOAD_URL="https://github.com/${REPO}/releases/${VERSION}/download/malia-${TARGET}.tar.gz"
  if [ "$VERSION" = "latest" ]; then
    DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/malia-${TARGET}.tar.gz"
  fi

  echo "Downloading Malia from: $DOWNLOAD_URL"
  TMP_DIR="$(mktemp -d)"
  cleanup() {
    rm -rf "$TMP_DIR"
  }
  trap cleanup EXIT

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$DOWNLOAD_URL" -o "$TMP_DIR/malia.tar.gz"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_DIR/malia.tar.gz" "$DOWNLOAD_URL"
  else
    echo "Error: curl or wget is required to download prebuilt binaries."
    exit 1
  fi

  tar -xzf "$TMP_DIR/malia.tar.gz" -C "$BIN_DIR"
  chmod 755 "$BIN_DIR/malia" 2>/dev/null || true
  if [ ! -f "$BIN_DIR/jse" ]; then
    ln -sf "$BIN_DIR/malia" "$BIN_DIR/jse"
  fi
fi

# 5. Configure shell PATH
SHELL_NAME="$(basename "${SHELL:-sh}")"
PROFILE=""

case "$SHELL_NAME" in
  zsh)
    PROFILE="$HOME/.zshrc"
    ;;
  bash)
    if [ -f "$HOME/.bashrc" ]; then
      PROFILE="$HOME/.bashrc"
    elif [ -f "$HOME/.bash_profile" ]; then
      PROFILE="$HOME/.bash_profile"
    fi
    ;;
  fish)
    PROFILE="$HOME/.config/fish/config.fish"
    ;;
  *)
    PROFILE="$HOME/.profile"
    ;;
esac

PATH_STR="export PATH=\"$BIN_DIR:\$PATH\""
if [ "$SHELL_NAME" = "fish" ]; then
  PATH_STR="fish_add_path $BIN_DIR"
fi

NEED_PATH_UPDATE=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) NEED_PATH_UPDATE=1 ;;
esac

if [ "$NEED_PATH_UPDATE" -eq 1 ] && [ -n "$PROFILE" ]; then
  if ! grep -q "$BIN_DIR" "$PROFILE" 2>/dev/null; then
    printf "\n# Malia\n%s\n" "$PATH_STR" >> "$PROFILE"
    echo "Added $BIN_DIR to $PROFILE"
  fi
fi

echo ""
echo "Malia installed successfully!"
echo "  Location: $BIN_DIR/malia"
echo "  Alias:    $BIN_DIR/jse"
echo ""
echo "To get started:"
if [ "$NEED_PATH_UPDATE" -eq 1 ]; then
  echo "  source $PROFILE"
fi
echo "  malia --help"
echo "  jse --help"
