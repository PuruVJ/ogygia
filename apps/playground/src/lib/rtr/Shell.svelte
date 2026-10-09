<script>let { children, data } = $props();</script>
<div data-testid="shell"><header class="rtr-header">APP SHELL who={data?.who}</header><div class="body">{@render children()}</div></div>

<style>
	.rtr-header {
		border-bottom: 3px solid #dc2626;
		font-weight: 700;
	}
</style>
