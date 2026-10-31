// Update probe used by scripts/test-update.sh: prints the running version and,
// with NOTES_UPDATE_PROBE=1, checks the feed and installs (the helper relaunches).
import { onDesktopReady } from '@svelte-desktop/shell/server';

if (Bun.env.NOTES_UPDATE_PROBE) {
	onDesktopReady(async () => {
		const { updater, app } = await import('@svelte-desktop/shell/platform');
		const info = await app.getInfo();
		await Bun.write('/tmp/upd/probe.log', `started ${info.version}\n`, { createPath: true }).catch(() => {});
		if (Bun.env.NOTES_UPDATE_PROBE !== '1') return;
		try {
			const update = await updater.check();
			await Bun.write('/tmp/upd/probe.log', `started ${info.version}\ncheck ${update ? update.version : 'none'}\n`);
			if (update) await update.downloadAndInstall();
		} catch (e) {
			await Bun.write('/tmp/upd/probe.log', `started ${info.version}\nerror ${(e as Error).message}\n`);
		}
	});
}
