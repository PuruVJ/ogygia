// A PLAIN (unmarked) relative import captured into a snippet body. This one always resolved — the
// driver's `resolve_id` rebases a portable entry's plain imports against its real origin — and it
// stays in the fixture as the guard that the marked-import fix did not disturb that path.
export const shout = (s: string) => s.toUpperCase();
