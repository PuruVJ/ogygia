<script>
  import Counter from './Counter.svelte' with { wake: 'load' };
  let { label = 'doc' } = $props();
</script>
<svelte:head>
  <title>document() test — {label}</title>
  <meta name="doctest-marker" content="from-svelte-head">
</svelte:head>
<main>
  <h1>document() renders a full ogygia page</h1>
  <p data-testid="label">label: {label}</p>
  <Counter start={3} />
</main>
<style>
  main { max-width: 600px; margin: 40px auto; font: 15px system-ui; color: #d8dee6; }
  h1 { color: #5eead4; }
</style>
