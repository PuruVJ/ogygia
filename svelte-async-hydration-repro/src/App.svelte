<script>
  // A top-level `await` makes this an ASYNC component (needs experimental.async).
  const label = await new Promise((r) => setTimeout(() => r('server-rendered content'), 50));
</script>

<div class="box" data-box>{label}</div>

<style>
  /* If the class is present the box is green. If the class is (transiently) removed during
     hydration, the box paints unstyled — that is the visible flash. */
  .box {
    padding: 1.5rem 2rem;
    border-radius: 12px;
    background: seagreen;
    color: white;
    font: 700 1.25rem/1.2 system-ui, sans-serif;
  }
</style>
