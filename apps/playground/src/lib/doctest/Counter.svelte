<script>
  let { start = 0 } = $props();
  let n = $state(start);
</script>
<button onclick={() => n++} data-testid="counter">clicked {n}×</button>
<style>
  button { font: 15px system-ui; padding: 6px 12px; background: #1c2530; color: #d8dee6; border: 1px solid #38506a; border-radius: 6px; cursor: pointer; }
</style>
