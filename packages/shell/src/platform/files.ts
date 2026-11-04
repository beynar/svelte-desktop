import { callPlatform } from './bus';

export type BookmarkAccess = { path: string; stale: boolean; release(): Promise<void> };

/** macOS file bookmarks. Outside the App Sandbox they resolve ordinary file bookmarks. */
export const files = {
	/** Cannot grant new sandbox access: create from a path the app can already access. */
	createBookmark: (path: string) => callPlatform<{ bookmark: string }>('files', 'createBookmark', { path }),
	async openBookmark(bookmark: string): Promise<BookmarkAccess> {
		const { id, path, stale } = await callPlatform<{ id: string; path: string; stale: boolean }>('files', 'openBookmark', { bookmark });
		let releasing: Promise<void> | undefined;
		return {
			path, stale,
			release: () => releasing ??= callPlatform<null>('files', 'releaseBookmark', { id }).then(() => {}, (error) => { releasing = undefined; throw error; }),
		};
	},
};
