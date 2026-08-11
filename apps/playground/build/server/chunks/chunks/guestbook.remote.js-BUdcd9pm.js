import { c as __exportAll } from './internal.js-gg_mc6sK.js';
import { f as form } from './remote.js-CMrFgAnM.js';
import { j as init_remote_functions } from './shared.js-B5OSxjL7.js';
import './routing.js-poy0Ceuj.js';
import './utils.js-CNshUuVp.js';
import { a as addEntry, l as listEntries } from './guestbook.js-tHxGKFqJ.js';
import * as v from 'valibot';

//#region src/lib/guestbook.remote.ts
var guestbook_remote_exports = /* @__PURE__ */ __exportAll({ signGuestbook: () => signGuestbook });
var signGuestbook = /* @__PURE__ */ form(v.object({
	name: v.pipe(v.string(), v.trim(), v.minLength(1, "name is required")),
	message: v.pipe(v.string(), v.trim(), v.minLength(1, "message is required"))
}), async ({ name, message }) => {
	addEntry(name, message);
	return {
		ok: true,
		total: listEntries().length
	};
});
init_remote_functions(guestbook_remote_exports, "src/lib/guestbook.remote.ts", "1a3wgsa");
for (const [name, fn] of Object.entries(guestbook_remote_exports)) {
	fn.__.id = "1a3wgsa/" + name;
	fn.__.name = name;
}

export { guestbook_remote_exports as g, signGuestbook as s };
//# sourceMappingURL=guestbook.remote.js-BUdcd9pm.js.map
