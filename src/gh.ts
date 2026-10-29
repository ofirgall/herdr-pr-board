// The only module that talks to GitHub. Everything it returns is plain data,
// so the model and render layers stay testable without a network or a token.

import type { RepoEntry } from "./config.ts";
import { parseBoard, type PrList } from "./model.ts";
import { boardArgs } from "./query.ts";

export type GhFailure = "auth" | "network" | "rate" | "other";

export class GhError extends Error {
  constructor(message: string, readonly kind: GhFailure) {
    super(message);
    this.name = "GhError";
  }
}

async function run(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // gh reaches for a pager and colours its output when it believes it has a
    // tty. The board *is* a tty, so say otherwise explicitly.
    env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1", CLICOLOR: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, out, err };
}

/** Map gh's stderr onto the few words the top line has room for. "offline"
 * versus "auth failed" is the difference between waiting and fixing. */
export function classify(err: string): GhError {
  const e = err.toLowerCase();
  if (
    e.includes("gh auth login") || e.includes("authentication") ||
    e.includes("credentials") || e.includes("401")
  ) return new GhError("auth failed", "auth");
  if (e.includes("rate limit") || e.includes("secondary rate") || e.includes("api rate")) {
    return new GhError("rate limited", "rate");
  }
  if (
    e.includes("dial tcp") || e.includes("no such host") ||
    e.includes("connection refused") || e.includes("network is unreachable") ||
    e.includes("timeout")
  ) return new GhError("offline", "network");
  if (e.includes("403")) return new GhError("forbidden", "rate");
  const first = err.trim().split("\n")[0] ?? "";
  return new GhError(first ? first.slice(0, 40) : "gh failed", "other");
}

/**
 * Fetch every open pull request across the configured repositories, in one
 * request. Empty when nothing is configured.
 *
 * `threads` caps reviewThreads per pull request; one at the cap reports its
 * unresolved count as a floor (`unresolvedCapped`).
 */
export async function fetchBoard(
  entries: readonly RepoEntry[],
  maxPrs: number,
  threads = 100,
  viewer = "",
): Promise<PrList> {
  const args = boardArgs(entries, maxPrs, threads);
  if (args == null) return { rows: [], omitted: 0 };
  const r = await run(["api", "graphql", ...args]);
  if (!r.ok) throw classify(r.err || r.out);

  let payload: unknown;
  try {
    payload = JSON.parse(r.out);
  } catch {
    throw new GhError("bad response", "other");
  }
  // GraphQL reports failures with HTTP 200 and an `errors` array. Partial data
  // alongside errors is still worth rendering; no data at all is a failure.
  const errors = (payload as { errors?: Array<{ message?: string }> })?.errors;
  const search = (payload as { data?: { search?: unknown } })?.data?.search;
  if (Array.isArray(errors) && errors.length > 0 && !search) {
    throw classify(errors.map((e) => e?.message ?? "").join(" "));
  }
  return parseBoard(payload, threads, viewer);
}

/** The authenticated user's login, or empty when unknown. */
export async function fetchViewer(): Promise<string> {
  const r = await run(["api", "graphql", "-f", "query={ viewer { login } }"]);
  if (!r.ok) return "";
  try {
    return (JSON.parse(r.out) as { data?: { viewer?: { login?: string } } })?.data?.viewer
      ?.login ?? "";
  } catch {
    return "";
  }
}
