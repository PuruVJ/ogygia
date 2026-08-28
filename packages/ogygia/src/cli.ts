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
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
	color,
	fileExists,
	loadFile,
	saveFile,
	svelteConfig,
	transforms
} from '@sveltejs/sv-utils';

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

if (
	command !== 'init' &&
	command !== 'site' &&
	command !== 'mcp' &&
	command !== 'ai' &&
	command !== 'keys' &&
	command !== 'fragments'
) {
	const unknown = command && command !== 'help' && !command.startsWith('-');
	stdout.write(
		`${strong('ogygia')} ${dim(`v${version}`)}\n\n` +
			`Usage:\n` +
			`  ${accent('npx ogygia init')} ${dim('[--markdown] [--no-install] [-y]')}\n` +
			`  ${accent('npx ogygia site init')} ${dim('[--layout <path>] [--force] [--no-install] [-y]')}\n` +
			`  ${accent('npx ogygia keys')} ${dim('[name] (mint an Ed25519 pair for fragment-federation signing)')}\n` +
			`  ${accent('npx ogygia fragments')} ${dim('<origin> [--out <file>] [--check <file>] (typed widget-catalog stubs + CI drift check)')}\n` +
			`  ${accent('npx ogygia ai')} ${dim('(install the Claude skill + register the MCP server)')}\n` +
			`  ${accent('npx ogygia mcp')} ${dim('(stdio MCP server — hand ogygia components to an AI)')}\n\n` +
			`${strong('init')}  — wires ogygia into the SvelteKit app in the current directory.\n` +
			`  --markdown / --no-markdown   turn markdown content collections on/off (else you are asked)\n` +
			`  -y, --yes                    accept defaults, no prompts\n` +
			`  --no-install                 edit package.json but skip installing\n\n` +
			`${strong('site init')}  — scaffolds a docs site (site, content, routes, a Shell layout).\n` +
			`  --layout <path>              layout route to write (default ${dim('src/routes/+layout.svelte')})\n` +
			`  --force                      overwrite existing route/site files (the layout always asks)\n` +
			`  -y, --yes                    accept defaults, no prompts\n\n` +
			`${strong('keys')}  — prints a caller keypair as env lines (${dim('<NAME>_SIGNING_KEY')} stays with the caller,\n` +
			`  ${dim('<NAME>_PUBLIC_KEY')} goes to the apps it calls). Redirect where you like: ${dim('npx ogygia keys shell >> keys.env')}\n\n` +
			`${strong('fragments')}  — typed stubs for an MFE's widget catalog (its unsigned ${dim('__catalog')} manifest).\n` +
			`  ${dim('--out stubs.ts')} writes the stub; ${dim('--check stubs.ts')} exits 1 when the live catalog drifted (CI).\n\n` +
			`${strong('ai')}  — installs the ogygia Claude skill into ${dim('.claude/skills/ogygia/')} and registers the MCP\n` +
			`  server in ${dim('.mcp.json')}, so any agent on this repo gets the mental model + live compiler tools.\n\n` +
			`${strong('mcp')}  — runs a Model Context Protocol server on stdio. Point an MCP client at it to give an\n` +
			`  AI the real ogygia compiler: compile a component, read its island map, validate it, explain it.\n`
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

// ── preflight (shared by `init` and `site init`) ───────────────────────────
interface Preflight {
	pkg: AnyNode;
	pkgRaw: string;
	viteConfig: string;
	ext: 'ts' | 'js';
}

function preflight(): Preflight {
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
	const viteConfig = fileExists(cwd, 'vite.config.ts')
		? 'vite.config.ts'
		: fileExists(cwd, 'vite.config.js')
			? 'vite.config.js'
			: die('could not find vite.config.ts or vite.config.js.');
	const ext = viteConfig.endsWith('.ts') || fileExists(cwd, 'tsconfig.json') ? 'ts' : 'js';
	return { pkg, pkgRaw, viteConfig, ext };
}

/** Add `ogygia@^version` to dependencies (idempotent). */
function addOgygiaDep(pf: Preflight): void {
	if (!pf.pkg.dependencies?.['ogygia']) {
		pf.pkg.dependencies = { ...(pf.pkg.dependencies ?? {}), ogygia: `^${version}` };
		const indent = /\n(\t| +)/.exec(pf.pkgRaw)?.[1] ?? '\t';
		saveFile(cwd, 'package.json', JSON.stringify(pf.pkg, null, indent) + '\n');
	}
}

/** A minimal `sv`-style file API over the real cwd, for helpers that expect `sv.file(path, edit)`. */
const svFileApi = {
	file(rel: string, edit: (content: string) => string | false): void {
		const before = loadFile(cwd, rel); // '' when absent
		const after = edit(before);
		if (after !== false && after !== before) saveFile(cwd, rel, after);
	}
};

/**
 * Wire `.svx` support + (optionally) the async compiler into wherever the svelte/kit config lives —
 * a `svelte.config.{js,ts}` OR the `sveltekit({ … })` call in `vite.config`. `svelteConfig.edit`
 * routes each option to the right place. We MERGE (never clobber) an existing `preprocess`/`extensions`.
 */
function wireSvelteConfig(asyncCompiler: boolean): void {
	svelteConfig.edit({ sv: svFileApi, cwd }, ({ ast, js, property, override }) => {
		js.imports.addNamed(ast, { from: '@sveltejs/vite-plugin-svelte', imports: ['vitePreprocess'] });
		js.imports.addNamed(ast, { from: 'ogygia/vite', imports: ['ogygia'] });

		// extensions — create `ogygia.extensions()` if absent; if an array is already there, spread ours in.
		const extFallback = js.common.parseExpression('ogygia.extensions()');
		const ext = property('extensions', { fallback: extFallback });
		if (ext !== extFallback && ext.type === 'ArrayExpression') {
			ext.elements.push(js.common.createSpread(js.common.parseExpression('ogygia.extensions()')));
		}

		// preprocess — must include `...ogygia.preprocess()`. Merge into an array; wrap a lone value.
		const ppFallback = js.common.parseExpression('[vitePreprocess(), ...ogygia.preprocess()]');
		const pp = property('preprocess', { fallback: ppFallback });
		if (pp !== ppFallback) {
			const spread = js.common.createSpread(js.common.parseExpression('ogygia.preprocess()'));
			if (pp.type === 'ArrayExpression') {
				pp.elements.push(spread);
			} else {
				// `[ <existing>, ...ogygia.preprocess() ]` — parse a well-formed array, drop in the existing.
				const arr = js.common.parseExpression('[0, ...ogygia.preprocess()]') as AnyNode;
				arr.elements[0] = pp;
				override({ preprocess: arr });
			}
		}

		// experimental.async — site-layer components use top-level `await`; the compiler needs this on.
		if (asyncCompiler) {
			const co = property('compilerOptions', { fallback: js.object.create({}) });
			const experimental = js.object.property(co, {
				name: 'experimental',
				fallback: js.object.create({})
			});
			js.object.property(experimental, {
				name: 'async',
				fallback: js.common.parseExpression('true')
			});
		}
	});
}

/** Steps that wire the ogygia RUNTIME into the app (plugin, hooks, types). Shared by both commands. */
function wireOgygia(pf: Preflight, markdown: boolean, asyncCompiler = false): void {
	const { viteConfig, ext } = pf;

	// 1. Dependency — pinned to this CLI's own (matching) version.
	addOgygiaDep(pf);
	stdout.write(`  ${ok('✓')} dependency ${dim(`ogygia@^${version}`)}\n`);

	// 2. vite.config — the ogygia() plugin BEFORE sveltekit() (mode: 'prepend'). Compiler/preprocess
	//    options do NOT go here — passing args to `sveltekit()` silently drops svelte.config settings
	//    (e.g. experimental.async). Those go through `wireSvelteConfig` below, to the right file.
	editFile(
		viteConfig,
		transforms.script(({ ast, js }) => {
			js.imports.addNamed(ast, { from: 'ogygia/vite', imports: ['ogygia'] });
			js.vite.addPlugin(ast, {
				code: markdown ? 'ogygia({ content: { markdown: {} } })' : 'ogygia()',
				mode: 'prepend'
			});
		})
	);
	stdout.write(`  ${ok('✓')} ${viteConfig} ${dim('(plugin)')}\n`);

	// 2b. svelte config — `.svx` extensions + preprocessor (and the async compiler for the site layer).
	if (markdown) {
		wireSvelteConfig(asyncCompiler);
		stdout.write(
			`  ${ok('✓')} svelte config ${dim(asyncCompiler ? '(.svx + async)' : '(.svx)')}\n`
		);
	}

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
		const line =
			'# ogygia build-time keep-client route (auto-removed; only survives a crashed build)\n**/.ogygia-keep-client/\n';
		return c.trim() ? c.replace(/\n*$/, '\n\n') + line : line;
	});

	// 5. Ambient types — one reference line so `svelte-check` / `tsc` resolve the `virtual:ogygia/*`
	//    modules the shipped source imports. TS projects only; never clobber an existing file.
	if (ext === 'ts') {
		editFile('src/ogygia.d.ts', (c) =>
			c.includes('ogygia/types')
				? c
				: (c.trim() ? c.replace(/\n*$/, '\n\n') : '') + '/// <reference types="ogygia/types" />\n'
		);
		stdout.write(`  ${ok('✓')} src/ogygia.d.ts ${dim('(types)')}\n`);
	}
}

