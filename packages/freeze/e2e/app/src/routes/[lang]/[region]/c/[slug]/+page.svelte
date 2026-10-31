<script lang="ts">
	let { data } = $props();
</script>

<h1 data-freeze-page data-slug={data.slug}>{data.slug}</h1>
<p data-body>{data.body}</p>
<p>version <span data-version>{data.version}</span></p>
<p>promo <span data-promo>{data.promo.version}</span></p>
<p>render <span data-render>{data.render}</span></p>
