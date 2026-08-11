import { c as __exportAll } from './internal.js-gg_mc6sK.js';
import { q as query, c as command } from './remote.js-CMrFgAnM.js';
import { j as init_remote_functions } from './shared.js-B5OSxjL7.js';
import './routing.js-poy0Ceuj.js';
import './utils.js-CNshUuVp.js';
import { T as Temperature } from './hooks.js-Z54mkQnR.js';
import * as v from 'valibot';

//#region src/lib/greetings.remote.ts
var greetings_remote_exports = /* @__PURE__ */ __exportAll({
	bump: () => bump,
	clock: () => clock,
	getCount: () => getCount,
	getGreeting: () => getGreeting,
	getTemperature: () => getTemperature
});
var getTemperature = /* @__PURE__ */ query(async () => new Temperature(21.5));
var getGreeting = /* @__PURE__ */ query(v.string(), async (name) => {
	await new Promise((r) => setTimeout(r, 30));
	return {
		greeting: `Hello, ${name}!`,
		at: /* @__PURE__ */ new Date()
	};
});
var counter = 0;
var getCount = /* @__PURE__ */ query(async () => counter);
var bump = /* @__PURE__ */ command(v.number(), async (by) => {
	counter += by;
	return counter;
});
var clock = query.live(async function* () {
	while (true) {
		yield (/* @__PURE__ */ new Date()).toISOString();
		await new Promise((r) => setTimeout(r, 1e3));
	}
});
init_remote_functions(greetings_remote_exports, "src/lib/greetings.remote.ts", "bjveep");
for (const [name, fn] of Object.entries(greetings_remote_exports)) {
	fn.__.id = "bjveep/" + name;
	fn.__.name = name;
}

export { getGreeting as a, getCount as b, clock as c, greetings_remote_exports as g };
//# sourceMappingURL=greetings.remote.js-EpnYRFDB.js.map
