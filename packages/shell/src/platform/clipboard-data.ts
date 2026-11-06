import { callPlatform } from './bus';

export type ClipboardData = {
	text?: string;
	html?: string;
	rtf?: string;
	/** PNG image bytes, base64 encoded. */
	image?: string;
	/** Absolute file paths. */
	files?: string[];
	/** Native pasteboard UTIs, Linux selection targets or Windows registered formats (or standard MIME names) to base64 bytes. */
	formats?: Record<string, string>;
};
export type ClipboardRead = { changeCount: number; formats: Record<string, string | null> };
export const clipboardData = {
	/** Publishes all representations with one ownership change. */
	write: (data: ClipboardData) => callPlatform<{ changeCount: number; previousChangeCount: number }>('clipboard', 'write', data),
	/** Base64 bytes; maxBytes caps the combined result (default/max 16 MiB). */
	read: (options: { formats: string[]; maxBytes?: number }) => callPlatform<ClipboardRead>('clipboard', 'read', options),
};
