export const load = () => ({
	locale: 'fr-FR',
	countryApiKey: 'abc-123',
	nested: { flags: { helpCenter: true } },
	// Two STREAMED promises (returned unresolved) at different speeds — Kit allows a promise at any
	// level. On csr=false the island streams each resolution independently, fast-first. The delays are
	// long enough for the e2e to prove the shell shipped BEFORE either settled (non-blocking).
	fast: new Promise<string>((res) => setTimeout(() => res('FAST-VALUE'), 90)),
	slow: new Promise<string>((res) => setTimeout(() => res('STREAMED-VALUE'), 350))
});
