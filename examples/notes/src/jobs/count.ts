// A background job: runs in its own process (the app's executable acting as Bun).
// Started from server code with `host.jobs.start('count', { to: 20 })`. No import:
// HostJob is a global type.
const count: HostJob<{ to?: number; delay?: number }, { counted: number; pid: number }> = async ({ to = 10, delay = 50 }, ctx) => {
	for (let i = 1; i <= to; i++) {
		if (ctx.signal.aborted) throw new Error('canceled');
		await Bun.sleep(delay);
		ctx.progress(i / to, `${i}/${to}`);
		if (i === Math.ceil(to / 2)) ctx.emit({ halfway: i });
	}
	ctx.log(`counted to ${to} in pid ${process.pid}`);
	return { counted: to, pid: process.pid };
};
export default count;
