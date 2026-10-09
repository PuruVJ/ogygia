<script lang="ts">
	// PLANTED dom-churn: one click rewrites the same node 500 times.
	let box: HTMLElement;
	function churn() {
		for (let i = 0; i < 500; i++) box.setAttribute('data-step', String(i));
	}
</script>

<div data-ds="churn"><button onclick={churn}>churn</button><span bind:this={box}>box</span></div>
