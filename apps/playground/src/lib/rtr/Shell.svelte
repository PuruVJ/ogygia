<script>let { children, data } = $props();</script>
<div data-testid="shell"><header>APP SHELL who={data?.who}</header><div class="body">{@render children()}</div></div>
