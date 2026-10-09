// A fresh value per HOLE render — proves holes stay per-request inside a frozen shell.
// Lives OUTSIDE $lib/server so the deferred island component stays importable wherever the
// island graph reaches (Kit's server-only guard would fail the client analysis otherwise).
let hole_serial = 0;
export function next_hole_serial(): number {
	return ++hole_serial;
}
