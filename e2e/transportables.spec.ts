// Transportable objects (`static [ogygia.wire]` codecs): a class instance crosses an island
// boundary as a prop, stays ONE live object across islands (identity memo), and never leaks
// across server requests (remember:false). Also proves the registration is alias-proof —
// the codec key reaches the class through a renamed import + a const hop.
// Usage: pnpm exec playwright test transportables
import {
	wire,
	reduce_transportable,
	revive_transportable,
	__register_transportable
} from '../packages/ogygia/dist/live-transport.js';
import { test, check } from './fixtures/index.ts';

const DUPE_WARN_RE = /both use continuity id "dupe"/;
const SSR_COUNT_RE = /data-t-count[^>]*>(\d+)</;

test.describe('static [ogygia.wire] codec: cross-island live object, no leak, alias-proof', () => {
	test('Codec engine (unit-level, no server)', () => {
		class Box {
			v: number;
			constructor(v = 0) {
				this.v = v;
			}
			static [wire] = {
				encode: (b: Box) => b.v,
				decode: (v: number) => new Box(v)
			};
		}
		// Unregistered → loud throw (never a silent dead copy).
		let threw = false;
		try {
			reduce_transportable(new Box(1));
		} catch {
			threw = true;
		}
		check('unregistered codec class throws on encode', threw);

		__register_transportable('verify#Box', Box as unknown);
		const a = new Box(7);
		const b = new Box(9);
		const pa1 = reduce_transportable(a) as { t: string; i: string; d: unknown };
		const pa2 = reduce_transportable(a) as { i: string };
		const pb = reduce_transportable(b) as { i: string };
		check('registered class encodes to {t,i,d}', pa1 && pa1.t === 'verify#Box' && pa1.d === 7);
		check('same instance → same wire id (identity memo)', pa1.i === pa2.i);
		check('different instances → different ids', pa1.i !== pb.i);

		// Browser semantics: remember=true reunites every decode of one id into ONE instance.
		const c1 = revive_transportable(pa1, true) as Box;
		const c2 = revive_transportable(pa1, true) as Box;
		check(
			'client (remember) shares one live instance',
			c1 === c2 && c1 instanceof Box && c1.v === 7
		);

		// Server semantics: remember=false NEVER memoizes — no cross-request leak.
		const s1 = revive_transportable(pa1, false) as Box;
		const s2 = revive_transportable(pa1, false) as Box;
		check('server (no remember) decodes fresh every time', s1 !== s2 && s1.v === 7);

		// A plain non-transportable object falls through (devalue handles/errors it, not us).
		check('non-transportable object falls through', reduce_transportable({ x: 1 }) === undefined);
	});

	test('Continuity: named codec (session-lifetime, merge on navigation)', () => {
		// A NAMED codec is a session singleton in the Keep; a navigation reunites the next page's
		// decode with the same live instance, reconciled via merge().
		class Cart {
			items: string[];
			serverStamp: number;
			constructor(items: string[] = [], serverStamp = 0) {
				this.items = items;
				this.serverStamp = serverStamp;
			}
			static [wire] = {
				id: 'cart',
				encode: (c: Cart) => ({ items: c.items, serverStamp: c.serverStamp }),
				decode: (d: { items: string[]; serverStamp: number }) => new Cart(d.items, d.serverStamp),
				// live wins for items (user edits), but server truth (stamp) is pulled fresh
				merge: (live: Cart, fresh: Cart) => {
					live.serverStamp = fresh.serverStamp;
				}
			};
		}
		__register_transportable('verify#Cart', Cart as unknown);

		// PAGE A: server builds cart (stamp 1), user adds an item client-side.
		const pageA = reduce_transportable(new Cart(['seed'], 1)) as {
			t: string;
			i: string;
			d: unknown;
		};
		const liveA = revive_transportable(pageA, true) as Cart;
		liveA.items.push('user-added');
		check('named: first sight decodes + keeps', liveA instanceof Cart && liveA.items.length === 2);

		// PAGE B: server builds a FRESH cart (new instance, new wire id, stamp 2, no user item).
		const pageB = reduce_transportable(new Cart(['seed'], 2)) as {
			t: string;
			i: string;
			d: unknown;
		};
		check('named: navigation mints a new wire id', pageB.i !== pageA.i);
		const liveB = revive_transportable(pageB, true) as Cart;
		check('named: SAME live instance across navigation (identity kept)', liveB === liveA);
		check(
			'named: live wins — user edit survived',
			liveB.items.length === 2 && liveB.items[1] === 'user-added'
		);
		check('named: merge pulled server truth in (stamp 1 → 2)', liveB.serverStamp === 2);

		// SERVER (remember:false) must NEVER touch the Keep — fresh instance every time, isolated.
		const srv1 = revive_transportable(pageB, false) as Cart;
		const srv2 = revive_transportable(pageB, false) as Cart;
		check('named: server decodes fresh + never joins the Keep', srv1 !== srv2 && srv1 !== liveA);
		check('named: server instance has no user edit (isolation)', srv1.items.length === 1);
	});

	test('Continuity: default merge (no merge fn) = pure live-wins', () => {
		class Draft {
			text: string;
			constructor(text = '') {
				this.text = text;
			}
			static [wire] = {
				id: 'draft',
				encode: (dr: Draft) => dr.text,
				decode: (t: string) => new Draft(t)
				// no merge → live wins entirely
			};
		}
		__register_transportable('verify#Draft', Draft as unknown);
		const a = revive_transportable(
			reduce_transportable(new Draft('server-a')) as never,
			true
		) as Draft;
		a.text = 'user typed this';
		const b = revive_transportable(
			reduce_transportable(new Draft('server-b')) as never,
			true
		) as Draft;
		check(
			'default merge: same instance, live wins entirely',
			b === a && b.text === 'user typed this'
		);
	});

	test('Continuity: duplicate-id collision guard', () => {
		class One {
			static [wire] = { id: 'dupe', encode: () => 1, decode: () => new One() };
		}
		class Two {
			static [wire] = { id: 'dupe', encode: () => 2, decode: () => new Two() };
		}
		__register_transportable('verify#One', One as unknown);
		__register_transportable('verify#Two', Two as unknown);
		const orig = console.error;
		let msg = '';
		console.error = (m: string) => {
			msg = String(m);
		};
		try {
			revive_transportable(reduce_transportable(new One()) as never, true); // claims 'dupe'
			revive_transportable(reduce_transportable(new Two()) as never, true); // collides
		} finally {
			console.error = orig;
		}
		check(
			'duplicate continuity id warns (collision guard)',
			DUPE_WARN_RE.test(msg),
			msg.slice(0, 60)
		);
	});

	test('Browser e2e (/transportable)', async ({ page, baseURL }) => {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));

		// SSR seed: the server builds `new SharedCounter('demo', 5)` and passes it to two islands.
		// Both render 5 from the wire snapshot — no flicker, no empty first paint.
		const raw = await (await fetch(baseURL + '/transportable')).text();
		const ssr = raw.match(SSR_COUNT_RE)?.[1];
		check('SSR: server-built instance seeds islands (renders 5)', ssr === '5', `count=${ssr}`);

		await page.goto('/transportable', { waitUntil: 'networkidle' });
		await page.waitForTimeout(150);

		check(
			'both islands decoded a real instance (instanceof)',
			(await page.locator('[data-transport-writer]').getAttribute('data-is-instance')) === 'true' &&
				(await page.locator('[data-transport-reader]').getAttribute('data-is-instance')) === 'true'
		);

		const count = () => page.locator('[data-t-count]').innerText();
		check('hydrated count matches SSR (no reset)', (await count()) === '5');

		// Liveness: writer island mutates; reader island (separate bundle) must repaint.
		await page.locator('[data-transport-writer] button').click();
		await page.waitForTimeout(50);
		check(
			'write in one island repaints the other',
			(await count()) === '6',
			`count=${await count()}`
		);

		await page.locator('[data-transport-writer] button').click();
		await page.locator('[data-transport-writer] button').click();
		await page.waitForTimeout(50);
		check('cross-island count after 3 writes', (await count()) === '8', `count=${await count()}`);
		check(
			'derived getter tracks shared state',
			(await page.locator('[data-t-double]').innerText()) === '16'
		);

		// Alias-proof: AliasProbe reaches [ogygia.wire] via `import { wire as w }` + `const K = w`.
		check(
			'alias-proof: renamed codec key still crosses',
			(await page.locator('[data-alias-probe]').innerText()) === 'alias-ok'
		);

		// Manifest: a class in a component's `<script module>`, received by an `import type`-only
		// island (WidgetReader), decodes to a real live instance with no value import.
		check(
			'module-script class: import-type island got a real instance',
			(await page.locator('[data-widget-reader]').getAttribute('data-has-method')) === 'true'
		);
		const widgetHits = () => page.locator('[data-widget-hits]').innerText();
		check(
			'module-script class: SSR seed',
			(await widgetHits()) === '3',
			`hits=${await widgetHits()}`
		);
		await page.locator('[data-widget-writer] button').click();
		await page.waitForTimeout(50);
		check(
			'module-script class: cross-island write repaints',
			(await widgetHits()) === '4',
			`hits=${await widgetHits()}`
		);

		// Transportable prop into a SERVER island (defer only): the signed endpoint payload must carry
		// the wire codec. The endpoint decodes it fresh (remember:false) and renders the snapshot (5).
		// Before the encode fix this threw ("captured prop is not serializable") at page render.
		await page.waitForTimeout(200);
		check(
			'server island: transportable prop decoded to a live instance (5)',
			(await page.locator('[data-transport-srv="server"]').getAttribute('data-is-instance')) ===
				'true' &&
				(await page.locator('[data-transport-srv="server"] [data-ts-count]').innerText()) === '5',
			`count=${await page.locator('[data-transport-srv="server"] [data-ts-count]').innerText()}`
		);

		// Transportable prop into a deferred CLIENT island (defer+hydrate): props-sibling script carries
		// the codec, and after hydration it reunites into the SAME live instance as the writer.
		check(
			'defer+wake: transportable prop decoded to a live instance (starts 8)',
			(await page
				.locator('[data-transport-srv="defer-hydrate"]')
				.getAttribute('data-is-instance')) === 'true'
		);
		await page.locator('[data-transport-writer] button').click();
		await page.waitForTimeout(80);
		check(
			'defer+wake: shares the writer’s live instance (repaints on write)',
			(await page.locator('[data-transport-srv="defer-hydrate"] [data-ts-count]').innerText()) ===
				'9',
			`count=${await page.locator('[data-transport-srv="defer-hydrate"] [data-ts-count]').innerText()}`
		);

		check('no page errors', errors.length === 0, errors.join(' | '));
	});
});
