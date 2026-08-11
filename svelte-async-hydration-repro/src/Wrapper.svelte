<script>
  // Renders the component it is handed — mirrors the island runtime's hydrate wrapper. The SSR side
  // rendered the async component DIRECTLY; the client hydrates this wrapper (which renders it).
  let { component: Component } = $props();
</script>

<Component />
