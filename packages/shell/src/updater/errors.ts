export type UpdateErrorCode =
	| "config_invalid"
	| "manifest_fetch_failed"
	| "manifest_invalid"
	| "signature_invalid"
	| "name_mismatch"
	| "channel_mismatch"
	| "download_failed"
	| "aborted"
	| "size_mismatch"
	| "hash_mismatch"
	| "extract_failed"
	| "layout_invalid"
	| "install_not_found"
	| "not_writable"
	| "helper_failed";

export class UpdateError extends Error {
	readonly code: UpdateErrorCode;
	constructor(code: UpdateErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "UpdateError";
		this.code = code;
	}
}
