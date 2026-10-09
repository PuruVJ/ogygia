import type { ParamMatcher } from '@sveltejs/kit';

// Matcher for the deep-dynamic csr=true fixture — `[id=word]` route segments keep the `=word`
// suffix in BOTH Kit's runtime `route.id` and ogygia's filesystem-derived csr_true_routes set;
// the e2e proves the two sides agree for matcher routes (the consumer-reported shape).
const WORD_RE = /^[a-z][a-z0-9-]*$/;
export const match: ParamMatcher = (value) => WORD_RE.test(value);
