import { g as getOrder } from '../../../../../../chunks/db.js-DtZrcTXy.js';
import { v as error } from '../../../../../../chunks/utils.js-CNshUuVp.js';

//#region src/routes/(spa)/dashboard/orders/[id]/+page.server.ts
var load = ({ params }) => {
	const id = Number(params.id);
	const order = getOrder(id);
	if (!order) error(404, `Order ${params.id} not found`);
	return {
		order,
		prevId: id > 1 ? id - 1 : null,
		nextId: id < 240 ? id + 1 : null
	};
};

var _page_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

export { _page_server_ts as _ };
//# sourceMappingURL=_page.server.ts.js-CP3y-2lP.js.map