/** Install with the detected package manager (best-effort). */
function installDeps(): void {
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

// ── `ogygia init` ────────────────────────────────────────────────────────────
async function run() {
	const pf = preflight();
	// Markdown: flag wins, else prompt (default off), else default off in non-interactive.
	const markdown =
		wantMarkdown ??
		(yes ? false : await confirm('Add markdown content collections (.md / .svx)?', false));

	stdout.write(`\n${strong('ogygia')} — wiring your project…\n`);
	wireOgygia(pf, markdown);
	if (!noInstall) installDeps();

	stdout.write(
		`\n${ok('✔')} ogygia is wired up.\n\n` +
			`Next:\n` +
			`  • Opt a route out of the client: ${dim('export const csr = false')} in its +page.\n` +
			`  • Make a component interactive:\n` +
			`      ${dim("import Counter from './Counter.svelte' with { wake: 'load' };")}\n` +
			(markdown ? `  • Markdown is on: author .md / .svx content collections.\n` : '') +
			`  • Scaffold a docs site: ${accent('npx ogygia site init')}\n` +
			`  Docs: ${accent('https://ogygia.puruvj.dev')}\n`
	);
}

// ── `ogygia site init` ─────────────────────────────────────────────────────
// Scaffolds a docs site as REAL files — no build-time magic, no template to pick. It writes the
// PHAROS-LEVEL plumbing (site, content, the three-file mount, emit routes) and a layout that mounts
// `<Shell>` — the Shell is just a component you import, not a theme the CLI branches on. The layout is
// the one interactive decision (it's the file you own); everything else is created if absent, skipped
// if you already wrote it (unless `--force`). Agents can drive it non-interactively with flags + `-y`.

/** Write a file, creating parent dirs. Skips an existing file unless `overwrite`. Returns written?. */
function place(rel: string, content: string, overwrite: boolean): boolean {
	const existed = fileExists(cwd, rel);
	if (existed && !overwrite) {
		stdout.write(`  ${dim('•')} ${rel} ${dim('(exists, kept)')}\n`);
		return false;
	}
	const abs = path.join(cwd, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, content);
	stdout.write(`  ${ok('✓')} ${rel}${existed ? dim(' (overwritten)') : ''}\n`);
	return true;
}

/** `ogygia ai` — install the Claude skill + register the MCP server so agents on this repo get both. */
async function ai_install(): Promise<void> {
	stdout.write(`\n${strong('ogygia ai')} ${dim('— Claude skill + MCP server')}\n\n`);

	// 1. the skill (bundled at ai/SKILL.md, a sibling of dist/) → .claude/skills/ogygia/
	let skill: string;
	try {
		skill = readFileSync(new URL('../ai/SKILL.md', import.meta.url), 'utf8');
	} catch {
		die('could not read the bundled skill — ai/SKILL.md is missing from the ogygia package.');
	}
	place('.claude/skills/ogygia/SKILL.md', skill, true);

	// 2. the MCP server → .mcp.json (MERGE — never clobber other servers the project registered)
	const rel = '.mcp.json';
	const abs = path.join(cwd, rel);
	let cfg: { mcpServers?: Record<string, unknown>; [k: string]: unknown } = {};
	if (existsSync(abs)) {
		try {
			cfg = JSON.parse(readFileSync(abs, 'utf8'));
		} catch {
			die(`${rel} exists but is not valid JSON — fix or remove it, then re-run.`);
		}
	}
	cfg.mcpServers = cfg.mcpServers ?? {};
	const already = 'ogygia' in cfg.mcpServers;
	cfg.mcpServers.ogygia = { command: 'npx', args: ['ogygia', 'mcp'] };
	writeFileSync(abs, JSON.stringify(cfg, null, '\t') + '\n');
	stdout.write(
		`  ${ok('✓')} ${rel} ${dim(already ? '(ogygia server updated)' : '(ogygia server added)')}\n`
	);

	// 3. next steps
	stdout.write(
		`\n${ok('✓')} done — any agent on this repo now has:\n` +
			`  • the ${accent('ogygia')} skill — the mental model, read before inventing a workaround.\n` +
			`  • live tools ${accent('ogygia_check / compile / islands / explain')} via the MCP server.\n\n` +
			`  In Claude Code the ${accent('.mcp.json')} server loads on next start ${dim('(approve it when prompted)')}.\n` +
			`  Sanity-check the server: ${accent('npx ogygia mcp')} ${dim('→ should log “ready — 4 tools”, then Ctrl-C.')}\n`
	);
}

async function site_init(): Promise<void> {
	// argv: site init [--layout p] [--force] [-y] [--no-install]
	if (argv[1] !== 'init') {
		stdout.write(
			`${strong('ogygia site')} ${dim(`v${version}`)}\n\n` +
				`Usage:\n  ${accent('npx ogygia site init')} ${dim('[--layout <path>] [--force] [--no-install] [-y]')}\n\n` +
				`Scaffolds a docs site (site + content + routes + a Shell layout).\n`
		);
		process.exit(argv[1] ? 1 : 0);
	}

	const rest = argv.slice(2);
	let flagLayout: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === '--layout') flagLayout = rest[++i];
	}
	const restFlags = new Set(rest.filter((a) => a.startsWith('-')));
	const force = restFlags.has('--force');
	const yesP = restFlags.has('-y') || restFlags.has('--yes');
	const noInstallP = restFlags.has('--no-install');

	const pf = preflight();

	// The layout — the ONE file you own. Its DIRECTORY is where the docs mount; a nested layout
	// (e.g. src/routes/docs/+layout.svelte) mounts the site under that URL prefix.
	const layoutRel = (flagLayout || 'src/routes/+layout.svelte').replace(/\\/g, '/');
	if (!layoutRel.startsWith('src/routes/') || path.basename(layoutRel) !== '+layout.svelte') {
		die(`--layout must be a +layout.svelte under src/routes (got ${strong(layoutRel)}).`);
	}
	const routeDir = path.posix.dirname(layoutRel); // 'src/routes' | 'src/routes/docs'
	const sub = routeDir.slice('src/routes'.length); // '' | '/docs'
	const urlBase = sub; // mount prefix in URLs ('' = root)
	const rd = (rel: string) => path.posix.join(routeDir, rel);
	const emitArg = urlBase ? `{ base: ${JSON.stringify(urlBase)} }` : '';
	const searchBase = urlBase ? `, { base: ${JSON.stringify(urlBase)} }` : '';

	stdout.write(`\n${strong('ogygia site')} — scaffolding your docs site…\n`);

	// Wire the ogygia runtime (plugin + markdown + hooks). Idempotent; the site layer needs .svx, the async
	// compiler (its components use top-level await), and the server handle.
	wireOgygia(pf, true, true);

	// The site — nav, doc resolver, search, sitemap/llms/raw, prev/next. Never clobbered without --force.
	place(
		'src/lib/docs.ts',
		`import { content, outline, site } from 'ogygia/content';

// A docs collection: every file under \`src/content/docs\` becomes a page. Its id is the path below
// \`content/docs\` without the extension, so \`guides/deploy.svx\` is served at \`/guides/deploy\`.
const guides = content({
	loader: import.meta.og.loader.markdown('../content/docs')
});

// \`site()\` mints the site the shell + routes consume — name it what it is.
export const docs = site({ outline: outline([{ label: 'Docs', items: guides }]), prevNext: 'graph' });
`,
		force
	);

	// Starter content (two pages) — only if the docs folder has no pages yet.
	const hasContent = globHasSvx(path.join(cwd, 'src/content/docs'));
	if (!hasContent || force) {
		place(
			'src/content/docs/introduction.svx',
			`---
title: Introduction
summary: What this site is.
---

Welcome to your docs, built with **ogygia**. The page title comes from the
frontmatter above, so start the body at \`##\`. Every \`.svx\` file in \`src/content/docs\`
becomes a page — this one lives at \`src/content/docs/introduction.svx\`.

## What you get

The shell gives you navigation, full-text search (press \`⌘K\`), an on-this-page rail,
and light / dark out of the box.
`,
			force
		);
		place(
			'src/content/docs/getting-started.svx',
			`---
title: Getting started
summary: Add your own pages.
---

Drop a new \`.svx\` file into \`src/content/docs\` and it becomes a page. The file path is
the URL: \`src/content/docs/guides/deploy.svx\` is served at \`/guides/deploy\`.

## Live components

Because ogygia renders islands, you can place an interactive Svelte component right in
your prose and it hydrates on its own — no client bundle for the rest of the page.
`,
			force
		);
	} else {
		stdout.write(`  ${dim('•')} src/content/docs ${dim('(has pages, kept)')}\n`);
	}

	// Doc route — the three-file mount + the render page.
	place(
		rd('[...slug]/+page.ts'),
		`import { docs } from '$lib/docs';

// The three-file mount: page options are yours; load + entries come off the site.
export const prerender = true;
export const load = docs.load;
export const entries = docs.entries;
`,
		force
	);
	place(
		rd('[...slug]/+page.svelte'),
		`<script lang="ts">
	import { page } from '$app/state';
	import { Doc } from 'ogygia/content';
	import { docs } from '$lib/docs';

	// csr=false: the body renders in this route's SSR pass, so islands inside the .svx hydrate.
	const view = (await docs.page(page.params.slug ?? ''))!;
</script>

<Doc {view} />
`,
		force
	);

	// Route options for the subtree (csr=false server islands, prerendered).
	place(
		rd('+layout.ts'),
		`// ogygia renders server-side islands — opt this subtree out of the SPA client and prerender it.
export const csr = false;
export const prerender = true;
`,
		force
	);

	// Home page (the mount root) — a landing that links into the first doc, so \`/\` never 404s.
	place(
		rd('+page.svelte'),
		`<script lang="ts">
	import { docs } from '$lib/docs';

	// \`docs.nav()\` is plain data — queryable outside the sidebar. Find the first real page to link to.
	const tree = await docs.nav(${emitArg || ''});
	const first = tree
		.flatMap((n) => (n.kind === 'group' ? n.items : [n]))
		.find((n) => n.kind === 'leaf');
</script>

<svelte:head><title>Docs</title></svelte:head>

<div class="og-home">
	<h1 class="og-home-title">Your docs</h1>
	<p class="og-home-lede">Built with ogygia. Edit this page and the sidebar in your project.</p>
	{#if first && first.kind === 'leaf'}
		<a class="og-home-cta" href={first.href}>Start reading → {first.title}</a>
	{/if}
</div>

<style>
	.og-home { max-width: 42rem; margin: 0 auto; padding: 4rem 0; }
	.og-home-title { margin: 0 0 0.5rem; font-size: 2rem; letter-spacing: -0.02em; }
	.og-home-lede { margin: 0 0 1.5rem; color: var(--og-text-dim, #5b6069); }
	.og-home-cta { color: var(--og-accent, #0d9488); font-weight: 600; text-decoration: none; }
</style>
`,
		force
	);

	// The layout — the one file that might already be yours. Three cases:
	//  · absent            → write it.
	//  · already our Shell layout → keep it, so re-running is idempotent (the "redeemable" case).
	//  · a DIFFERENT layout you wrote  → never clobber without opt-in: `--force`, or a "yes" at the
	//    interactive prompt. `-y` (accept safe defaults) does NOT clobber — it aborts with guidance.
	const layoutBody = `<script lang="ts">
	import DocsShell from 'ogygia/content/docs-shell';
	// Styling is opt-in — import the stock look here, or delete these two lines and bring your own
	// CSS against the \`.og-*\` hooks.
	import 'ogygia/content/theme.css';
	import 'ogygia/content/shell.css';
	import { docs } from '$lib/docs';

	let { children } = $props();
</script>

<DocsShell site={docs} base=${JSON.stringify(urlBase)} title="Docs">
	{@render children()}
</DocsShell>
`;
	const layoutExisted = fileExists(cwd, layoutRel);
	const layoutIsOurs =
		layoutExisted &&
		/from ['"]ogygia\/content(\/docs-shell)?['"]/.test(loadFile(cwd, layoutRel)) &&
		loadFile(cwd, layoutRel).includes('Shell');

	if (!layoutExisted || force) {
		place(layoutRel, layoutBody, true);
	} else if (layoutIsOurs) {
		stdout.write(`  ${dim('•')} ${layoutRel} ${dim('(ogygia shell, kept)')}\n`);
	} else {
		const proceed =
			stdin.isTTY && !yesP
				? await confirm(`${strong(layoutRel)} exists — overwrite EVERYTHING in it?`, false)
				: false;
		if (!proceed) {
			die(
				`${strong(layoutRel)} already exists. Re-run with ${accent('--force')} to overwrite it, ` +
					`or ${accent('--layout <path>')} to write the shell somewhere else.`
			);
		}
		place(layoutRel, layoutBody, true);
	}

	// Emit routes — search index, sitemap, llms.txt, raw markdown, and the no-JS /search page.
	place(
		rd('search.json/+server.ts'),
		`import { docs } from '$lib/docs';

export const prerender = true;
export const GET = docs.emit.search(${emitArg});
`,
		force
	);
	place(
		rd('sitemap.xml/+server.ts'),
		`import { docs } from '$lib/docs';

export const prerender = true;
export const GET = docs.emit.sitemap(${emitArg});
`,
		force
	);
	place(
		rd('llms.txt/+server.ts'),
		`import { docs } from '$lib/docs';

export const prerender = true;
export const GET = docs.emit.llms(${emitArg});
`,
		force
	);
	place(
		rd('[...slug].md/+server.ts'),
		`import { docs } from '$lib/docs';

// Every doc, served as raw markdown at \`<slug>.md\` (great for LLMs and \`view source\`).
export const prerender = true;
const raw = docs.emit.raw();
export const GET = raw.GET;
export const entries = raw.entries;
`,
		force
	);
	place(
		rd('search/+page.server.ts'),
		`import { docs } from '$lib/docs';

// No-JS search: the /search page renders results server-side. With JS, the ⌘K palette takes over.
export const prerender = false;
export const load = async ({ url }) => {
	const q = (url.searchParams.get('q') ?? '').trim();
	return { q, hits: q ? await site.search(q${searchBase}) : [] };
};
`,
		force
	);
	place(
		rd('search/+page.svelte'),
		`<script lang="ts">
	import { SearchPage } from 'ogygia/content';
	let { data } = $props();
</script>

<svelte:head><title>Search</title></svelte:head>

<SearchPage q={data.q} hits={data.hits} />
`,
		force
	);

	// A friendly error page (uses the theme tokens so it matches the shell).
	place(
		rd('+error.svelte'),
		`<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="og-err">
	<p class="og-err-code">{page.status}</p>
	<h1 class="og-err-title">{page.status === 404 ? 'Page not found' : 'Something went wrong'}</h1>
	<p class="og-err-msg">{page.error?.message ?? 'Unknown error'}</p>
	<a class="og-err-home" href=${JSON.stringify(urlBase || '/')}>← Back to the docs</a>
</div>

<style>
	.og-err { max-width: 32rem; margin: 0 auto; padding: 6rem 1.5rem; text-align: center; }
	.og-err-code { margin: 0; font-size: 3rem; font-weight: 800; letter-spacing: -0.03em; color: var(--og-text-faint, #9096a1); }
	.og-err-title { margin: 0.25rem 0 0.5rem; font-size: 1.4rem; }
	.og-err-msg { margin: 0 0 1.5rem; color: var(--og-text-dim, #5b6069); }
	.og-err-home { color: var(--og-accent, #0d9488); text-decoration: none; font-weight: 600; }
</style>
`,
		force
	);

	if (!noInstallP) installDeps();

	stdout.write(
		`\n${ok('✔')} your docs site is scaffolded.\n\n` +
			`Next:\n` +
			`  • Start it: ${accent('npm run dev')} ${dim(`(then open ${urlBase || '/'})`)}\n` +
			`  • Write pages in ${dim('src/content/docs')} — the file path is the URL.\n` +
			`  • Tune the site (nav, versions, i18n) in ${dim('src/lib/docs.ts')}.\n` +
			`  Docs: ${accent('https://ogygia.puruvj.dev')}\n`
	);
}

