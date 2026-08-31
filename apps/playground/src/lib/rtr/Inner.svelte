<script>let { children, data } = $props();</script>
<section data-testid="inner"><nav>DOCS NAV n={data?.nav}</nav><div>{@render children()}</div></section>
