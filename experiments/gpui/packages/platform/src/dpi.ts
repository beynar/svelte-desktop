/**
 * Logical vs physical pixel geometry. Physical values are device pixels
 * (integers — conversions round); logical values are scale-factor-independent
 * points. `window.scaleFactor` / `screen.scaleFactor` supply the factor.
 *
 * toJSON emits the plain `{x,y}` / `{width,height}` shape so instances can
 * cross callPlatform args transparently.
 */

export class LogicalPosition {
	constructor(
		public x: number,
		public y: number,
	) {}
	toPhysical(scaleFactor: number): PhysicalPosition {
		return new PhysicalPosition(
			Math.round(this.x * scaleFactor),
			Math.round(this.y * scaleFactor),
		);
	}
	toLogical(_scaleFactor: number): LogicalPosition {
		return this;
	}
	toJSON(): { x: number; y: number } {
		return { x: this.x, y: this.y };
	}
}

export class PhysicalPosition {
	constructor(
		public x: number,
		public y: number,
	) {}
	toLogical(scaleFactor: number): LogicalPosition {
		return new LogicalPosition(this.x / scaleFactor, this.y / scaleFactor);
	}
	toPhysical(_scaleFactor: number): PhysicalPosition {
		return this;
	}
	toJSON(): { x: number; y: number } {
		return { x: this.x, y: this.y };
	}
}

export class LogicalSize {
	constructor(
		public width: number,
		public height: number,
	) {}
	toPhysical(scaleFactor: number): PhysicalSize {
		return new PhysicalSize(
			Math.round(this.width * scaleFactor),
			Math.round(this.height * scaleFactor),
		);
	}
	toLogical(_scaleFactor: number): LogicalSize {
		return this;
	}
	toJSON(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}
}

export class PhysicalSize {
	constructor(
		public width: number,
		public height: number,
	) {}
	toLogical(scaleFactor: number): LogicalSize {
		return new LogicalSize(this.width / scaleFactor, this.height / scaleFactor);
	}
	toPhysical(_scaleFactor: number): PhysicalSize {
		return this;
	}
	toJSON(): { width: number; height: number } {
		return { width: this.width, height: this.height };
	}
}

export type Position = LogicalPosition | PhysicalPosition;
export type Size = LogicalSize | PhysicalSize;
