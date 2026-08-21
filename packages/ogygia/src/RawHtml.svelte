<script lang="ts">
	/**
	 * The component behind a pure-HTML region — what `import.meta.og.code()` / `.md()` render. The
	 * html is baked at build (Shiki / markdown); this just drops it in. Static: ships as HTML, no
	 * client JS of its own beyond the region wrapper.
	 */
	let { html }: { html: string } = $props();
</script>

{@html html}
