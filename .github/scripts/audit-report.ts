// The dependency audit, as the users of ogygia's PUBLISHED packages meet it (every non-private
// package under packages/: `ogygia`, `@ogygia/core`, the `@ogygia/*` plugins, the CLI…). `pnpm audit`
// reads this repo's lockfile: every workspace (demo apps, internal tools) and every dev tool, at the
// versions this repo happens to have locked. An app that installs a package gets none of that: it gets
// the package's `dependencies`, resolved fresh within their ranges, beside the peers the app itself
// installs (Svelte, SvelteKit, Vite…). So the report splits each advisory by how it reaches a published
// package (from that package's own dependency tree, `pnpm list`: the audit's own path list is cut short
// and can miss a route):
//   1. dependencies — installed with the package. For a direct one: does the package's range already
//      allow a patched version (a fresh install gets the fix, only this repo's lockfile is behind)?
//   2. peer dependencies — the app installs and updates them, not the package.
//   3. dev dependencies — this repo's tooling, never installed by an app (collapsed).
// A package Svelte or SvelteKit also depends on is marked: the same advisory reaches every Svelte app.
// Advisories only in the repo's demo apps and internal tools are counted, not listed.
// Fails only when a published package's direct dependency range cannot reach a patched version of a
// high or critical advisory: then a fresh install of that package is affected. Writes Markdown to stdout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SEVERITY = ['critical', 'high', 'moderate', 'low', 'info'];
const SHARED = new Set(['svelte', '@sveltejs/kit']);
const BUFFER = 256 * 1024 * 1024;

function json_of(args) {
	const r = spawnSync('pnpm', args, { encoding: 'utf8', maxBuffer: BUFFER });
	try {
		return JSON.parse(r.stdout);
	} catch {
		console.error(`pnpm ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
		process.exit(2);
	}
}

// ── the catalogs (pnpm-workspace.yaml): a `catalog:` / `catalog:<name>` specifier → its real range ──
/** @type {Map<string, Map<string, string>>} catalog name ('' = the default) → package → range */
const catalogs = new Map();
{
	let section = null; // '' for `catalog:`, the name under `catalogs:`, null elsewhere
	let in_named = false;
	const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');
	for (const line of fs.readFileSync('pnpm-workspace.yaml', 'utf8').split('\n')) {
		if (/^\S/.test(line)) {
			in_named = line.startsWith('catalogs:');
			section = line.startsWith('catalog:') ? '' : null;
			continue;
		}
		const named = in_named && /^ {2}(\S[^:]*):\s*$/.exec(line);
		if (named) {
			section = unquote(named[1]);
			continue;
		}
		const indent = section === '' ? 2 : 4;
		const entry =
			section !== null &&
			new RegExp(`^ {${indent}}('[^']+'|"[^"]+"|[^\\s:#]+):\\s*(.+?)\\s*$`).exec(line);
		if (!entry || entry[2].startsWith('#')) continue;
		if (!catalogs.has(section)) catalogs.set(section, new Map());
		catalogs.get(section).set(unquote(entry[1]), unquote(entry[2]));
	}
}
const real_range = (name, spec) =>
	spec?.startsWith('catalog:')
		? (catalogs.get(spec.slice('catalog:'.length))?.get(name) ?? spec)
		: spec;

// ── the published packages ──
const published = fs
	.readdirSync('packages')
	.map((dir) => path.join('packages', dir, 'package.json'))
	.filter((file) => fs.existsSync(file))
	.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
	.filter((pkg) => !pkg.private)
	.sort((a, b) =>
		a.name === 'ogygia' ? -1 : b.name === 'ogygia' ? 1 : a.name.localeCompare(b.name)
	);

const audit = json_of(['audit', '--json']);

// ── each package's dependency graph: one node per installed copy (a deduped copy lists its children once) ──
/** @type {Map<string, { name: string, version: string, children: Set<string> }>} */
const nodes = new Map();
function index(name, node) {
	const key = node.path ?? `${name}@${node.version}`;
	let n = nodes.get(key);
	if (!n) nodes.set(key, (n = { name, version: node.version, children: new Set() }));
	for (const [child, sub] of Object.entries(node.dependencies ?? {}))
		n.children.add(index(child, sub));
	return key;
}

/** `name@version` → each way it is reached: through which published package, as what kind, and how */
const reached = new Map();
for (const pkg of published) {
	const [tree] = json_of(['list', '--filter', pkg.name, '--json', '--depth', 'Infinity']);
	const kind_of = (name) =>
		pkg.peerDependencies?.[name] !== undefined
			? 'peer'
			: pkg.dependencies?.[name] !== undefined
				? 'dependency'
				: 'dev';
	for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
		for (const [name, node] of Object.entries(tree?.[group] ?? {})) {
			// a sibling workspace package (`workspace:`) is audited as itself, not through this one
			if (String(node.version ?? '').startsWith('link:')) continue;
			const top = index(name, node);
			const seen = new Set([top]);
			const queue = [{ key: top, route: [], kind: kind_of(name) }];
			while (queue.length) {
				const { key, route, kind: parent_kind } = queue.shift();
				const n = nodes.get(key);
				// one of the package's own peers, met deeper (a dependency's peer: bits-ui › runed › Kit)
				// is the app's copy, and so is everything below it
				const kind =
					parent_kind === 'dependency' && pkg.peerDependencies?.[n.name] !== undefined
						? 'peer'
						: parent_kind;
				const id = `${n.name}@${n.version}`;
				if (!reached.has(id)) reached.set(id, []);
				reached
					.get(id)
					.push({ pkg, kind, route: route.length ? `via ${route.join(' › ')}` : 'direct' });
				for (const child of n.children) {
					if (seen.has(child)) continue;
					seen.add(child);
					queue.push({ key: child, route: [...route, n.name], kind });
				}
			}
		}
	}
}

