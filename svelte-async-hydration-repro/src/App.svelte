<script>
  // Async data driving an `{#each}` INSIDE the fixed root — mirrors SideNav: `await docNav()` feeds a
  // nav list rendered inside `<div class="side-root" class:side-root--open={open}>`.
  const items = await Promise.resolve(['Overview', 'How it works', 'Install', 'Quickstart']);
  let open = false;
</script>

<div class="panel" class:panel--open={open} data-box>
  <div class="header">nav</div>
  <ul>
    {#each items as it}
      <li>{it}</li>
    {/each}
  </ul>
</div>

<style>
  .panel {
    position: fixed;
    top: 10px;
    right: 10px;
    width: 220px;
  }
  .header {
    padding: 1.5rem 2rem;
    border-radius: 12px;
    background: seagreen;
    color: white;
    font: 700 1.25rem/1.2 system-ui, sans-serif;
  }
</style>
