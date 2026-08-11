import { V as escape_html, X as attr, _ as ensure_array_like, a0 as attributes } from '../../../../chunks/async.js-JxW4IVMW.js';
import { I as Island } from '../../../../chunks/internal3.js-DRIflGiV.js';
import { C as Counter } from '../../../../chunks/Counter.js-BNzt6BII.js';
import { s as signGuestbook } from '../../../../chunks/guestbook.remote.js-BUdcd9pm.js';
import 'devalue';
import '../../../../chunks/internal.js-gg_mc6sK.js';
import '../../../../chunks/internal2.js-CRcS4Hsm.js';
import '../../../../chunks/paths.js-CKQC7KeW.js';
import '../../../../chunks/routing.js-poy0Ceuj.js';
import '../../../../chunks/utils.js-CNshUuVp.js';
import '../../../../chunks/shared.js-B5OSxjL7.js';
import '../../../../chunks/state.js-B_7Rd0Ds.js';
import '../../../../chunks/exports.js-DUO0Cq7p.js';
import '../../../../chunks/payload.js-BiRFERCp.js';
import '../../../../chunks/remote.js-CMrFgAnM.js';
import '../../../../chunks/guestbook.js-tHxGKFqJ.js';
import 'valibot';

//#region src/routes/(spa)/forms/.ogygia/f2efa65e5fab.svelte
function F2efa65e5fab($$renderer) {
	Counter($$renderer, {
		start: 0,
		label: "island on the forms page (router active)"
	});
}
//#endregion
//#region src/lib/GuestbookForm.svelte
function GuestbookForm($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		$$renderer.push(`<form${attributes({
			...signGuestbook,
			"data-remote-form": true
		})}><input${attributes({
			...signGuestbook.fields.name.as("text"),
			placeholder: "name",
			"data-rf-name": true
		}, void 0, void 0, void 0, 4)}/> <!--[-->`);
		const each_array = ensure_array_like(signGuestbook.fields.name.issues() ?? []);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let issue = each_array[$$index];
			$$renderer.push(`<span data-rf-name-issue="">${escape_html(issue.message)}</span>`);
		}
		$$renderer.push(`<!--]--> <input${attributes({
			...signGuestbook.fields.message.as("text"),
			placeholder: "message",
			"data-rf-message": true
		}, void 0, void 0, void 0, 4)}/> <!--[-->`);
		const each_array_1 = ensure_array_like(signGuestbook.fields.message.issues() ?? []);
		for (let $$index_1 = 0, $$length = each_array_1.length; $$index_1 < $$length; $$index_1++) {
			let issue = each_array_1[$$index_1];
			$$renderer.push(`<span data-rf-message-issue="">${escape_html(issue.message)}</span>`);
		}
		$$renderer.push(`<!--]--> <button data-rf-submit="">Sign (remote form)</button> `);
		if (signGuestbook.pending) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<span data-rf-pending="">saving…</span>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--></form> `);
		if (signGuestbook.result?.ok) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p data-rf-result="">Signed via remote form! total ${escape_html(signGuestbook.result.total)}</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]-->`);
	});
}
//#endregion
//#region src/routes/(spa)/forms/.ogygia/8dcdbc15c058.svelte
function _dcdbc15c058($$renderer) {
	GuestbookForm($$renderer);
}
//#endregion
//#region src/routes/(spa)/forms/+page.svelte
function _page($$renderer, $$props) {
	$$renderer.component(($$renderer) => {
		let { data, form } = $$props;
		$$renderer.push(`<h1 data-static-shell="">Guestbook — classic form actions</h1> `);
		Island($$renderer, {
			load: true,
			__entry: "f2efa65e5fab",
			__component: F2efa65e5fab,
			__props: {}
		});
		$$renderer.push(`<!----> <h2 data-static-shell="">Remote form (inside an island)</h2> `);
		Island($$renderer, {
			load: true,
			__entry: "8dcdbc15c058",
			__component: _dcdbc15c058,
			__props: {}
		});
		$$renderer.push(`<!----> <p data-static-shell="">Plain <code>&lt;form method="POST"></code>. No JS needed; works with the SPA router active.</p> `);
		if (data.ok) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p data-form-ok="">Thanks — your entry was saved.</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> `);
		if (form?.error) {
			$$renderer.push("<!--[0-->");
			$$renderer.push(`<p data-form-error="">${escape_html(form.error)}</p>`);
		} else $$renderer.push("<!--[-1-->");
		$$renderer.push(`<!--]--> <form method="POST" action="?/add" data-guestbook-form=""><input name="name" placeholder="your name"${attr("value", form?.name ?? "")} data-input-name=""/> <input name="message" placeholder="a message"${attr("value", form?.message ?? "")} data-input-message=""/> <button type="submit" data-submit="">Sign the guestbook</button></form> <ul data-entries=""><!--[-->`);
		const each_array = ensure_array_like(data.entries);
		for (let $$index = 0, $$length = each_array.length; $$index < $$length; $$index++) {
			let e = each_array[$$index];
			$$renderer.push(`<li data-entry="">${escape_html(e.name)}: ${escape_html(e.message)}</li>`);
		}
		$$renderer.push(`<!--]--></ul>`);
	});
}

export { _page as default };
//# sourceMappingURL=_page.svelte.js-DCP0Vxt2.js.map
