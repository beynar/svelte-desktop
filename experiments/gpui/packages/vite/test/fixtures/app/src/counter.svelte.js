export const counter = $state({ n: 0 });
export function bump() {
	counter.n++;
}
