// Tiny in-memory store for the form-actions demo (server-only).
export interface Entry {
	name: string;
	message: string;
	at: Date;
}

const entries: Entry[] = [{ name: 'Ada', message: 'first!', at: new Date('2024-01-01T00:00:00Z') }];

export function listEntries(): Entry[] {
	return entries.slice().reverse();
}

export function addEntry(name: string, message: string): Entry {
	const entry: Entry = { name, message, at: new Date() };
	entries.push(entry);
	return entry;
}
