export interface RoutesOptions {
  /** Routes the desktop app leaves out, by route id: `/admin` is that route, `/admin/**` that route and everything under it. Ids keep their (groups). */
  exclude?: string[];
}
export function planRoutes(routes: string, side: "web" | "desktop", exclude?: string[]): Map<string, string> | null;
export function writeRoutes(out: string, files: Map<string, string>): void;
export function routesOverlay(side: "web" | "desktop", options?: RoutesOptions): { name: string; [hook: string]: any };
/** SvelteKit's version for the project at `root`, from node_modules. */
export function kitVersion(root: string): string | undefined;
/** What's wrong with what kitop reads of SvelteKit's options (`api.options` on its setup plugin), null when nothing. */
export function kitOptionsProblem(plugins: unknown[]): string | null;
/** SvelteKit's options, from the Vite config's plugins. Throws, naming the SvelteKit version, when they aren't there. */
export function kitOptions(plugins: unknown, root: string): Promise<Record<string, any>>;
export function flatPlugins(list: unknown): Promise<any[]>;
