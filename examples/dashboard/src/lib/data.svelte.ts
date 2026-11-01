// The dashboard's state, shared by its three pages (in memory: a real app would load and persist it
// with remote functions). Dates are relative to today so the calendar always has something to show.
import type { KanbanColumnData } from 'entasis/kanban';
import type { EventCalendarItem } from 'entasis/event-calendar';

export type Task = { id: string; title: string; description?: string };
export type Meeting = { location?: string };

export const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const at = (dayOffset: number, hour: number, minute = 0) => {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hour, minute, 0, 0);
	return d;
};
const civil = (dayOffset: number) => {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export type Board = { columns: KanbanColumnData<Task>[] };

const emptyColumns = (): KanbanColumnData<Task>[] => [
	{ id: 'backlog', title: 'Backlog', color: 'neutral', cards: [] },
	{ id: 'doing', title: 'In progress', color: 'primary', cards: [] },
	{ id: 'review', title: 'Review', color: 'warning', limit: 3, cards: [] },
	{ id: 'done', title: 'Done', color: 'success', cards: [] }
];

/** Every board, by id (the Board page shows one per tab). */
export const boards = $state<Record<string, Board>>({});

/** A board, created empty the first time it's asked for (a restored tab of a past session). */
export function boardFor(id: string): Board {
	if (!boards[id]) boards[id] = { columns: emptyColumns() };
	return boards[id];
}

/** The current sprint: the one the overview sums up. */
export const board: Board = boardFor('current');
board.columns = [
		{
			id: 'backlog',
			title: 'Backlog',
			color: 'neutral',
			cards: [
				{ id: 't1', title: 'Customer interviews', description: 'Five calls with design partners' },
				{ id: 't2', title: 'Pricing page copy' },
				{ id: 't3', title: 'Audit onboarding emails', description: 'Drop-off after day 3' }
			]
		},
		{
			id: 'doing',
			title: 'In progress',
			color: 'primary',
			cards: [
				{ id: 't4', title: 'Billing migration', description: 'Move invoices to the new provider' },
				{ id: 't5', title: 'Dashboard redesign' }
			]
		},
		{ id: 'review', title: 'Review', color: 'warning', limit: 3, cards: [{ id: 't6', title: 'Q4 roadmap', description: 'Needs sign-off' }] },
		{ id: 'done', title: 'Done', color: 'success', cards: [{ id: 't7', title: 'SOC 2 evidence' }, { id: 't8', title: 'Release 2.4' }] }
	];
boardFor('backlog').columns[0]!.cards.push(
	{ id: 'b1', title: 'Dark mode for exports' },
	{ id: 'b2', title: 'SSO with Okta', description: 'Asked by three customers' },
	{ id: 'b3', title: 'Bulk edit tasks' }
);

export const calendar = $state<{ items: EventCalendarItem<Meeting>[] }>({
	items: [
		{ id: 'e1', title: 'Team stand-up', start: at(0, 9, 30), end: at(0, 9, 45), color: 'success' },
		{ id: 'e2', title: 'Design review', start: at(0, 14), end: at(0, 15), color: 'primary', location: 'Studio' },
		{ id: 'e3', title: 'Customer call — Acme', start: at(1, 11), end: at(1, 12), color: 'info' },
		{ id: 'e4', title: 'Planning', start: at(2, 10), end: at(2, 11, 30), color: 'primary' },
		{ id: 'e5', title: 'Offsite', start: civil(4), end: civil(6), allDay: true, color: 'warning' },
		{ id: 'e6', title: '1:1 with Sam', start: at(-1, 16), end: at(-1, 16, 30), color: 'neutral' }
	]
});

/** Events that start today or later, soonest first. */
export const upcoming = () =>
	calendar.items
		.map((e) => ({ e, start: e.allDay ? new Date(`${e.start}T00:00`) : (e.start as Date) }))
		.filter(({ start }) => start >= new Date(new Date().setHours(0, 0, 0, 0)))
		.sort((a, b) => +a.start - +b.start)
		.map(({ e, start }) => ({ ...e, startsAt: start }));
