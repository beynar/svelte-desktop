// stub for $lib/registry/hooks/is-mobile — a desktop window is never mobile
export class IsMobile {
	get current() {
		return false;
	}
}
