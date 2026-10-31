// Tiny in-memory store for the form-actions demo (server-only).
// Ring-capped + field length limits so a public deploy cannot grow forever.

export interface Entry {
	name: string;
	message: string;
	at: Date;
}

const MAX_NAME = 64;
const MAX_MESSAGE = 280;
const MAX_ENTRIES = 48;

const entries: Entry[] = [{ name: 'Ada', message: 'first!', at: new Date('2024-01-01T00:00:00Z') }];

export function listEntries(): Entry[] {
	return entries.slice().reverse();
}

export function addEntry(name: string, message: string): Entry {
	const n = name.slice(0, MAX_NAME);
	const m = message.slice(0, MAX_MESSAGE);
	const entry: Entry = { name: n, message: m, at: new Date() };
	entries.push(entry);
	while (entries.length > MAX_ENTRIES) entries.shift();
	return entry;
}
