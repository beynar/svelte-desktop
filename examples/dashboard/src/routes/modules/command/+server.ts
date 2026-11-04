// The app's command in the terminal (desktop.config `command`): its status, install, uninstall.
import { json } from '@sveltejs/kit';

export const GET = async () => json(await host.command.status());
export const POST = async () => {
	try {
		return json(await host.command.install());
	} catch (e) {
		return json({ error: (e as Error).message }, { status: 400 });
	}
};
export const DELETE = async () => (await host.command.uninstall(), json(await host.command.status()));