/** True if any `.svx` file exists anywhere under `dir`. */
function globHasSvx(dir: string): boolean {
	let stack = [dir];
	while (stack.length) {
		const d = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isDirectory()) stack.push(path.join(d, e.name));
			else if (e.name.endsWith('.svx')) return true;
		}
	}
	return false;
}

// ── keys ─────────────────────────────────────────────────────────────────────
// Mint one Ed25519 caller pair for fragment-federation signing, in EXACTLY the format
// `sign`/`verify` consume (base64 PKCS8 DER private, base64 SPKI DER public) — the openssl
// flag maze (`-outform DER | base64`, `-pubout`) is where wrong keys and confusing 401s
// come from. Env lines go to STDOUT (redirectable, e.g. `>> keys.env`); guidance goes to
// STDERR so redirection captures ONLY secrets. Never writes a file.
const ENV_NAME_RE = /[^A-Z0-9]+/g;
const ENV_TRIM_RE = /^_|_$/g;
function keys_mint(): void {
	const raw = argv[1] && !argv[1].startsWith('-') ? argv[1] : 'ogygia';
	const name = raw.toUpperCase().replace(ENV_NAME_RE, '_').replace(ENV_TRIM_RE, '') || 'OGYGIA';
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	stdout.write(
		`export ${name}_SIGNING_KEY=${privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')}\n` +
			`export ${name}_PUBLIC_KEY=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}\n`
	);
	process.stderr.write(
		`\n${ok('✓')} minted an Ed25519 pair for caller ${strong(name)}\n` +
			`  ${dim('SIGNING (private)')} — stays with the caller; hand it to ${accent('client(origin, { sign })')}\n` +
			`  ${dim('PUBLIC')} — give to the apps it calls; list it in ${accent('expose(router, { verify: { publicKeys } })')}\n` +
			`  keep the private key in your secret store — never commit it\n`
	);
}

