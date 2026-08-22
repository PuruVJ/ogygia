<script>
	// A stand-in for ogygia's interactive content wrappers (TabGroup / Tab / …) in the Observatory's
	// LIVE (plain-svelte) mount. The real components are islands — their children cross via ogygia's
	// region-snippet bridge, which only exists under the real runtime (the preview's "islands" mode).
	// Here we just render the children (with the tab `label` if present) so a `.md` using `::: tabs` /
	// `::: code-group` shows its content stacked instead of crashing the mount. Switch to islands mode
	// for the real, interactive version.
	let { label, children } = $props();
</script>

{#if label}<div class="repl-passthrough-label">{label}</div>{/if}
{@render children?.()}

<style>
	.repl-passthrough-label {
		margin: 10px 0 4px;
		font-size: 12px;
		font-weight: 600;
		opacity: 0.7;
	}
</style>
