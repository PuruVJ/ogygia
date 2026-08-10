import { useState } from 'preact/hooks';

/** Canonical bench widget — identical DOM across every framework. */
export default function Counter({ start = 0 }) {
	const [n, setN] = useState(start);
	return (
		<button class="bench-counter" onClick={() => setN(n + 1)}>
			count: {n}
		</button>
	);
}
