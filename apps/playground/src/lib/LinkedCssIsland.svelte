<script lang="ts">
	// The CONTROL twin of InlineCssIsland: the same rules for the button, but the sheet is padded
	// OVER the playground's `kit.inlineStyleThreshold` (400 bytes) with real `:global` rules (a
	// comment would be minified away; an unused scoped selector would be pruned), so it ships as a
	// `<link>` — the shape every region sheet had before inlining existed. e2e/inline-css compares
	// the two islands' computed styles on the same page: with or without the threshold, styling
	// must be identical.
	let n = $state(0);
</script>

<button class="linked-css" data-linked-css onclick={() => n++}>linked:{n}</button>

<style>
	.linked-css {
		letter-spacing: 3px;
		border: 2px solid rgb(17, 34, 51);
	}
	/* padding rules — never matched, never pruned (:global), kept by the minifier */
	:global(.og-pad-linked-01) { padding-inline-start: 1px; }
	:global(.og-pad-linked-02) { padding-inline-start: 2px; }
	:global(.og-pad-linked-03) { padding-inline-start: 3px; }
	:global(.og-pad-linked-04) { padding-inline-start: 4px; }
	:global(.og-pad-linked-05) { padding-inline-start: 5px; }
	:global(.og-pad-linked-06) { padding-inline-start: 6px; }
	:global(.og-pad-linked-07) { padding-inline-start: 7px; }
	:global(.og-pad-linked-08) { padding-inline-start: 8px; }
	:global(.og-pad-linked-09) { padding-inline-start: 9px; }
	:global(.og-pad-linked-10) { padding-inline-start: 10px; }
	:global(.og-pad-linked-11) { padding-inline-start: 11px; }
	:global(.og-pad-linked-12) { padding-inline-start: 12px; }
	:global(.og-pad-linked-13) { padding-inline-start: 13px; }
	:global(.og-pad-linked-14) { padding-inline-start: 14px; }
	:global(.og-pad-linked-15) { padding-inline-start: 15px; }
	:global(.og-pad-linked-16) { padding-inline-start: 16px; }
</style>
