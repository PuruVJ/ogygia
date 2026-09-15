/**
 * Test harness: a throwaway project on disk (real files — the index reads the file system) and a
 * tiny resolver that mirrors what Vite gives the plugin: relative specifiers with extension /
 * index probing, a `$lib` alias, and bare specifiers through a fake `node_modules` with `exports`.
 */
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BarrelIndex, type Host } from '../../src/compiler/debarrel/barrel.js';
import { rewrite_module, type Lookup, type RewritePolicy } from '../../src/compiler/debarrel/rewrite.js';
import { rewrite_svelte } from '../../src/compiler/debarrel/svelte.js';

export type HostOverrides = Partial<Host> & { packages?: string[] };

export interface Fixture {
	root: string;
	/** absolute id of a fixture file */
	id(rel: string): string;
	write(rel: string, content: string): string;
	read(rel: string): string;
	host(overrides?: HostOverrides): Host;
	index(overrides?: HostOverrides): BarrelIndex;
	/** rewrite a fixture file (JS/TS/Svelte) through a fresh index; returns the code or null */
	rewrite(rel: string, overrides?: HostOverrides, policy?: RewritePolicy): Promise<string | null>;
	lookup(index: BarrelIndex, importer: string): Lookup;
	dispose(): void;
}

const EXTS = ['', '.ts', '.js', '.mts', '.mjs', '.svelte', '.svelte.ts', '.svelte.js', '.json', '/index.ts', '/index.js'];
const BACKSLASH_G = /\\/g;

export function fixture(files: Record<string, string>): Fixture {
	// realpath: macOS's tmpdir is a symlink (`/var` → `/private/var`) and the bundler reports real ids
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'debarrel-'))).replace(BACKSLASH_G, '/');
	const id = (rel: string) => path.posix.join(root, rel);
	const write = (rel: string, content: string) => {
		const abs = id(rel);
		mkdirSync(path.dirname(abs), { recursive: true });
		writeFileSync(abs, content);
		return abs;
	};
	for (const [rel, content] of Object.entries(files)) write(rel, content);
	// A real Vite build of the fixture compiles `.svelte` files, whose output imports `svelte/…`:
	// link the workspace's svelte into the fixture so bare imports resolve from the temp root.
	const svelte_dir = path.dirname(createRequire(import.meta.url).resolve('svelte/package.json'));
	mkdirSync(id('node_modules'), { recursive: true });
	symlinkSync(svelte_dir, id('node_modules/svelte'), 'dir');

	const resolve_file = (base: string): string | null => {
		for (const ext of EXTS) {
			const p = base + ext;
			if (existsSync(p) && statSync(p).isFile()) return p;
		}
		return null;
	};
	const resolve_package = (spec: string): string | null => {
		const [scope_or_name, ...rest] = spec.split('/');
		const scoped = scope_or_name.startsWith('@');
		const name = scoped ? scope_or_name + '/' + rest.shift() : scope_or_name;
		const sub = rest.length ? './' + rest.join('/') : '.';
		const dir = path.posix.join(root, 'node_modules', name);
		const pkg_json = path.posix.join(dir, 'package.json');
		if (!existsSync(pkg_json)) return null;
		const pkg = JSON.parse(readFileSync(pkg_json, 'utf8')) as { exports?: unknown; main?: string; module?: string };
		const pick = (v: unknown): string | null => {
			if (typeof v === 'string') return v;
			if (v && typeof v === 'object') {
				const o = v as Record<string, unknown>;
				return pick(o.import ?? o.default ?? o.svelte ?? null);
			}
			return null;
		};
		if (pkg.exports) {
			const ex = pkg.exports as Record<string, unknown> | string;
			const target = typeof ex === 'string' ? (sub === '.' ? ex : null) : pick(ex[sub]);
			return target ? path.posix.join(dir, target) : null;
		}
		if (sub !== '.') return resolve_file(path.posix.join(dir, sub));
		return resolve_file(path.posix.join(dir, pkg.module ?? pkg.main ?? 'index'));
	};

	const make_host = (overrides: HostOverrides = {}): Host => {
		const packages = overrides.packages ?? [];
		return {
			read: (p) => {
				try {
					return readFileSync(p, 'utf8');
				} catch {
					return null;
				}
			},
			resolve: async (spec, importer) => {
				if (spec.startsWith('$lib/')) return resolve_file(path.posix.join(root, 'lib', spec.slice(5)));
				if (spec === '$lib') return resolve_file(path.posix.join(root, 'lib'));
				if (spec.startsWith('.')) return resolve_file(path.posix.join(path.posix.dirname(importer), spec));
				if (spec.startsWith('/')) return resolve_file(spec);
				if (spec.startsWith('virtual:')) return spec;
				return resolve_package(spec);
			},
			candidate: (p, spec) => {
				if (packages.some((pk) => spec === pk || spec.startsWith(pk + '/'))) return true;
				return !p.includes('/node_modules/') && p.startsWith(root + '/');
			},
			forced: () => false,
			kept: () => false,
			follow_packages: true,
			...overrides
		};
	};

	const hosts = new WeakMap<BarrelIndex, Host>();
	const make_index = (overrides?: HostOverrides) => {
		const h = make_host(overrides);
		const i = new BarrelIndex(h);
		hosts.set(i, h);
		return i;
	};
	const lookup = (index: BarrelIndex, importer: string): Lookup => async (spec) => {
		const resolved = await hosts.get(index)!.resolve(spec, importer);
		if (!resolved) return null;
		return index.map(resolved, spec);
	};

	return {
		root,
		id,
		write,
		read: (rel) => readFileSync(id(rel), 'utf8'),
		host: make_host,
		index: make_index,
		lookup,
		async rewrite(rel, overrides, policy) {
			const i = make_index(overrides);
			const importer = id(rel);
			const code = readFileSync(importer, 'utf8');
			const r = importer.endsWith('.svelte')
				? await rewrite_svelte(code, importer, lookup(i, importer), policy)
				: await rewrite_module(code, importer, lookup(i, importer), policy);
			return r ? r.code : null;
		},
		dispose: () => rmSync(root, { recursive: true, force: true })
	};
}
