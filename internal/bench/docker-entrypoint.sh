#!/usr/bin/env bash
# Build all frameworks, start mochi, run the benchmark, write results/.
set -euo pipefail
cd /repo/bench

echo "▸ build all frameworks"
node build-all.ts

echo "▸ start mochi on :3335"
(
	cd frameworks/mochi
	PORT=3335 MOCHI_KEY="${MOCHI_KEY:-dGVzdC1rZXktMzItYnl0ZXMtYmFzZTY0dXJsISEh}" bun run start
) &
MOCHI_PID=$!

cleanup() {
	kill "$MOCHI_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "▸ wait for mochi"
for i in $(seq 1 60); do
	if curl -sf "http://127.0.0.1:3335/posts/small" >/dev/null; then
		break
	fi
	sleep 1
	if [ "$i" -eq 60 ]; then
		echo "mochi failed to start"
		exit 1
	fi
done

echo "▸ run benchmark"
node benchmark.ts --config frameworks.config.json --out results/latest.md --json

echo "✓ done — see bench/results/latest.md"