// ── fragments ────────────────────────────────────────────────────────────────
// Typed stubs for an MFE's widget catalog. Fetches the UNSIGNED `__catalog` manifest and emits
// a stub whose name union pins the consumable widgets; `--check` diffs the LIVE catalog against
// a committed stub in CI, so a renamed/removed widget fails the build instead of 404ing in prod.
function fragments_stub_source(origin: string, names: string[]): string {
	const union = names.length ? names.map((n) => JSON.stringify(n)).join(' | ') : 'never';
	return (
		`// generated by \`npx ogygia fragments ${origin}\` — do not edit\n` +
		`export type WidgetName = ${union};\n` +
		`export const WIDGET_NAMES = ${JSON.stringify(names)} as const;\n`
	);
}
async function fragments_stub(): Promise<void> {
	const origin = argv[1];
	if (!origin || origin.startsWith('-'))
		die('usage: npx ogygia fragments <origin> [--out <file>] [--check <file>]');
	const flag_val = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const out = flag_val('--out');
	const check = flag_val('--check');
	const u = new URL('/og/fragment/__catalog', origin);
	let names: string[];
	try {
		const res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) die(`catalog at ${u.href} answered ${res.status}`);
		const doc = (await res.json()) as { names?: unknown };
		if (!Array.isArray(doc.names) || !doc.names.every((n) => typeof n === 'string'))
			die(`catalog at ${u.href} did not answer { names: string[] }`);
		names = doc.names;
	} catch (e) {
		die(e instanceof Error ? e.message : String(e));
	}
	const source = fragments_stub_source(origin, names);
	if (check) {
		const existing = existsSync(check) ? readFileSync(check, 'utf8') : null;
		if (existing === null) die(`--check: ${check} does not exist (generate it with --out first)`);
		if (existing !== source) {
			stdout.write(
				`${bad('✗')} widget catalog DRIFTED from ${check}\n` +
					`  live:      ${names.join(', ') || '(empty)'}\n` +
					`  regenerate: ${accent(`npx ogygia fragments ${origin} --out ${check}`)}\n`
			);
			process.exit(1);
		}
		stdout.write(`${ok('✓')} widget catalog matches ${check} (${names.length} widget(s))\n`);
		return;
	}
	if (out) {
		writeFileSync(out, source);
		stdout.write(`${ok('✓')} wrote ${out} (${names.length} widget(s))\n`);
	} else {
		stdout.write(source);
	}
}

// ── dispatch ─────────────────────────────────────────────────────────────────
if (command === 'fragments') {
	fragments_stub().catch((err) => die(err?.message ?? String(err)));
} else if (command === 'keys') {
	keys_mint();
} else if (command === 'mcp') {
	// `./mcp.js` is a sibling in dist (its own library-built module, NOT bundled into this CLI — the
	// computed URL keeps rolldown from inlining the whole compiler here). It imports the compiler at
	// runtime and runs the stdio server until stdin closes.
	import(new URL('./mcp.js', import.meta.url).href)
		.then((m) => (m as { runMcp: () => Promise<void> }).runMcp())
		.catch((err) => die(err?.message ?? String(err)));
} else if (command === 'ai') {
	ai_install().catch((err) => die(err?.message ?? String(err)));
} else if (command === 'site') {
	site_init().catch((err) => die(err?.message ?? String(err)));
} else {
	run().catch((err) => die(err?.message ?? String(err)));
}
