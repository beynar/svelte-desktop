// `kitop dev` and `kitop build`: what to run for the flags given.

export type Target = "macos" | "windows" | "linux";

const FLAGS: Record<string, Target> = { "--mac": "macos", "--windows": "windows", "--linux": "linux" };
const NAMES: Record<Target, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

export function hostTarget(platform: string = process.platform): Target {
  return platform === "win32" ? "windows" : platform === "linux" ? "linux" : "macos";
}

/** The Vite runs for a command: one per target, or one with none, for the website. The rest of the
 *  arguments go to Vite. Throws what can't be done from this machine. */
export function viteRuns(command: "dev" | "build", args: string[], platform: string = process.platform): { target: Target | null; args: string[] }[] {
  const targets = [...new Set(args.filter((a) => a in FLAGS).map((a) => FLAGS[a]!))];
  const rest = args.filter((a) => !(a in FLAGS));
  const host = hostTarget(platform);
  if (command === "dev") {
    if (targets.length > 1) throw new Error("kitop dev opens one window: give one of --mac, --windows, --linux");
    const target = targets[0];
    if (target && target !== host) throw new Error(`kitop dev --${target === "macos" ? "mac" : target} needs ${NAMES[target]}: a window only opens on its own OS, and this is ${NAMES[host]}. \`kitop build\` takes that flag from here${target === "macos" ? " only on a Mac" : ""}.`);
  } else if (targets.includes("macos") && host !== "macos") {
    throw new Error(`kitop build --mac needs a Mac: Apple's tools don't run on ${NAMES[host]}. Build it from macOS or in CI.`);
  }
  return (targets.length ? targets : [null]).map((target) => ({ target, args: rest }));
}