// every package Svelte or SvelteKit pulls in, at any depth
const shared = new Set();
for (const n of nodes.values()) {
	if (!SHARED.has(n.name)) continue;
	const queue = [...n.children];
	while (queue.length) {
		const c = nodes.get(queue.shift());
		if (shared.has(c.name)) continue;
		shared.add(c.name);
		queue.push(...c.children);
	}
}

/** Does `range` (a package's) allow a version that `patched` (the advisory's) covers? Asked of npm:
 *  a space in a range is AND, so `<range> <patched part>` matches only versions in both. */
function range_reaches_patch(name, range, patched) {
	for (const part of patched.split('||')) {
		const r = spawnSync('npm', ['view', `${name}@${range} ${part.trim()}`, 'version', '--json'], {
			encoding: 'utf8'
		});
		if (r.status === 0 && r.stdout.trim() !== '') return true;
	}
	return false;
}

/** one row per advisory package and kind: its advisories, the versions locked here, who brings it and how */
const groups = { dependency: new Map(), peer: new Map(), dev: new Map() };
let elsewhere = 0;

for (const a of Object.values(audit.advisories ?? {})) {
	const versions = [...new Set((a.findings ?? []).map((f) => f.version))];
	const ways = versions.flatMap((v) => reached.get(`${a.module_name}@${v}`) ?? []);
	if (ways.length === 0) {
		elsewhere++;
		continue;
	}
	for (const w of ways) {
		const kind_rows = groups[w.kind];
		let row = kind_rows.get(a.module_name);
		if (!row)
			kind_rows.set(
				a.module_name,
				(row = {
					name: a.module_name,
					advisories: new Map(),
					installed: new Set(),
					routes: new Set(),
					direct_in: new Set()
				})
			);
		row.advisories.set(a.url, a);
		row.routes.add(`${w.pkg.name}: ${w.route}`);
		if (w.route === 'direct') row.direct_in.add(w.pkg);
		for (const v of versions) if (reached.has(`${a.module_name}@${v}`)) row.installed.add(v);
	}
}

const rank = (s) => SEVERITY.indexOf(s);
const worst = (row) =>
	[...row.advisories.values()].map((a) => a.severity).sort((x, y) => rank(x) - rank(y))[0];
let failing = 0;

/** a direct dependency: does each package's range reach a fix for every one of its advisories? */
function range_note(row) {
	const notes = [];
	for (const pkg of row.direct_in) {
		const range = real_range(row.name, pkg.dependencies[row.name]);
		const stuck = [...row.advisories.values()].filter(
			(a) => !range_reaches_patch(row.name, range, a.patched_versions)
		);
		if (stuck.length === 0) {
			notes.push(
				`\`${pkg.name}\` allows \`${range}\`, which includes every fix: a fresh install gets them; only this repository's lockfile is behind`
			);
			continue;
		}
		if (stuck.some((a) => a.severity === 'critical' || a.severity === 'high')) failing++;
		notes.push(
			`**\`${pkg.name}\`'s range \`${range}\` does not reach a fixed version for ${stuck.length} of these**`
		);
	}
	return notes.join('; ');
}

const cell = (s) => String(s).replaceAll('|', '\\|');
function table(kind) {
	const list = [...groups[kind].values()].sort(
		(x, y) => rank(worst(x)) - rank(worst(y)) || x.name.localeCompare(y.name)
	);
	if (list.length === 0) return '_None._\n';
	let out =
		'| Package | Severity | Advisories | Locked here | How it arrives | Notes |\n|---|---|---|---|---|---|\n';
	for (const row of list) {
		const advisories = [...row.advisories.values()]
			.sort((x, y) => rank(x.severity) - rank(y.severity))
			.map(
				(a) =>
					`${a.severity}: [${cell(a.title)}](${a.url}) (fixed in \`${cell(a.patched_versions)}\`)`
			)
			.join('<br>');
		const routes = [...row.routes].sort((x, y) => x.length - y.length);
		const notes = [
			shared.has(row.name)
				? 'also a dependency of Svelte / SvelteKit: every Svelte app has it'
				: '',
			kind === 'dependency' && row.direct_in.size ? range_note(row) : ''
		].filter(Boolean);
		out += `| \`${row.name}\` | ${worst(row)} | ${advisories} | ${[...row.installed].join(', ')} | ${cell(routes.slice(0, 4).join('<br>'))}${routes.length > 4 ? `<br>(+${routes.length - 4} more)` : ''} | ${cell(notes.join('; '))} |\n`;
	}
	return out;
}

const names = published.map((p) => `\`${p.name}\``).join(', ');
let md = `## Dependency audit: the published packages at ${published[0]?.version ?? '?'}\n\n`;
md += `Covers ${names}. Checked against the npm advisory database (\`pnpm audit\`). "Locked here" is this repository's lockfile; an app installing a package resolves its own versions within the ranges. "How it arrives" names the package that brings it.\n\n`;
md += `### Dependencies (installed with a package)\n\n${table('dependency')}\n`;
md += `### Peer dependencies (installed and updated by the app)\n\n${table('peer')}\n`;
md += `<details><summary>Dev dependencies: this repository's tooling, never installed by an app (${groups.dev.size} ${groups.dev.size === 1 ? 'package' : 'packages'})</summary>\n\n${table('dev')}\n</details>\n\n`;
if (elsewhere)
	md += `${elsewhere} more ${elsewhere === 1 ? 'advisory is' : 'advisories are'} only in this repository's demo apps and internal tools, which are not part of any published package.\n`;
process.stdout.write(md);
process.exit(failing ? 1 : 0);
