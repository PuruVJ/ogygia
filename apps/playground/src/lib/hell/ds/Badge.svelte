<script lang="ts">
	// The design system's badge: a tone map, an i18n'd title, a tracking call.
	import { t } from '../i18n';
	import { track } from '../track';
	let { tone = 'neutral', label, count }: { tone?: string; label: string; count?: number } = $props();
	const tones: Record<string, string> = { neutral: '#666', new: '#0a7', hot: '#c33', info: '#36c' };
	const title = count === undefined ? label : t('facet.count', { n: count });
	track('ds.badge', { tone, label });
</script>

<span class="ds-badge" style="--tone:{tones[tone] ?? tones.neutral}" {title}>{label}{#if count !== undefined} <small>{count}</small>{/if}</span>
