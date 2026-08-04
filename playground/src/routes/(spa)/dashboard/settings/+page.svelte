<script>
	import Counter from '$lib/Counter.svelte' with { island: 'load' };
</script>

<h1 data-static-shell>Settings</h1>
<p data-static-shell>A plain page with one counter island plus authored scripts.</p>

<!-- inline script (Astro is:inline style): runs on FIRST load; does NOT re-run on SPA nav -->
<div>
	<script>
		window.__settingsInline = (window.__settingsInline || 0) + 1;
	</script>
</div>

<!-- inline script with data-rerun: re-runs on every SPA arrival -->
<div>
	<script data-rerun>
		window.__rerunCount = (window.__rerunCount || 0) + 1;
	</script>
</div>

<!-- bundled <script island>: extracted into its own module chunk, imports resolve/bundle,
     module URL de-duped across SPA navs (runs once) -->
<div>
	<script island>
		import { mark } from '$lib/bundled-helper.js';
		window.__bundledRan = (window.__bundledRan || 0) + 1;
		mark();
	</script>
</div>

<Counter start={7} label="Settings counter" />
