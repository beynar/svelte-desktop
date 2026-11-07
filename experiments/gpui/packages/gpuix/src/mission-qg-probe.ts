/**
 * Mission probe — runtime-test the bound QuickGUI services (worker context,
 * binding initialized by runApplication). No window created.
 */
import { app, Screen, Clipboard, SystemPreferences, Appearance, Keyboard, PowerMonitor, Permissions, Shell, Notifications } from '@quickgui/native';
import { appendFileSync } from 'fs';

const OUT = new URL('../../results/run-20260915-b/qg-services.jsonl', import.meta.url).pathname;
const rec = (o: object) => appendFileSync(OUT, JSON.stringify({ ts: Date.now(), ...o }) + '\n');
const probe = async (name: string, fn: () => Promise<unknown> | unknown) => {
	try {
		const v = await fn();
		console.log(`✅ ${name}:`, JSON.stringify(v)?.slice(0, 220));
		rec({ probe: name, ok: true, result: JSON.parse(JSON.stringify(v ?? null, (_k, x) => typeof x === 'bigint' ? String(x) : x)) });
	} catch (e) {
		console.log(`❌ ${name}: ${(e as Error).message}`);
		rec({ probe: name, ok: false, error: (e as Error).message });
	}
};

await app.whenReady();
console.log('app ready — probing services');

await probe('Screen.getAllDisplays', () => Screen.getAllDisplays());
await probe('Screen.getPrimaryDisplay', () => Screen.getPrimaryDisplay());
await probe('Screen.getCursorScreenPoint', () => Screen.getCursorScreenPoint());
await probe('Clipboard.writeText+readText', async () => {
	await Clipboard.writeText('mission2-probe');
	return Clipboard.readText();
});
await probe('Clipboard.availableFormats', () => Clipboard.availableFormats());
await probe('Appearance.getCurrent', () => Appearance.getCurrent());
await probe('SystemPreferences.getCurrent', () => SystemPreferences.getCurrent());
await probe('Keyboard.getLayout', () => Keyboard.getLayout());
await probe('PowerMonitor.getState', () => PowerMonitor.getState());
await probe('PowerMonitor.getSystemIdleTime', () => PowerMonitor.getSystemIdleTime());
await probe('Permissions.status(notifications)', () => Permissions.status('notifications'));
await probe('Notifications.getPermissionStatus', () => Notifications.getPermissionStatus());
// positive-path openExternal intentionally NOT_RUN — real browser side effect.
await probe('Shell.openExternal(javascript:)', () => Shell.openExternal('javascript:alert(1)'));

console.log('probes done — exiting');
process.exit(0);
