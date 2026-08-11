import { l as listEntries, a as addEntry } from '../../../../chunks/guestbook.js-tHxGKFqJ.js';
import { B as fail, A as redirect } from '../../../../chunks/utils.js-CNshUuVp.js';

//#region src/routes/(spa)/forms/+page.server.ts
var load = ({ url }) => ({
	entries: listEntries(),
	ok: url.searchParams.get("ok") === "1"
});
var actions = { add: async ({ request }) => {
	const data = await request.formData();
	const name = String(data.get("name") ?? "").trim();
	const message = String(data.get("message") ?? "").trim();
	if (!name || !message) return fail(400, {
		error: "name and message are required",
		name,
		message
	});
	addEntry(name, message);
	redirect(303, "/forms?ok=1");
} };

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	actions: actions,
	load: load
});

export { _page_server_ts as _ };
//# sourceMappingURL=_page.server.ts.js-CQRzXRpe.js.map
