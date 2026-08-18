<script lang="ts">
	/**
	 * Localizes the changelog's release dates to the VISITOR's own locale. The build bakes an en-US
	 * default into each `<time class="release-date" datetime="2026-08-12">August 12, 2026</time>`
	 * (see remark-changelog.ts); on the client we reformat the text to `navigator.language` off the
	 * machine-readable `datetime`. No layout shift — same element, new text.
	 *
	 * An ISLAND (`wake: 'load'`), exactly like ogygia CodeChrome: it re-hydrates after every SPA
	 * navigation, so the dates re-localize on each visit to the page instead of only the first paint.
	 * Renders nothing; the work rides an attachment so it has the mounted node to scope from.
	 */
	function localize(anchor: HTMLElement) {
		const fmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
		const root = anchor.closest('.og-doc') ?? document;
		for (const t of root.querySelectorAll('time.release-date[datetime]')) {
			const d = new Date((t.getAttribute('datetime') ?? '') + 'T00:00:00');
			if (!Number.isNaN(+d)) t.textContent = fmt.format(d);
		}
	}
</script>

<span hidden {@attach localize}></span>
