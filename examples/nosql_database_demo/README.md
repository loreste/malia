# JSE Containerized NoSQL Microservice

This example demonstrates running containerized workloads connecting to MongoDB and Redis.

---

## Capabilities Demonstrated

1. **Linux cgroup v1/v2 Resource Awareness**:
   - In Docker and Kubernetes, physical host RAM is typically exposed in `/proc/meminfo`.
   - `jse` automatically inspects `/sys/fs/cgroup/memory.max` (cgroup v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (cgroup v1).
   - `os.totalmem()` and `os.freemem()` reflect the container's memory limit (e.g., 512MB) rather than the physical host.
   - `os.cpus()` detects `/sys/fs/cgroup/cpu.max` CFS quota so thread pools size to assigned container cores.

2. **PID 1 Signal Handling & Graceful Shutdown**:
   - Under Kubernetes pod termination or `docker stop`, `SIGTERM` and `SIGINT` are forwarded to Node.js `process.on('SIGTERM')` and `process.on('SIGINT')`.
   - Applications can clean up active database connection pools, finish in-flight requests, and exit cleanly with exit code `0`.

3. **MongoDB & Mongoose Wire Protocol**:
   - SCRAM-SHA-256 and SCRAM-SHA-1 authentication via RFC 2898 `crypto.pbkdf2Sync` and `crypto.pbkdf2`.
   - `mongodb+srv://` DNS SRV cluster record discovery via `node:dns` (`resolveSrv`, `resolveTxt`).
   - Binary JSON (BSON) serialization with 64-bit BigInt support (`readBigInt64LE`, `writeBigInt64LE`) and string slicing (`utf8Slice`, `latin1Slice`).

4. **Redis & Valkey RESP Support**:
   - Raw binary TCP socket protocol over `node:net` (`setNoDelay`, `setKeepAlive`, `setTimeout`).
   - Streaming buffer concatenation and RESP parser support.

5. **Container Networking Defaults**:
   - `HOST=0.0.0.0` default binding ensures HTTP servers are reachable across container networks.
   - Respects standard cloud container environment variables (`PORT=8080`, `PORT=3000`).

---

## Running Locally

```bash
# Run with self-test verification
jse run index.js --selftest

# Run production server
PORT=3000 jse run index.js
```

## Running with Docker Compose

```bash
# Spin up JSE microservice alongside MongoDB 7 and Redis 7
docker compose up --build
```
