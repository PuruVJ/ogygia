<script lang="ts">
	// A plain component that marks itself once it mounted in the browser (its effects ran).
	let el: HTMLElement;
	$effect(() => el.setAttribute('data-mounted', ''));
</script>

<span bind:this={el} data-mx-mounted>mounted?</span>
