// A page that takes a while to come (the tests close its tab meanwhile).
export const load = async () => {
	await new Promise((resolve) => setTimeout(resolve, 700));
	return {};
};
