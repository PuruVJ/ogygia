//#region src/lib/server/guestbook.ts
var entries = [{
	name: "Ada",
	message: "first!",
	at: /* @__PURE__ */ new Date("2024-01-01T00:00:00Z")
}];
function listEntries() {
	return entries.slice().reverse();
}
function addEntry(name, message) {
	const entry = {
		name,
		message,
		at: /* @__PURE__ */ new Date()
	};
	entries.push(entry);
	return entry;
}

export { addEntry as a, listEntries as l };
//# sourceMappingURL=guestbook.js-tHxGKFqJ.js.map
