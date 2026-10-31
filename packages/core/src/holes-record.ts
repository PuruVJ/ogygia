/**
 * The holes record's script type — ONE constant shared by the server (document-tail.ts writes the
 * record) and the runtime (hole-facts.ts reads it), kept import-free so the runtime bundle never
 * reaches into server code for a string.
 */
export const HOLES_SCRIPT_TYPE = 'application/ogygia-holes';
