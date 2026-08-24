<script>
  import Widget from './Widget.svelte' with { wake: 'load' };
</script>
<h1 data-testid="phost">profiler view via document()</h1>
<Widget start={7} />
