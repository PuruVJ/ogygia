import { s as statusCounts, c as currentUser } from '../../../../chunks/db.js-DtZrcTXy.js';

//#region src/routes/(spa)/dashboard/+layout.server.ts
var load = () => {
	return {
		user: currentUser(),
		navCounts: statusCounts()
	};
};

var _layout_server_ts = /*#__PURE__*/Object.freeze({
	__proto__: null,
	load: load
});

export { _layout_server_ts as _ };
//# sourceMappingURL=_layout.server.ts.js-Wam8_eNT.js.map
