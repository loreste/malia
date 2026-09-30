#!/usr/bin/env python3
# Paired jse-vs-node benchmark suite. Each case runs the same (or an
# equivalent) script on both runtimes; script-reported times (RESULT ms=...)
# and process wall times are recorded. Best of N runs.
import os
import re
import signal
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUITE = os.path.join(ROOT, "bench", "suite")
JSE = os.path.join(ROOT, "target", "release", "jse")
NODE = "node"
RUNS = int(os.environ.get("BENCH_RUNS", "3"))
STARTUP_RUNS = int(os.environ.get("BENCH_STARTUP_RUNS", "20"))
HTTP_PORT = os.environ.get("BENCH_HTTP_PORT", "18123")
SERVER_PORT = os.environ.get("BENCH_SERVER_PORT", "18321")

# (name, jse script, node script, measure) — measure: "script" | "wall" | "startup"
CASES = [
    ("fib(35)", "fib.js", "fib.js", "script"),
    ("JSON roundtrip ~10MB", "json.js", "json.js", "script"),
    ("string concat x1M", "strings.js", "strings.js", "script"),
    ("regex 1M match+replace", "regex.js", "regex.js", "script"),
    ("array map/filter/reduce 1M", "array_ops.js", "array_ops.js", "script"),
    ("Map/Set churn 1M", "map_set.js", "map_set.js", "script"),
    ("promise chain 100k", "promise_chain.js", "promise_chain.js", "script"),
    ("JSON small docs 100k", "json_small.js", "json_small.js", "script"),
    ("Buffer ops 1M", "buffer_ops.js", "buffer_ops.js", "script"),
    ("fs write+read 100MB", "fs_io.js", "fs_io.js", "script"),
    ("10k async sleeps", "async.jse.js", "async.node.mjs", "script"),
    ("HTTP fetch x1000", "http.js", "http.js", "http"),
    ("worker pool fib x8", "pool.jse.js", "pool.node.mjs", "script"),
    ("server throughput (rps)", "server.jse.js", "server.node.mjs", "server"),
    ("express app (rps)", "express.jse.js", "express.node.mjs", "server"),
    ("large module (code cache)", ".big_generated.js", ".big_generated.js", "wall"),
    ("startup (wall, avg of %d)" % STARTUP_RUNS, "hello.js", "hello.js", "startup"),
]


def run_script(cmd, cwd, env=None):
    """Return (script_ms or None, wall_ms)."""
    start = time.perf_counter()
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    wall = (time.perf_counter() - start) * 1000
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed:\n{proc.stdout}\n{proc.stderr}")
    match = re.search(r"ms=([\d.]+)", proc.stdout)
    return (float(match.group(1)) if match else None, wall)


def best_of(runs):
    script_times = [s for s, _ in runs if s is not None]
    walls = [w for _, w in runs]
    return (min(script_times) if script_times else None, min(walls))


