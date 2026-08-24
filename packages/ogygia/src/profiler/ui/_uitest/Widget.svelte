<script>
  let { start = 0 } = $props();
  let n = $state(start);
</script>
<button onclick={() => n++} data-testid="pcounter">profiler-island {n}×</button>
