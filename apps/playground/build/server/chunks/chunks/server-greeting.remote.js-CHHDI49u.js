import { c as __exportAll } from './internal.js-gg_mc6sK.js';
import { q as query } from './remote.js-CMrFgAnM.js';
import { j as init_remote_functions } from './shared.js-B5OSxjL7.js';
import './routing.js-poy0Ceuj.js';
import { I as getRequestEvent } from './utils.js-CNshUuVp.js';

//#region src/lib/server-greeting.remote.ts
var server_greeting_remote_exports = /* @__PURE__ */ __exportAll({ personalGreeting: () => personalGreeting });
var personalGreeting = /* @__PURE__ */ query(async () => {
	const { cookies } = getRequestEvent();
	const name = cookies.get("sk_name") || "stranger";
	await new Promise((r) => setTimeout(r, 300));
	return {
		name,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
});
init_remote_functions(server_greeting_remote_exports, "src/lib/server-greeting.remote.ts", "11t944q");
for (const [name, fn] of Object.entries(server_greeting_remote_exports)) {
	fn.__.id = "11t944q/" + name;
	fn.__.name = name;
}

export { personalGreeting as p, server_greeting_remote_exports as s };
//# sourceMappingURL=server-greeting.remote.js-CHHDI49u.js.map
