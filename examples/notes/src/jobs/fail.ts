export default async function () {
	await Bun.sleep(20);
	throw new Error('this job always fails');
}
