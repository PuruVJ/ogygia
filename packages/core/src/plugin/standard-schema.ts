/**
 * The Standard Schema interface (standardschema.dev): the `~standard` spec Zod / Valibot / ArkType all
 * implement, the very thing Kit's remote functions consume. Validate a value with any schema library.
 * Types only.
 */
export interface StandardSchemaV1<Output = unknown> {
	readonly '~standard': {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
		readonly types?: { readonly output: Output };
	};
}
export type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardIssue> };
export interface StandardIssue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}
