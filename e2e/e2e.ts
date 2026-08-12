#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// ogygia — single e2e entrypoint.
//
// Runs EVERY end-to-end suite in sequence and fails if any one fails:
//   1. verify       — the full library suite (islands, lakes, server islands, remotes, router, …)
//                     against a built + served playground.
//   2. adapters     — builds the all-csr=false fixture with each adapter, boots the real output on
//                     its closest offline emulator, and drives a browser (island hydrates, runtime
//                     serves, keepalive cleaned up).
// Add new suites to SUITES below — this is the one script CI and humans run.
//
//   node verify/e2e.ts                 # everything
//   node verify/e2e.ts --only=adapters # a subset
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const passthru = process.argv.slice(2).filter((a) => !a.startsWith('--only='));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',').map((s) => s.trim());

const SUITES: Array<{ name: string; script: string; args?: string[] }> = [
	{ name: 'verify', script: `${HERE}run.ts` },
	{ name: 'adapters', script: `${HERE}adapters/run.ts` }
];

const RED = '\x1b[31m', GREEN = '\x1b[32m', BOLD = '\x1b[1m', RESET = '\x1b[0m';
const results: Array<[string, boolean]> = [];

for (const suite of SUITES) {
	if (only && !only.includes(suite.name)) continue;
	console.log(`\n${BOLD}╔══ e2e suite: ${suite.name} ══╗${RESET}\n`);
	const status = spawnSync('node', [suite.script, ...(suite.args ?? []), ...passthru], {
		stdio: 'inherit'
	}).status;
	results.push([suite.name, status === 0]);
}

console.log(`\n${BOLD}════ e2e summary ════${RESET}`);
for (const [name, ok] of results) console.log(`  ${ok ? GREEN + '✓' : RED + '✗'}${RESET} ${name}`);
process.exit(results.some(([, ok]) => !ok) ? 1 : 0);
