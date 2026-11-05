// An update on its first launches: every launch counts, as early as possible, and the version is
// confirmed only once it has shown a page. A version that crashes before that, or never shows
// one, reaches the limit in rollbackIfNeeded() on a later launch: the previous one comes back.
import { createUpdater, type Updater } from "./index.ts";
import type { InitMessage } from "../types.ts";

/** How long a page stays up before its version counts as healthy. */
export const HEALTHY_AFTER_MS = 5000;

export const shellUpdater = (update: NonNullable<InitMessage["update"]>, version: string, identifier: string, quit?: () => unknown) =>
  createUpdater({ manifestUrl: update.manifestUrl, publicKey: update.publicKey, channel: update.channel, currentVersion: version, appName: identifier, ...(quit && { quit }) });

/** First thing at launch. True: the previous version was restored and is starting, this process leaves. */
export async function countUpdateLaunch(updater: Pick<Updater, "rollbackIfNeeded" | "restart">): Promise<boolean> {
  try {
    if (!(await updater.rollbackIfNeeded())) return false;
    console.error("[shell] this version didn't start healthily: restored the previous one");
    await updater.restart();
    return true;
  } catch (err) {
    console.error("[shell] updater startup:", err);
    return false;
  }
}

/** Confirms the running version: `HEALTHY_AFTER_MS` after a page is ready, or at a clean quit after one. */
export function confirmWhenHealthy(updater: Pick<Updater, "confirm">, delayMs = HEALTHY_AFTER_MS) {
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let confirmed: Promise<void> | undefined;
  const confirm = () =>
    (confirmed ??= updater.confirm().catch((err) => console.error("[shell] updater confirm:", err)));
  return {
    pageReady() {
      if (shown) return;
      shown = true;
      timer = setTimeout(confirm, delayMs);
    },
    async quitting() {
      clearTimeout(timer);
      if (shown) await confirm();
    },
  };
}
