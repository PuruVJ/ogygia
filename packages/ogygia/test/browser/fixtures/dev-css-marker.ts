// Importing this module leaves a marker — proves the dev region-css rescue actually imported the
// url it resolved (a DOCUMENT-relative href resolved against the document, not the runtime module).
document.documentElement.setAttribute('data-og-dev-css-marker', '1');
