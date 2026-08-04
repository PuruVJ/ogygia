<script>
	// CLIENT-BUILD stand-in for a lake component. The island's client module swaps every lake
	// import for THIS placeholder (see the vite plugin `load`), so the real lake component's code
	// ships in NO client chunk. It renders nothing: the runtime lifts the lake's SSR DOM out of its
	// `<ogygia-region>` before the island hydrates and restores it after, so the empty client render
	// matches the (now-empty) region and Svelte reports no hydration mismatch. On SSR the real lake
	// component is used instead (imports are only swapped for the client build).
</script>
