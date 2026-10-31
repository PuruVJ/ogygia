/**
 * The plugin substrate (internal/notes/packages.md): `ogygia({ plugins })` validation, the generated
 * `virtual:ogygia/server-plugins` module, and the shared request facts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { validate_plugins } from '../src/vite/options.js';
import { server_plugins_module } from '../src/compiler/link/caps.js';
import { PLUGIN_API, definePlugin, personalRead, noteAssignment, assignments } from '../src/plugin/index.js';
import { set_personal_read_sink } from '../src/plugin/facts.js';

const plugin = (name: string, server?: string) => definePlugin({ name, api: PLUGIN_API, ...(server ? { server } : {}) });

describe('ogygia({ plugins }) — config-time validation', () => {
	it('returns each server half in app order', () => {
		expect(validate_plugins([plugin('a', 'pkg-a/server'), plugin('b'), plugin('c', 'pkg-c/server')])).toEqual([
			'pkg-a/server',
			'pkg-c/server'
		]);
		expect(validate_plugins(undefined)).toEqual([]);
	});
	it('names the uncalled factory', () => {
		const flags = () => plugin('flags');
		expect(() => validate_plugins([flags])).toThrow(/write `flags\(\)`/);
	});
	it('refuses a plugin written for another plugin API', () => {
		expect(() => validate_plugins([{ name: 'old', api: PLUGIN_API + 1 }])).toThrow(/plugin API/);
	});
	it('refuses a plugin listed twice, and junk', () => {
		expect(() => validate_plugins([plugin('a'), plugin('a')])).toThrow(/listed twice/);
		expect(() => validate_plugins([{}])).toThrow(/must be a plugin/);
		expect(() => validate_plugins(plugin('a') as never)).toThrow(/must be an array/);
	});
});

describe('virtual:ogygia/server-plugins', () => {
	it('imports each server half statically, in order (server only)', () => {
		const code = server_plugins_module(true, ['@ogygia/flags/server', 'x/server']);
		expect(code).toContain('import p0 from "@ogygia/flags/server";');
		expect(code).toContain('import p1 from "x/server";');
		expect(code).toContain('export const plugins = [p0, p1];');
	});
	it('is an empty list on the client and for an app without plugins', () => {
		expect(server_plugins_module(false, ['@ogygia/flags/server'])).toBe('export const plugins = [];');
		expect(server_plugins_module(true, [])).toBe('export const plugins = [];');
	});
});

describe('request facts', () => {
	afterEach(() => set_personal_read_sink(null));
	it('a personal read is a no-op without a sink (client, or outside a render)', () => {
		expect(() => personalRead('flag:x')).not.toThrow();
	});
	it('a personal read reaches the sink core installed', () => {
		const seen: string[] = [];
		set_personal_read_sink((label) => seen.push(label));
		personalRead('flag:hero');
		expect(seen).toEqual(['flag:hero']);
	});
	it('assignments are per request, and absent until one is noted', () => {
		const a = new Request('http://x/a');
		const b = new Request('http://x/b');
		expect(assignments(a)).toBeUndefined();
		noteAssignment(a, 'hero', 'bold');
		noteAssignment(a, 'kill', 'on');
		expect(assignments(a)).toEqual({ hero: 'bold', kill: 'on' });
		expect(assignments(b)).toBeUndefined();
	});
	it('survives two module instances (one global slot)', async () => {
		const other = await import('../src/plugin/facts.js?second-instance' as string);
		const r = new Request('http://x/c');
		noteAssignment(r, 'x', 'y');
		expect(other.assignments(r)).toEqual({ x: 'y' });
	});
});
