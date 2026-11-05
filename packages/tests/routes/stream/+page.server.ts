import { Money } from '../../money.ts';

export function load() {
	return {
		// promise fields are NOT awaited — kit streams them; here they just
		// resolve in-place and {#await} picks them up.
		slow: new Promise((r) => setTimeout(() => r('streamed!'), 120)),
		price: new Money(1234), // transport round-trips this
	};
}
