<script lang="ts">
	// ROUTER LINKS (e2e/router-document-fetch.spec.ts): the SPA router must land where a real browser
	// navigation would. A link to a path another application serves behind the same origin (the test
	// fakes that server), a web-component link that re-dispatches the visitor's click on its inner
	// `<a>` (the element is defined by the test), and a plain link with a hover preload.
</script>

<h1 data-router-links>Router links</h1>

<p><a href="/router-links/foreign/docs/" data-foreign>foreign page</a></p>
<p><x-relink><a href="/about" data-relink>about (web-component link)</a></x-relink></p>
<p><a href="/about" data-plain data-sveltekit-preload-data="hover">about</a></p>
