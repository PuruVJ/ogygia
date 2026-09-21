<script lang="ts">
	// The design system's icon: the whole icon set is an object literal rebuilt on every render
	// (it lives inside the component's script), then one path is looked up.
	let { name, size = 16 }: { name: string; size?: number } = $props();
	const ICONS: Record<string, string> = {
		pdf: 'M4 2h9l5 5v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L12 3.5z',
		file: 'M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
		cart: 'M3 3h2l3 12h10l3-8H7M9 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
		star: 'M12 2l3 7 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z',
		chevron: 'M9 6l6 6-6 6',
		flag: 'M4 22V4h12l-1 4 1 4H4',
		filter: 'M3 4h18l-7 9v6l-4 2v-8z',
		...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`icon-${i}`, `M${i} ${i}h${i}v${i}z`]))
	};
	const d = ICONS[name] ?? ICONS.file;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path {d} fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
