#!/usr/bin/env node
/* oxlint-disable no-explicit-any -- CLI manipulates sv-utils' untyped estree AST; `any` is pragmatic here. */
// ─────────────────────────────────────────────────────────────────────────────
// `ogygia` CLI — `npx ogygia init`.
//
// One command to wire ogygia into a SvelteKit app: installs the package, registers the Vite plugin
// before `sveltekit()`, wires the server handle and the transport codec (merging/sequencing into any
// you already have), and drops the one-line keepalive layout that keeps SvelteKit building the client
// on all-`csr=false` apps. Optional markdown content collections via prompt or `--markdown`.
//
// This lives in the CORE package (not a separate `sv` add-on) so the command is simply `ogygia init`.
// A bin has none of `sv`'s community-add-on restrictions, so we depend on `@sveltejs/sv-utils` for the
// codemods and BUNDLE it into this file at build time — ogygia declares no extra runtime dependency.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { color, fileExists, loadFile, saveFile, transforms } from '@sveltejs/sv-utils';

const require = createRequire(import.meta.url);
// This CLI ships inside `ogygia`, so our own version IS the version to pin the user's dependency to.
const { version } = require('../package.json') as { version: string };

// sv-utils `color` exposes semantic helpers (no bold/green/cyan/red) — alias to what we need.
const strong = color.command;
const accent = color.command;
const ok = color.success;
const bad = color.error;
const link = color.website;
const dim = color.dim;

// ── argv ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const command = argv[0];
const flags = new Set(argv.slice(1).filter((a) => a.startsWith('-')));

if (command !== 'init') {
	const unknown = command && command !== 'help' && !command.startsWith('-');
	stdout.write(
		`${strong('ogygia')} ${dim(`v${version}`)}\n\n` +
			`Usage:\n` +
			`  ${accent('npx ogygia init')} ${dim('[--markdown] [--no-install] [-y]')}\n\n` +
			`Wires ogygia into the SvelteKit app in the current directory.\n` +
			`  --markdown / --no-markdown   turn markdown content collections on/off (else you are asked)\n` +
			`  -y, --yes                    accept defaults, no prompts\n` +
			`  --no-install                 edit package.json but skip installing\n`
	);
	process.exit(unknown ? 1 : 0);
}

const cwd = process.cwd();
const wantMarkdown = flags.has('--markdown') ? true : flags.has('--no-markdown') ? false : null;
const yes = flags.has('-y') || flags.has('--yes');
const noInstall = flags.has('--no-install');

// ── small helpers ────────────────────────────────────────────────────────────
function die(msg: string): never {
	stdout.write(`\n${bad('✗')} ${msg}\n`);
	process.exit(1);
}

/** Read → transform → write, only touching disk when the content actually changes. */
function editFile(rel: string, transform: (content: string) => string): void {
	const before = loadFile(cwd, rel); // '' when absent
	const after = transform(before);
	if (after !== before) saveFile(cwd, rel, after);
}

async function confirm(question: string, fallback: boolean): Promise<boolean> {
	if (!stdin.isTTY) return fallback;
	const rl = createInterface({ input: stdin, output: stdout });
	const hint = fallback ? 'Y/n' : 'y/N';
	const answer = (await rl.question(`${accent('?')} ${question} ${dim(`(${hint})`)} `))
		.trim()
		.toLowerCase();
	rl.close();
	if (answer === '') return fallback;
	return answer === 'y' || answer === 'yes';
}

// ── AST predicates (shared with the wiring below) ────────────────────────────
type AnyNode = any;

/** Is `p` the spread element `...ogygia.transport`? */
function isOgygiaTransportSpread(p: AnyNode): boolean {
	return (
		p.type === 'SpreadElement' &&
		p.argument.type === 'MemberExpression' &&
		p.argument.object.type === 'Identifier' &&
		p.argument.object.name === 'ogygia' &&
		p.argument.property.type === 'Identifier' &&
		p.argument.property.name === 'transport'
	);
}

/** Find a top-level `export const <name> = …` declarator in a Program AST, or null. */
function findExportedConst(ast: AnyNode, name: string): AnyNode | null {
	for (const node of ast.body) {
		if (node.type !== 'ExportNamedDeclaration') continue;
		if (node.declaration?.type !== 'VariableDeclaration') continue;
		const d = node.declaration.declarations.find(
			(dc: AnyNode) => dc.id.type === 'Identifier' && dc.id.name === name
		);
		if (d) return d;
	}
	return null;
}

