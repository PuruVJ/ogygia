/**
 * PROPS AFTER THE CONTENT — an island rendered in Kit's page pass records its props sidecar
 * (`record_island_props`) instead of emitting it next to the region; the handle appends the
 * recorded scripts before `</body>`, one per fingerprint. Every other render root keeps the
 * sidecar adjacent so its HTML stays self-contained. The sidecar is keyed by the region's
 * fingerprint either way (`data-og-fp` ↔ `data-ogygia-props="<fp>"`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import Region from '../src/Region.svelte';
import Tiny from './_fixtures/Tiny.svelte';
import KitPagePass from './_fixtures/KitPagePass.svelte';
import { set_props_recorder } from '../src/page-seed-registry.js';

const region = Region as unknown as Component<Record<string, unknown>>;
const kit_pass = KitPagePass as unknown as Component<Record<string, unknown>>;

const SIDECAR_G = /<script type="application\/ogygia-props" data-ogygia-props="([0-9a-f]+)">([^<]*)<\/script>/g;
const FP_ATTR_G = /data-og-fp="([0-9a-f]+)"/g;

const island = (props: Record<string, unknown> = {}, entry = '/islands/tiny.js') => ({
	__mode: 'island',
	__entry: entry,
	__component: Tiny,
	__props: props,
	load: true
});

/** Render one or more islands inside the Kit page-pass stand-in (a snippet child of KitPagePass). */
function render_in_kit_pass(list: Array<Record<string, unknown>>) {
	const children = (renderer: { push(html: string): void }) => {
		for (const props of list) {
			// A server-convention snippet renders the component into the same payload.
			(region as unknown as (r: unknown, p: unknown) => void)(renderer, props);
		}
	};
	return render(kit_pass, { props: { children } });
}

let recorded: Map<string, string>;
function install_recorder() {
	recorded = new Map();
	set_props_recorder((fp, script) => {
		recorded.set(fp, script);
		return true;
	});
}
afterEach(() => set_props_recorder(null));

describe('props sidecar placement', () => {
	it('no recorder (a test / standalone render): the sidecar is adjacent and keyed by the fingerprint', () => {
		const { body } = render(region, { props: island({ n: 1 }) });
		const fps = [...body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		const sidecars = [...body.matchAll(SIDECAR_G)];
		expect(fps).toHaveLength(1);
		expect(sidecars).toHaveLength(1);
		expect(sidecars[0][1]).toBe(fps[0]);
		expect(body.indexOf('</ogygia-region>')).toBeLessThan(body.indexOf('<script type="application/ogygia-props"'));
	});

	it('recorder installed but NOT a Kit page pass (an ogygia render root): still adjacent, nothing recorded', () => {
		install_recorder();
		const { body } = render(region, { props: island({ n: 1 }) });
		expect([...body.matchAll(SIDECAR_G)]).toHaveLength(1);
		expect(recorded.size).toBe(0);
	});

	it('Kit page pass + recorder: the sidecar is recorded (keyed by fp) and NOT emitted inline', () => {
		install_recorder();
		const { body } = render_in_kit_pass([island({ n: 1 })]);
		const fps = [...body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		expect(fps).toHaveLength(1);
		expect([...body.matchAll(SIDECAR_G)]).toHaveLength(0);
		expect(body).not.toContain('data-ogygia-props');
		expect(recorded.size).toBe(1);
		const [fp, script] = [...recorded.entries()][0];
		expect(fp).toBe(fps[0]);
		expect(script).toBe(
			`<script type="application/ogygia-props" data-ogygia-props="${fp}">${'[{"n":1},1]'}</script>`
		);
	});

	it('identical islands (same entry + props) share ONE recorded sidecar; different props get their own', () => {
		install_recorder();
		const { body } = render_in_kit_pass([island({ n: 1 }), island({ n: 1 }), island({ n: 2 })]);
		const fps = [...body.matchAll(FP_ATTR_G)].map((m) => m[1]);
		expect(fps).toHaveLength(3);
		expect(new Set(fps).size).toBe(2);
		expect(recorded.size).toBe(2);
		for (const fp of fps) expect(recorded.has(fp)).toBe(true);
	});

	it('the recorder refusing (returns false) keeps the sidecar inline — no props are ever lost', () => {
		set_props_recorder(() => false);
		const { body } = render_in_kit_pass([island({ n: 1 })]);
		expect([...body.matchAll(SIDECAR_G)]).toHaveLength(1);
	});

	it('a visible / interaction island is deferred the same way (any wake, same sidecar)', () => {
		install_recorder();
		const { body } = render_in_kit_pass([{ ...island({ n: 7 }), load: undefined, visible: true }]);
		expect(body).not.toContain('data-ogygia-props');
		expect(recorded.size).toBe(1);
	});
});
