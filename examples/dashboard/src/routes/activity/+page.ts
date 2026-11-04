// When this activity started. Its load runs where its page runs: the tab's own view — the window
// only takes its address (performance mark: the tests check the window never loads it).
export const load = () => {
	if (typeof performance !== 'undefined') performance.mark('activity:load');
	return { startedAt: Date.now() };
};
