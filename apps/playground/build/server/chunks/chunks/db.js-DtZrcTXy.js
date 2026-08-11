//#region src/lib/server/db.ts
var STATUSES = [
	"pending",
	"shipped",
	"delivered",
	"cancelled"
];
var CUSTOMERS = [
	"Ada Lovelace",
	"Alan Turing",
	"Grace Hopper",
	"Linus T.",
	"Margaret H.",
	"Ken T."
];
function seed() {
	const orders = [];
	let t = Date.UTC(2024, 0, 1, 9, 0, 0);
	for (let i = 1; i <= 240; i++) {
		t += 36e5 + i % 7 * 137e3;
		orders.push({
			id: i,
			customer: CUSTOMERS[i % CUSTOMERS.length],
			status: STATUSES[i % STATUSES.length],
			total: Math.round((20 + i * 37 % 480 + i % 5 * 3.5) * 100) / 100,
			items: 1 + i % 6,
			createdAt: new Date(t)
		});
	}
	return orders;
}
var ORDERS = seed();
function listOrders({ status, sort = "id", dir = "asc", page = 1, perPage = 20 } = {}) {
	let rows = ORDERS.slice();
	if (status && status !== "all") rows = rows.filter((o) => o.status === status);
	const key = sort;
	rows.sort((a, b) => {
		const av = a[key];
		const bv = b[key];
		const cmp = av < bv ? -1 : av > bv ? 1 : 0;
		return dir === "desc" ? -cmp : cmp;
	});
	const total = rows.length;
	const start = (page - 1) * perPage;
	return {
		rows: rows.slice(start, start + perPage),
		total,
		pages: Math.ceil(total / perPage)
	};
}
function getOrder(id) {
	const order = ORDERS.find((o) => o.id === id);
	if (!order) return null;
	return {
		...order,
		lineItems: new Map(Array.from({ length: order.items }, (_, k) => [`SKU-${order.id}-${k + 1}`, {
			qty: k + 1,
			price: 9.99 + k
		}])),
		shipping: {
			address: {
				city: "Cambridge",
				country: "UK"
			},
			updatedAt: new Date(order.createdAt.getTime() + 864e5)
		}
	};
}
function statusCounts() {
	const counts = /* @__PURE__ */ new Map();
	for (const s of STATUSES) counts.set(s, 0);
	for (const o of ORDERS) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
	return counts;
}
function analytics() {
	const byStatus = statusCounts();
	const revenue = ORDERS.reduce((sum, o) => sum + o.total, 0);
	return {
		byStatus,
		revenue: Math.round(revenue * 100) / 100,
		count: ORDERS.length,
		generatedAt: /* @__PURE__ */ new Date()
	};
}
function currentUser() {
	return {
		name: "Grace Hopper",
		role: "admin",
		lastLogin: /* @__PURE__ */ new Date("2024-06-01T08:30:00Z")
	};
}

export { analytics as a, currentUser as c, getOrder as g, listOrders as l, statusCounts as s };
//# sourceMappingURL=db.js-DtZrcTXy.js.map
