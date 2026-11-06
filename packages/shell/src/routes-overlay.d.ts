export interface RoutesOptions {
  /** Routes the desktop app leaves out, by route id: `/admin` is that route, `/admin/**` that route and everything under it. Ids keep their (groups). */
  exclude?: string[];
}
export function planRoutes(routes: string, side: "web" | "desktop", exclude?: string[]): Map<string, string> | null;
export function writeRoutes(out: string, files: Map<string, string>): void;
export function routesOverlay(side: "web" | "desktop", options?: RoutesOptions): { name: string; [hook: string]: any };
