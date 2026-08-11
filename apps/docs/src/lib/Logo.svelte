<script lang="ts">
	let {
		size = 20,
		stroke = 2.25,
		decorative = false
	}: { size?: number; stroke?: number; decorative?: boolean } = $props();
</script>

<svg
	viewBox="0 0 32 32"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	aria-hidden={decorative ? 'true' : undefined}
	role={decorative ? undefined : 'img'}
	aria-label={decorative ? undefined : 'ogygia logo'}
>
	<!-- island mound -->
	<path d="M4 26 Q16 20 28 26" />
	<!-- trunk -->
	<path d="M16 21.5 Q14.5 14 17 8" />
	<!-- fronds -->
	<path d="M17 8 Q12 5 7.5 7" />
	<path d="M17 8 Q17 4 21 3.5" />
	<path d="M17 8 Q22 6.5 25.5 9.5" />
</svg>
