<script>
	// csr=false CLIENT host stand-in for a portable island binding.
	// SSR / csr=true keep the real wrapper; hydrate loads via import(entry) only.
	// Beside this stub the transform emits `import 'virtual:ogygia/fouc-css/…'` so Kit still
	// collects island CSS into the page stylesheet graph — without dual-owning component JS.
</script>
