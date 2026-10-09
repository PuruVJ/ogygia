<script lang="ts">
	// FOREIGN-MUTATION DETECTOR fixture (e2e/detector.ts): the hooks transform below corrupts
	// THIS page's region HTML (strips Svelte's hydration anchors — what the se.com DSD middleware
	// did), forcing Svelte's silent mismatch recovery. The detector must flag it.
	import Broken from './Broken.svelte' with { wake: 'load' };
	import Healthy from './Healthy.svelte' with { wake: 'load' };
</script>

<h1>detector fixture</h1>
<Broken label="corrupted island" />
<Healthy label="healthy island" />
