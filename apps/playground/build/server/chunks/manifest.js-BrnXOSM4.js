const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set([]),
	mimeTypes: {},
	_: {
		client: {start:"_app/immutable/entry/start.BZ91Utib.js",app:"_app/immutable/entry/app.BhD-UL40.js",imports:["_app/immutable/entry/start.BZ91Utib.js","_app/immutable/chunks/B3oO6r_4.js","_app/immutable/chunks/Bz2BBfIh.js","_app/immutable/chunks/2vKNWGK0.js","_app/immutable/chunks/DEOA2049.js","_app/immutable/chunks/BMdEK1vA.js","_app/immutable/entry/app.BhD-UL40.js","_app/immutable/chunks/Bz2BBfIh.js","_app/immutable/chunks/HclGiUj8.js","_app/immutable/chunks/DEWrfOFE.js","_app/immutable/chunks/BMPPvsVT.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js-DUjklfSK.js')),
			__memo(() => import('./nodes/1.js-O3OudPnn.js')),
			__memo(() => import('./nodes/2.js-BVnk-ePx.js')),
			__memo(() => import('./nodes/3.js-pgNOZmwF.js')),
			__memo(() => import('./nodes/4.js-DRH2XYHE.js')),
			__memo(() => import('./nodes/5.js-BhJ-DyDm.js')),
			__memo(() => import('./nodes/6.js-DRv4VSja.js')),
			__memo(() => import('./nodes/7.js-DpA5LvjD.js')),
			__memo(() => import('./nodes/8.js-DgxoL3PY.js')),
			__memo(() => import('./nodes/9.js-CGwYc5dI.js')),
			__memo(() => import('./nodes/10.js-zWkpKJqW.js')),
			__memo(() => import('./nodes/11.js-Dg8rmaTZ.js')),
			__memo(() => import('./nodes/12.js-Cs07p8Lx.js')),
			__memo(() => import('./nodes/13.js-AGWwUSz6.js')),
			__memo(() => import('./nodes/14.js-BBDivY6p.js')),
			__memo(() => import('./nodes/15.js-DV7JmGKx.js')),
			__memo(() => import('./nodes/17.js-BrJK79b9.js')),
			__memo(() => import('./nodes/18.js-XfEfbUEk.js'))
		],
		remotes: {
			'11t944q': __memo(() => import('./chunks/remote-11t944q.js-CqGe0CuU.js')),
			'1a3wgsa': __memo(() => import('./chunks/remote-1a3wgsa.js-D9A2Q176.js')),
			'bjveep': __memo(() => import('./chunks/remote-bjveep.js-CEpM7O8k.js'))
		},
		routes: [
			{
				id: "/(spa)",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 5 },
				endpoint: null
			},
			{
				id: "/(spa)/about",
				pattern: /^\/about\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 6 },
				endpoint: null
			},
			{
				id: "/(spa)/dashboard",
				pattern: /^\/dashboard\/?$/,
				params: [],
				page: { layouts: [0,2,3,], errors: [1,,4,], leaf: 7 },
				endpoint: null
			},
			{
				id: "/(spa)/dashboard/analytics",
				pattern: /^\/dashboard\/analytics\/?$/,
				params: [],
				page: { layouts: [0,2,3,], errors: [1,,4,], leaf: 8 },
				endpoint: null
			},
			{
				id: "/(spa)/dashboard/orders",
				pattern: /^\/dashboard\/orders\/?$/,
				params: [],
				page: { layouts: [0,2,3,], errors: [1,,4,], leaf: 9 },
				endpoint: null
			},
			{
				id: "/(spa)/dashboard/orders/[id]",
				pattern: /^\/dashboard\/orders\/([^/]+?)\/?$/,
				params: [{"name":"id","optional":false,"rest":false,"chained":false}],
				page: { layouts: [0,2,3,], errors: [1,,4,], leaf: 10 },
				endpoint: null
			},
			{
				id: "/(spa)/dashboard/settings",
				pattern: /^\/dashboard\/settings\/?$/,
				params: [],
				page: { layouts: [0,2,3,], errors: [1,,4,], leaf: 11 },
				endpoint: null
			},
			{
				id: "/(spa)/data",
				pattern: /^\/data\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 12 },
				endpoint: null
			},
			{
				id: "/(spa)/forms",
				pattern: /^\/forms\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 13 },
				endpoint: null
			},
			{
				id: "/kit",
				pattern: /^\/kit\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 16 },
				endpoint: null
			},
			{
				id: "/(spa)/nested",
				pattern: /^\/nested\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 14 },
				endpoint: null
			},
			{
				id: "/plain",
				pattern: /^\/plain\/?$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 17 },
				endpoint: null
			},
			{
				id: "/(spa)/server",
				pattern: /^\/server\/?$/,
				params: [],
				page: { layouts: [0,2,], errors: [1,,], leaf: 15 },
				endpoint: null
			}
		],
		prerendered_routes: new Set(["/static"]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();

export { manifest as m };
//# sourceMappingURL=manifest.js-BrnXOSM4.js.map
