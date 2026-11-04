import { callPlatform, onPlatform } from './bus';
import type { WebviewSource, WebviewTarget } from './index';

export type DownloadState = 'requested' | 'downloading' | 'pausing' | 'finishing' | 'paused' | 'completed' | 'interrupted' | 'canceled';
export type DownloadRecord = WebviewSource & {
	id: string; url: string; path?: string; suggestedFilename: string; mimeType: string | null;
	state: DownloadState; receivedBytes: number; totalBytes: number; fraction: number;
	/** Requires opaque resume data and a known total length. */
	canResume: boolean;
	/** Opaque native checkpoint reference. WebKit bytes stay native; resume by id. */
	resumeData?: string;
	/** Bytes in the durable checkpoint; later resumes can rewind to this position. */
	resumeBytes?: number;
	startedAt: number; updatedAt: number; error?: string;
};
export type DownloadRequest = WebviewSource & { id: string; url: string; suggestedFilename: string; mimeType: string | null; size: number };
export type DownloadDecision = { path: string } | 'cancel' | 'default';

export const downloads = {
	/** One app-wide handler; latest installation wins. Await installation before starting downloads; errors/timeouts cancel. */
	async onRequested(handler: (request: DownloadRequest) => DownloadDecision | Promise<DownloadDecision>): Promise<() => Promise<void>> {
		const handlerId = crypto.randomUUID();
		const off = onPlatform<DownloadRequest & { handlerId: string }>('downloadRequested', (request) => {
			if (request.handlerId !== handlerId) return;
			void Promise.resolve().then(() => handler(request)).catch(() => 'cancel' as const).then((decision) =>
				callPlatform<null>('webview', 'decideDownload', { id: request.id, handlerId, decision }),
			).catch((error) => console.error('Download decision failed', error));
		});
		try { await callPlatform<null>('webview', 'setDownloadHandler', { handlerId }); }
		catch (error) { off(); throw error; }
		return async () => {
			await callPlatform<null>('webview', 'clearDownloadHandler', { handlerId });
			off();
		};
	},
	get: (id: string) => callPlatform<DownloadRecord | null>('webview', 'getDownload', { id }),
	list: () => callPlatform<DownloadRecord[]>('webview', 'listDownloads'),
	/** Cancel the transfer and retain resume data when the server/WebKit provides it. */
	pause: (id: string) => callPlatform<DownloadRecord>('webview', 'pauseDownload', { id }),
	resume: (id: string, target: WebviewTarget = {}) => callPlatform<DownloadRecord>('webview', 'resumeDownload', { ...target, id }),
	cancel: (id: string) => callPlatform<DownloadRecord>('webview', 'cancelDownload', { id, snapshot: true }),
	onChanged: (cb: (download: DownloadRecord) => void) => onPlatform('downloadChanged', cb),
};
