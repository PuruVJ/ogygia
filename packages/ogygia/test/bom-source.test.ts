// A leading UTF-8 byte-order mark (compiler/bom.ts). Svelte's `parse` drops it, so its offsets are
// one short of the raw text; a pass that edits the raw text by them lands one character early.
//
// REGRESSION (a field build, 2026-10-06): two BOM-prefixed components failed to compile —
// `</qds-button> attempted to close an element that was not open` — because the ownership stamp was
// inserted one character early and split the tag name (`<qds-butto data-og-opaquen`). The compiler now
// takes the mark off where source comes in, so every offset-editing pass (the island transform, the
// barrel rewrite, the stamps) edits exactly the text its parser measured.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from 'svelte/compiler';
import { Compiler, Program, CompileCtx, normalize_import_keys } from '../dist/compiler/index.js';
import { stamp_opaque } from '../src/compiler/ownership-stamps.js';
import { strip_bom } from '../src/compiler/bom.js';

const BOM = '﻿';
const COMPONENT =
	BOM +
	`<script>\n\tlet { markup } = $props();\n</script>\n\n<x-el>static</x-el>\n<div class="host">{@html markup}</div>\n`;
const HOST =
	BOM +
	`<script>\n\timport Counter from '$lib/Counter.svelte' with { wake: 'load' };\n</script>\n\n<qds-button>go</qds-button>\n<Counter />\n`;

let root = '';

function make_compiler() {
	const program = new Program({ forms: true, router: true });
	const profiler = {
		prof: {
			transformMs: 0,
			transformN: 0,
			transformHit: 0,
			prescanMs: 0,
			bakeMs: 0,
			bakeN: 0,
			resolveMs: 0,
			loadMs: 0
		},
		P: false,
		outHash: new Map<string, number>()
	};
	const compiler = new Compiler(program, profiler);
	compiler.configure(
		new CompileCtx({
			root,
			base: '/',
			libDir: path.join(root, 'src/lib'),
			is_dev: false,
			is_build: true,
			id_salt: '',
			visibleMargin: '0px',
			presets: {},
			import_keys: normalize_import_keys(undefined),
			resolve_alias: [],
			markdown_config: null,
			pkg_root: '/nowhere/ogygia',
			app_shims: {}
		} as never)
	);
	return compiler;
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-bom-'));
	const write = (rel: string, src: string) => {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, src);
	};
	write('src/routes/+layout.ts', 'export const csr = false;\n');
	write('src/lib/Counter.svelte', '<button>0</button>\n');
	write('src/lib/Widget.svelte', COMPONENT);
	write('src/routes/+page.svelte', HOST);
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const compiles = (code: string, name: string, generate: 'server' | 'client') =>
	expect(() => compile(code, { filename: name, generate })).not.toThrow();

describe('a byte-order-marked component', () => {
	test('strip_bom takes off exactly one leading mark', () => {
		expect(strip_bom(BOM + 'a')).toBe('a');
		expect(strip_bom('a' + BOM)).toBe('a' + BOM);
		expect(strip_bom('a')).toBe('a');
	});

	test('the ownership stamps land on the tag name, not one character early', () => {
		const out = stamp_opaque(COMPONENT, '/app/src/lib/Widget.svelte')!;
		expect(out).toContain('<x-el data-og-opaque>static</x-el>');
		expect(out).toContain('<div data-og-opaque class="host">');
		compiles(out, 'Widget.svelte', 'server');
	});

	test('through the compiler’s transform, server leg: stamped and compiles', async () => {
		const compiler = make_compiler();
		const id = path.join(root, 'src/lib/Widget.svelte');
		const res = await compiler.transform_module(COMPONENT, id, {
			ssr: true,
			emitFile: () => 'ref'
		});
		expect(res).not.toBeNull();
		expect(res!.code).toContain('<x-el data-og-opaque>static</x-el>');
		compiles(res!.code, 'Widget.svelte', 'server');
	});

	test('a host with a marked import, both legs: the island transform edits the right offsets', async () => {
		const id = path.join(root, 'src/routes/+page.svelte');
		for (const ssr of [true, false]) {
			const compiler = make_compiler();
			const res = await compiler.transform_module(HOST, id, { ssr, emitFile: () => 'ref' });
			expect(res, `ssr=${ssr}`).not.toBeNull();
			expect(res!.code).toContain('<qds-button');
			expect(res!.code).not.toContain('<qds-butto ');
			compiles(res!.code, '+page.svelte', ssr ? 'server' : 'client');
		}
	});
});
