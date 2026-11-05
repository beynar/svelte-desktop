// What a web view keeps by origin survives a relaunch (`bunx --bun vite build` first): the app's
// server keeps its port (src/app-port.ts). It opens the app's window twice: run it when that's fine.
import { expect, test } from 'bun:test';
import { launch } from '@kitop/shell/test';

const openDb = `new Promise((resolve, reject) => {
	const open = indexedDB.open('relaunch', 1);
	open.onupgradeneeded = () => open.result.createObjectStore('s');
	open.onsuccess = () => resolve(open.result);
	open.onerror = () => reject(open.error);
})`;

test.skipIf(!!process.env.DESKTOP_TEST_DEV)('localStorage and IndexedDB are still there after a relaunch', async () => {
	const stamp = String(Date.now());
	const first = await launch({});
	await first.waitFor('#counter');
	const origin = await first.eval('location.origin');
	await first.eval(`(async () => {
		localStorage.setItem('relaunch', '${stamp}');
		const db = await ${openDb};
		await new Promise((done) => {
			const tx = db.transaction('s', 'readwrite');
			tx.objectStore('s').put('${stamp}', 'k');
			tx.oncomplete = done;
		});
	})()`);
	await Bun.sleep(1500); // what web views write to disk comes a moment after
	await first.close();

	const second = await launch({});
	try {
		await second.waitFor('#counter');
		expect(await second.eval('location.origin')).toBe(origin);
		expect(await second.eval(`localStorage.getItem('relaunch')`)).toBe(stamp);
		expect(
			await second.eval(`(async () => {
				const db = await ${openDb};
				return new Promise((done) => {
					const get = db.transaction('s').objectStore('s').get('k');
					get.onsuccess = () => done(get.result);
				});
			})()`)
		).toBe(stamp);
	} finally {
		await second.close();
	}
}, 60_000);
