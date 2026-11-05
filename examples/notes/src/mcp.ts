// The app's MCP server, written with the official SDK: an agent's client (Claude Desktop, Cursor…)
// runs these tools in the app, on the same database as the pages. host.mcp.install('claude-desktop')
// connects it.
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDb } from '#lib/server/db.ts';

const json = <T extends Record<string, unknown>>(value: T) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(value) }],
	structuredContent: value
});

export default () => {
	const server = new McpServer({ name: 'Svelte Notes', version: '0.1.0' });

	server.registerTool(
		'list_notes',
		{
			title: 'List notes',
			description: 'The most recent notes, newest first.',
			inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(10) }),
			annotations: { readOnlyHint: true }
		},
		({ limit }) => json({ notes: getDb().query('SELECT id, text FROM notes ORDER BY id DESC LIMIT ?').all(limit) })
	);

	server.registerTool(
		'add_note',
		{
			title: 'Add a note',
			description: 'Adds a note and returns its id.',
			inputSchema: z.object({ text: z.string().min(1) })
		},
		({ text }) => {
			const { lastInsertRowid } = getDb().run('INSERT INTO notes (text) VALUES (?)', [text]);
			return json({ id: Number(lastInsertRowid) });
		}
	);

	return server;
};
