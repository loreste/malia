#!/bin/sh
# Run the paired jse-vs-node benchmark suite (requires target/release/jse).
exec python3 "$(dirname "$0")/run_suite.py" "$@"
