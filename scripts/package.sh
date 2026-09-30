#!/usr/bin/env sh
set -e

# Package locally built Malia and JSE binaries into release archives.

TARGET_DIR="${1:-target/release}"
DIST_DIR="dist"

mkdir -p "$DIST_DIR"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
esac

if [ "$OS" = "darwin" ]; then
  ARCHIVE_NAME="malia-darwin-${ARCH}.tar.gz"
  strip "$TARGET_DIR/malia" "$TARGET_DIR/jse" 2>/dev/null || true
  tar -czf "$DIST_DIR/$ARCHIVE_NAME" -C "$TARGET_DIR" malia jse
  echo "Packaged: $DIST_DIR/$ARCHIVE_NAME"
elif [ "$OS" = "linux" ]; then
  LIBC="-gnu"
  if ldd --version 2>&1 | grep -qi "musl"; then
    LIBC="-musl"
  fi
  ARCHIVE_NAME="malia-linux-${ARCH}${LIBC}.tar.gz"
  strip "$TARGET_DIR/malia" "$TARGET_DIR/jse" 2>/dev/null || true
  tar -czf "$DIST_DIR/$ARCHIVE_NAME" -C "$TARGET_DIR" malia jse
  echo "Packaged: $DIST_DIR/$ARCHIVE_NAME"
fi
