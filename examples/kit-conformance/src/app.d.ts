declare global {
	namespace App {
		interface Locals {
			hookRan: boolean;
		}
		interface Error {
			message: string;
		}
	}
}
export {};
