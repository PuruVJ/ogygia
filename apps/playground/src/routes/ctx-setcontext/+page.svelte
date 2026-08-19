<script lang="ts">
	// Child islands that read the layout's drop-in setContext via UNCHANGED raw getContext('key').
	// None of them import from ogygia — they are ordinary islands reading string-keyed context.
	import SetCtxReader from '$lib/SetCtxReader.svelte' with { wake: 'load' };
	import SetCtxReaderVisible from '$lib/SetCtxReader.svelte' with { wake: 'visible' };
	import SetCtxWriter from '$lib/SetCtxWriter.svelte' with { wake: 'load' };
</script>

<nav><a href="/">Home</a></nav>
<hr />
<h1 data-static-shell>Drop-in setContext bridge</h1>

<p>A csr=false layout calls <code>setContext</code> (imported from ogygia). These islands read it:</p>

<SetCtxReader label="load" />
<SetCtxWriter />

<div style="height: 150vh"></div>
<p>Below the fold — hydrates on scroll, still reads the same context:</p>
<SetCtxReaderVisible label="visible" />
