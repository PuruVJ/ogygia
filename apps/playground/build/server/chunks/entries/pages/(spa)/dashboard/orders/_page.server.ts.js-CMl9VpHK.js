import { l as listOrders } from '../../../../../chunks/db.js-DtZrcTXy.js';

//#region src/routes/(spa)/dashboard/orders/+page.server.ts
var load = ({ url }) => {
	const status = url.searchParams.get("status") || "all";
	const sort = url.searchParams.get("sort") || "id";
	const dir = url.searchParams.get("dir") === "desc" ? "desc" : "asc";
	const page = Number(url.searchParams.get("page") || "1") || 1;
	const { rows, total, pages } = listOrders({
		status,
		sort,
		dir,
		page,
		perPage: 20
	});
	return {
		rows,
		total,
		pages,
		page,
		status,
		sort,
		dir
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

export { _page_server_ts as _ };
//# sourceMappingURL=_page.server.ts.js-CMl9VpHK.js.map
