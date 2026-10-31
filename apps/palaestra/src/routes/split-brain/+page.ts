// Page data for the SharedData fixture: on this csr=false page the SAME shared component
// reads the ISLAND shim, seeded from the document-level `application/ogygia-page` script.
export function load() {
	return { sharedWord: 'IslandWorld' };
}
