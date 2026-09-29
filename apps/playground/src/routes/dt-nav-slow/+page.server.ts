// PLANTED slow in-app navigation: the page's load waits 800 ms, so a router navigation here spends
// most of its time fetching the page. The devtools and the profiler must name it and say so.
export const load = async () => {
	await new Promise((ok) => setTimeout(ok, 800));
	return { at: Date.now() };
};
