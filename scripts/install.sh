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
  BASE="https://github.com/${REPO}/releases/latest/download"
else
  BASE="https://github.com/${REPO}/releases/download/${VERSION}"
fi
ASSET="malia-${TARGET}.tar.gz"
URL="$BASE/$ASSET"

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

# -- Verify checksum -----------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS" 2>/dev/null || true
else
  wget -qO "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" 2>/dev/null || true
fi
EXPECTED="$(grep " ${ASSET}\$" "$TMP/SHA256SUMS" 2>/dev/null | cut -d' ' -f1)"
if [ -z "$EXPECTED" ]; then
  echo "Error: no checksum for ${ASSET} in the release's SHA256SUMS."
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/malia.tar.gz" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$TMP/malia.tar.gz" | cut -d' ' -f1)"
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Error: checksum mismatch for ${ASSET}."
  echo "  expected: $EXPECTED"
  echo "  got:      $ACTUAL"
  exit 1
fi

# -- Install -------------------------------------------------------------------

# Extract only executable names into a disposable staging directory. Validate
# both aliases before touching an existing installation.
mkdir -p "$TMP/staged"
tar -xzf "$TMP/malia.tar.gz" -C "$TMP/staged" malia || {
  echo "Error: archive is missing malia." >&2; exit 1;
}
if [ ! -f "$TMP/staged/malia" ] || [ -L "$TMP/staged/malia" ]; then
  echo "Error: archive malia must be a regular executable." >&2; exit 1
fi
if tar -tzf "$TMP/malia.tar.gz" | grep -qx 'jse'; then
  tar -xzf "$TMP/malia.tar.gz" -C "$TMP/staged" jse
  if [ ! -f "$TMP/staged/jse" ] || [ -L "$TMP/staged/jse" ]; then
    echo "Error: archive jse must be a regular executable." >&2; exit 1
  fi
else
  cp "$TMP/staged/malia" "$TMP/staged/jse"
fi
chmod 755 "$TMP/staged/malia" "$TMP/staged/jse"
for binary in malia jse; do
  if ! "$TMP/staged/$binary" --version >/dev/null 2>&1; then
    echo "Error: downloaded $binary cannot run on this system." >&2; exit 1
  fi
done
mkdir -p "$BIN_DIR"
for binary in malia jse; do
  cp "$TMP/staged/$binary" "$BIN_DIR/.$binary-new"
  chmod 755 "$BIN_DIR/.$binary-new"
  mv -f "$BIN_DIR/.$binary-new" "$BIN_DIR/$binary"
done

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

if [ "${MALIA_NO_MODIFY_PATH:-0}" != "1" ] && [ "$NEED_PATH" -eq 1 ] && [ -n "$PROFILE" ]; then
  if ! grep -q "$BIN_DIR" "$PROFILE" 2>/dev/null; then
    mkdir -p "$(dirname "$PROFILE")"
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
  echo "  $PATH_LINE"
  echo ""
  echo "Or restart your terminal."
else
  echo "Run: malia --help"
fi
