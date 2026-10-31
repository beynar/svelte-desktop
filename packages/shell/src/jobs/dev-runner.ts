// `vite dev`: run src/jobs/<name>.ts directly with Bun (the packaged app runs a bundle).
import { runJob } from "./child.ts";

const file = process.argv[2];
if (!file) throw new Error("dev-runner: job file missing");
const mod = await import(file);
runJob(mod.default);