def generate_big_module(path):
    if os.path.exists(path):
        return
    import random

    random.seed(42)
    parts = ["// generated large module for code-cache benchmarking\n"]
    for i in range(12000):
        parts.append(
            f"export function fn_{i}(x) {{ let y = x * {i} + {i % 97}; "
            f"for (let j = 0; j < 3; j++) {{ y = (y ^ (y << 2)) + j * {i % 13}; }} "
            f"return y % 1000; }}\n"
        )
    parts.append("let acc = 0;\n")
    for i in range(0, 12000, 40):
        parts.append(f"acc += fn_{i}({i});\n")
    parts.append("console.log(`RESULT acc=${acc} ms=1`);\n")
    with open(path, "w") as f:
        f.write("".join(parts))


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    generate_big_module(os.path.join(SUITE, ".big_generated.js"))

    # HTTP server for the fetch case (started lazily).
    http_server = None
    http_env = dict(os.environ, BENCH_HTTP_PORT=HTTP_PORT)

    def ensure_http_server():
        nonlocal http_server
        if http_server is not None:
            return
        http_server = subprocess.Popen(
            [NODE, os.path.join(SUITE, "http_server.node.mjs")],
            env=http_env,
            stdout=subprocess.PIPE,
            text=True,
        )
        # Wait for "ready" on stdout.
        deadline = time.time() + 10
        while time.time() < deadline:
            line = http_server.stdout.readline()
            if "ready" in line:
                return
        raise RuntimeError("http bench server did not start")

    print(f"{'benchmark':<34} {'jse':>10} {'node':>10} {'ratio':>8}")
    print("-" * 66)
    jse_wins = ties = node_wins = 0
    try:
        for name, jse_file, node_file, measure in CASES:
            if only and only not in name:
                continue
            jse_script = os.path.join(SUITE, jse_file)
            node_script = os.path.join(SUITE, node_file)
            if measure == "startup":
                for cmd in ([JSE, "run", "--allow-all", jse_script], [NODE, node_script]):
                    subprocess.run(cmd, cwd=ROOT, capture_output=True)  # warmup
                jse_wall = sum(
                    run_script([JSE, "run", "--allow-all", jse_script], ROOT)[1] for _ in range(STARTUP_RUNS)
                ) / STARTUP_RUNS
                node_wall = sum(
                    run_script([NODE, node_script], ROOT)[1] for _ in range(STARTUP_RUNS)
                ) / STARTUP_RUNS
                jse_ms = node_ms = None
            elif measure == "server":
                results = {}
                for side, cmd in (
                    ("jse", [JSE, "run", "--allow-all", jse_script]),
                    ("node", [NODE, node_script]),
                ):
                    srv = subprocess.Popen(
                        cmd,
                        cwd=ROOT,
                        env=dict(os.environ, BENCH_SERVER_PORT=SERVER_PORT),
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                        text=True,
                    )
                    try:
                        deadline = time.time() + 10
                        while time.time() < deadline:
                            line = srv.stdout.readline()
                            if "ready" in line:
                                break
                        else:
                            raise RuntimeError(f"{side} server did not start")
                        proc = subprocess.run(
                            [NODE, os.path.join(SUITE, "load_client.mjs")],
                            cwd=ROOT,
                            capture_output=True,
                            text=True,
                            env=dict(os.environ, BENCH_SERVER_PORT=SERVER_PORT),
                        )
                        if proc.returncode != 0:
                            raise RuntimeError(f"load client failed: {proc.stderr}")
                        match = re.search(
                            r"rps=(\d+) mean=([\d.]+) p99=([\d.]+)", proc.stdout
                        )
                        results[side] = (int(match.group(1)), float(match.group(2)), float(match.group(3)))
                    finally:
                        srv.terminate()
                        srv.wait(timeout=5)
                jse_ms, node_ms = results["jse"][0], results["node"][0]
                jse_wall, node_wall = jse_ms, node_ms
                print(
                    f"    (jse mean {results['jse'][1]:.2f}ms p99 {results['jse'][2]:.2f}ms | "
                    f"node mean {results['node'][1]:.2f}ms p99 {results['node'][2]:.2f}ms)"
                )
            elif measure == "http":
                ensure_http_server()
                jse_ms, jse_wall = best_of(
                    [run_script([JSE, "run", "--allow-all", jse_script], ROOT, env=http_env) for _ in range(RUNS)]
                )
                node_ms, node_wall = best_of(
                    [run_script([NODE, node_script], ROOT, env=http_env) for _ in range(RUNS)]
                )
            elif measure == "wall":
                # Warm both caches first, then best-of-N wall time.
                for cmd in ([JSE, "run", "--allow-all", jse_script], [NODE, node_script]):
                    subprocess.run(cmd, cwd=ROOT, capture_output=True)
                _, jse_wall = best_of([run_script([JSE, "run", "--allow-all", jse_script], ROOT) for _ in range(RUNS)])
                _, node_wall = best_of([run_script([NODE, node_script], ROOT) for _ in range(RUNS)])
                jse_ms = node_ms = None
            else:
                jse_ms, jse_wall = best_of(
                    [run_script([JSE, "run", "--allow-all", jse_script], ROOT) for _ in range(RUNS)]
                )
                node_ms, node_wall = best_of(
                    [run_script([NODE, node_script], ROOT) for _ in range(RUNS)]
                )
            shown_jse = jse_ms if jse_ms is not None else jse_wall
            shown_node = node_ms if node_ms is not None else node_wall
            if measure == "server":
                # Higher is better (requests/sec): invert the ratio.
                ratio = shown_jse / shown_node if shown_node else float("inf")
            else:
                ratio = shown_node / shown_jse if shown_jse else float("inf")
            verdict = "jse" if ratio > 1.05 else ("node" if ratio < 0.95 else "tie")
            if verdict == "jse":
                jse_wins += 1
            elif verdict == "node":
                node_wins += 1
            else:
                ties += 1
            wall_note = f" (wall {jse_wall:.0f}/{node_wall:.0f})" if measure not in ("startup", "wall") else ""
            if measure == "server":
                print(
                    f"{name:<34} {shown_jse:>8.0f}rps {shown_node:>8.0f}rps {ratio:>7.2f}x {verdict}"
                )
            else:
                print(
                    f"{name:<34} {shown_jse:>8.1f}ms {shown_node:>8.1f}ms {ratio:>7.2f}x {verdict}{wall_note}"
                )
    finally:
        if http_server is not None:
            http_server.send_signal(signal.SIGTERM)
            http_server.wait(timeout=5)
    print("-" * 66)
    print(f"jse wins {jse_wins}, node wins {node_wins}, ties {ties}")


if __name__ == "__main__":
    main()