/** Walk an estree AST for the first `<name>(…)` call expression. */
function findCall(node: AnyNode, name: string): AnyNode | null {
	if (!node || typeof node !== 'object') return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findCall(child, name);
			if (found) return found;
		}
		return null;
	}
	if (
		node.type === 'CallExpression' &&
		node.callee?.type === 'Identifier' &&
		node.callee.name === name
	) {
		return node;
	}
	for (const key in node) {
		if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
		const found = findCall(node[key], name);
		if (found) return found;
	}
	return null;
}

// ── run ──────────────────────────────────────────────────────────────────────
async function run() {
	// Must be a SvelteKit project.
	const pkgRaw = loadFile(cwd, 'package.json');
	if (!pkgRaw) die(`no package.json in ${strong(cwd)} — run this inside your SvelteKit project.`);
	let pkg: AnyNode;
	try {
		pkg = JSON.parse(pkgRaw);
	} catch {
		die('package.json is not valid JSON.');
	}
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
	if (!allDeps['@sveltejs/kit']) {
		die('this does not look like a SvelteKit project (`@sveltejs/kit` is not a dependency).');
	}

	// Language + vite config location.
	const viteConfig = fileExists(cwd, 'vite.config.ts')
		? 'vite.config.ts'
		: fileExists(cwd, 'vite.config.js')
			? 'vite.config.js'
			: die('could not find vite.config.ts or vite.config.js.');
	const ext = viteConfig.endsWith('.ts') || fileExists(cwd, 'tsconfig.json') ? 'ts' : 'js';

	// Markdown: flag wins, else prompt (default off), else default off in non-interactive.
	const markdown = wantMarkdown ?? (yes ? false : await confirm('Add markdown content collections (.md / .svx)?', false));

	stdout.write(`\n${strong('ogygia')} — wiring your project…\n`);

	// 1. Dependency — pinned to this CLI's own (matching) version.
	if (!pkg.dependencies?.[ 'ogygia' ]) {
		pkg.dependencies = { ...(pkg.dependencies ?? {}), ogygia: `^${version}` };
		// Preserve the file's existing indentation.
		const indent = /\n(\t| +)/.exec(pkgRaw)?.[1] ?? '\t';
		saveFile(cwd, 'package.json', JSON.stringify(pkg, null, indent) + '\n');
	}
	stdout.write(`  ${ok('✓')} dependency ${dim(`ogygia@^${version}`)}\n`);

	// 2. vite.config — ogygia() BEFORE sveltekit() (mode: 'prepend'). With markdown on, opt into
	//    content/markdown and wire the .md/.svx extensions + preprocessor into the sveltekit() call.
	editFile(
		viteConfig,
		transforms.script(({ ast, js }) => {
			js.imports.addNamed(ast, { from: 'ogygia/vite', imports: ['ogygia'] });
			js.vite.addPlugin(ast, {
				code: markdown ? 'ogygia({ content: { markdown: {} } })' : 'ogygia()',
				mode: 'prepend'
			});

			if (!markdown) return;

			js.imports.addNamed(ast, {
				from: '@sveltejs/vite-plugin-svelte',
				imports: ['vitePreprocess']
			});
			try {
				const svelteKitCall = findCall(ast, 'sveltekit');
				if (!svelteKitCall) return;
				let optsObj = svelteKitCall.arguments[0];
				if (!optsObj || optsObj.type !== 'ObjectExpression') {
					optsObj = js.object.create({});
					svelteKitCall.arguments[0] = optsObj;
				}
				const has = (name: string) =>
					optsObj.properties.some(
						(p: AnyNode) => p.type === 'Property' && p.key && p.key.name === name
					);
				if (!has('extensions')) {
					js.object.property(optsObj, {
						name: 'extensions',
						fallback: js.common.parseExpression('ogygia.extensions()')
					});
				}
				if (!has('preprocess')) {
					js.object.property(optsObj, {
						name: 'preprocess',
						fallback: js.common.parseExpression('[vitePreprocess(), ...ogygia.preprocess()]')
					});
				}
			} catch {
				// Unusual vite.config shape — nextSteps covers the manual markdown wiring.
			}
		})
	);
	stdout.write(`  ${ok('✓')} ${viteConfig} ${dim(markdown ? '(+ markdown)' : '')}\n`);

	// 3. Universal hooks — the transport codec. Canonical: `export const transport = ogygia.transport`.
	//    Merge into an existing `transport` instead of clobbering the author's own codecs.
	editFile(
		`src/hooks.${ext}`,
		transforms.script(({ ast, js }) => {
			js.imports.addNamespace(ast, { from: 'ogygia', as: 'ogygia' });
			const existing = findExportedConst(ast, 'transport');
			const spread = () => js.common.createSpread(js.common.parseExpression('ogygia.transport'));

			if (!existing) {
				js.exports.createNamed(ast, {
					name: 'transport',
					fallback: js.variables.declaration(ast, {
						kind: 'const',
						name: 'transport',
						value: js.common.parseExpression('ogygia.transport')
					})
				});
				return;
			}
			const init = existing.init;
			if (init?.type === 'ObjectExpression') {
				if (!init.properties.some(isOgygiaTransportSpread)) init.properties.unshift(spread());
			} else if (
				init?.type === 'MemberExpression' &&
				init.object?.name === 'ogygia' &&
				init.property?.name === 'transport'
			) {
				// already exactly ogygia.transport
			} else if (init) {
				const wrapped = js.object.create({});
				wrapped.properties.push(spread(), js.common.createSpread(init));
				existing.init = wrapped;
			}
		})
	);
	stdout.write(`  ${ok('✓')} src/hooks.${ext} ${dim('(transport)')}\n`);

	// 4. Server hooks — the region endpoint. `addHooksHandle` sequences with an existing handle.
	editFile(
		`src/hooks.server.${ext}`,
		transforms.script(({ ast, js, comments }) => {
			js.imports.addNamespace(ast, { from: 'ogygia/server', as: 'ogygia' });
			js.kit.addHooksHandle(ast, {
				language: ext,
				newHandleName: 'ogygiaHandle',
				handleContent: 'ogygia.handle()',
				comments
			});
		})
	);
	stdout.write(`  ${ok('✓')} src/hooks.server.${ext} ${dim('(handle)')}\n`);

	// (The all-csr=false client-build keepalive needs no file — ogygia's Vite plugin injects a
	//  URL-less route during the build and removes it at process exit. We just gitignore the folder
	//  in case a build is ever hard-killed before cleanup.)
	editFile('.gitignore', (c) => {
		if (c.includes('.ogygia-keep-client')) return c;
		const line = '# ogygia build-time keep-client route (auto-removed; only survives a crashed build)\n**/.ogygia-keep-client/\n';
		return c.trim() ? c.replace(/\n*$/, '\n\n') + line : line;
	});

	// 5. Ambient types — one reference line so `svelte-check` / `tsc` resolve the `virtual:ogygia/*`
	//    modules the shipped source imports. TS projects only; never clobber an existing file.
	if (ext === 'ts') {
		editFile('src/ogygia.d.ts', (c) =>
			c.includes('ogygia/types') ? c : (c.trim() ? c.replace(/\n*$/, '\n\n') : '') + '/// <reference types="ogygia/types" />\n'
		);
		stdout.write(`  ${ok('✓')} src/ogygia.d.ts ${dim('(types)')}\n`);
	}

	// 6. Install (best-effort; skipped with --no-install).
	if (!noInstall) {
		const pm = existsSync(path.join(cwd, 'pnpm-lock.yaml'))
			? 'pnpm'
			: existsSync(path.join(cwd, 'yarn.lock'))
				? 'yarn'
				: existsSync(path.join(cwd, 'bun.lockb')) || existsSync(path.join(cwd, 'bun.lock'))
					? 'bun'
					: 'npm';
		stdout.write(`\n  Installing with ${accent(pm)}…\n`);
		const res = spawnSync(pm, ['install'], {
			cwd,
			stdio: 'inherit',
			shell: process.platform === 'win32'
		});
		if (res.status !== 0) {
			stdout.write(`  ${bad('✗')} install failed — run ${accent(`${pm} install`)} yourself.\n`);
		}
	}

	// 7. Next steps.
	stdout.write(
		`\n${ok('✔')} ogygia is wired up.\n\n` +
			`Next:\n` +
			`  • Opt a route out of the client: ${dim('export const csr = false')} in its +page.\n` +
			`  • Make a component interactive:\n` +
			`      ${dim("import Counter from './Counter.svelte' with { wake: 'load' };")}\n` +
			(markdown ? `  • Markdown is on: author .md / .svx content collections.\n` : '') +
			`  Docs: ${accent('https://ogygia.puruvj.dev')}\n`
	);
}

run().catch((err) => die(err?.message ?? String(err)));
