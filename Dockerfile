# syntax=docker/dockerfile:1.4
# ==============================================================================
# JSE Runtime - Enterprise Multi-Stage Production Containerfile
# ==============================================================================
# Ultra-lightweight, hardened, container-ready JavaScript/TypeScript runtime.
# Features:
#   • PID 1 Signal forwarding (SIGTERM / SIGINT graceful shutdown)
#   • Linux cgroup v1/v2 memory limit and CPU quota auto-detection
#   • Default 0.0.0.0 host binding and container PORT env support
#   • Non-root unprivileged user (UID 10001) for strict security compliance
#   • Zero external dependencies at runtime (< 50MB image)
# ==============================================================================

# --- Stage 1: Build & Snapshot Generation ---
FROM rust:1.85-bookworm AS builder

WORKDIR /usr/src/jse

# Pre-install build dependencies (sqlite3 development libraries for bundled SQLite)
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY Cargo.toml Cargo.lock ./

# Cache cargo dependencies with a dummy src
RUN mkdir src && echo "pub fn dummy() {}" > src/lib.rs && echo "fn main() {}" > src/main.rs \
    && cargo build --release || true \
    && rm -rf src

# Copy real source code and build snapshot
COPY build.rs ./
COPY src/ ./src/

# Compile optimized production release binary
RUN cargo build --release --bin jse

# Strip binary to minimize size
RUN strip target/release/jse

# --- Stage 2: Minimal Hardened Production Runtime ---
FROM debian:bookworm-slim AS runtime

# Install basic runtime SSL certificates & tzdata
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Create unprivileged app user & group
RUN groupadd -g 10001 jse && \
    useradd -u 10001 -g jse -m -s /bin/false jse

# Copy stripped jse binary from builder stage
COPY --from=builder /usr/src/jse/target/release/jse /usr/local/bin/jse

# Set runtime container environment defaults
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app
RUN chown -R jse:jse /app

# Run as non-root user
USER jse:jse

# Default health check against container PORT
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD jse -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Expose default HTTP port
EXPOSE 8000

# Container entrypoint & default command
ENTRYPOINT ["/usr/local/bin/jse"]
CMD ["run", "index.js"]
