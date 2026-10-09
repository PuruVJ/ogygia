<script>
	// The served header shape on a csr=true page: a LAKE (wake:'none') with a page-reading island
	// inside, waking on idle. setup.ts SSRs this on a Kit document with `page.data.searchBarMarkup`
	// set; the browser test boots the runtime BEFORE Kit's page thread exists.
	import Region from '../../../src/Region.svelte';
	import PageReader from './PageReader.svelte';
</script>

<div data-shell>
	<Region __mode="lake" __entry="lake-reader"><p data-frozen>frozen</p><Region
			__mode="island"
			__entry="/test/browser/fixtures/PageReader.svelte"
			__component={PageReader}
			__props={{}}
			idle={true}
		/></Region>
</div>
