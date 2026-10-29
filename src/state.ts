// The board is long-lived, so it holds the pull requests in memory. This module
// covers a restart: without a cached last-good result, a new board shows
// nothing for a whole poll interval, which reads as "nothing open".

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { PrRow } from "./model.ts";

export interface Snapshot {
  fetchedAt: number;
  /** The `REPOS` search the rows answer, so a config change never paints the
   * old repositories' rows under the new headings. */
  search: string;
  rows: PrRow[];
  omitted: number;
}

export function stateDir(): string {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ??
    join(
      process.env.HOME ?? ".",
      ".local/state/herdr/plugins",
      process.env.HERDR_PLUGIN_ID ?? "herdr-pr-board",
    )
  );
}

const snapshotPath = () => join(stateDir(), "snapshot.json");
const refreshPath = () => join(stateDir(), "refresh");

export async function readSnapshot(search: string): Promise<Snapshot | null> {
  try {
    const raw = await Bun.file(snapshotPath()).json();
    if (typeof raw?.fetchedAt !== "number" || !Array.isArray(raw?.rows)) return null;
    if (raw.search !== search) return null;
    return { fetchedAt: raw.fetchedAt, search, rows: raw.rows, omitted: raw.omitted ?? 0 };
  } catch {
    // A missing or half-written file is a cold start, not an error.
    return null;
  }
}

export async function writeSnapshot(s: Snapshot): Promise<void> {
  try {
    mkdirSync(stateDir(), { recursive: true });
    // Write-then-rename so a board killed mid-write cannot leave a truncated
    // file. Bun.write onto the destination truncates it in place, so the
    // atomic step comes from node:fs.
    const tmp = `${snapshotPath()}.tmp`;
    await Bun.write(tmp, JSON.stringify(s));
    renameSync(tmp, snapshotPath());
  } catch {
    // Caching is a convenience; failing to cache must never break the board.
  }
}

/** Ask a running board to fetch now. The board owns the poll loop, so the
 * refresh action leaves a marker rather than fetching itself. */
export async function requestRefresh(): Promise<void> {
  await Bun.write(refreshPath(), `${Date.now()}\n`);
}

/** Whether a refresh was requested, consuming the request. */
export async function takeRefresh(): Promise<boolean> {
  const f = Bun.file(refreshPath());
  if (!(await f.exists())) return false;
  await f.delete().catch(() => {});
  return true;
}
