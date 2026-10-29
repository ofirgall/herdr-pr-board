// The pure layer: a GitHub GraphQL response in, repository groups out. Nothing
// here touches gh, herdr, the filesystem or the clock.
//
// The signal rules (check rollup, review derivation, precedence) are
// herdr-pr-tracker's, so a pull request reads the same on both widgets.

import type { RepoEntry } from "./config.ts";

/** `null` means nobody has reviewed and none is required, which differs from a
 * review being required and not yet given. */
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** `none` means no checks reported, which is not the same as passing. */
export type CiState = "pass" | "fail" | "pending" | "none";

export type Signal =
  | "conflict"
  | "changes-requested"
  | "checks-failed"
  | "unresolved"
  | "review-required"
  | "checks-pending"
  | "approved"
  | "queued"
  | "clean";

/** Loudest first. A row's colour is the first signal it carries. */
export const PRECEDENCE: Signal[] = [
  "conflict",
  "changes-requested",
  "checks-failed",
  "unresolved",
  "review-required",
  "checks-pending",
  "approved",
  "queued",
  "clean",
];

/** The signals that mean the pull request is stuck until its author acts. They
 * are the top of PRECEDENCE, so a row carrying one also has it as headline. */
export const LOUD: Signal[] = [
  "conflict",
  "changes-requested",
  "checks-failed",
  "unresolved",
];

export interface PrRow {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  review: ReviewDecision;
  ci: CiState;
  /** Only `CONFLICTING` counts; GitHub's lazily computed `UNKNOWN` does not. */
  conflict: boolean;
  /** Unresolved review threads whose last comment is by a human other than
   * the viewer. */
  unresolvedHuman: number;
  /** The same, last commented by a bot. */
  unresolvedBot: number;
  /** The thread page hit its cap, so the counts are floors. */
  unresolvedCapped: boolean;
  isQueued: boolean;
}

export interface PrList {
  rows: PrRow[];
  /** Pull requests the search matched beyond the ones fetched. */
  omitted: number;
}

// --- check rollup -----------------------------------------------------------

// CANCELLED is not a failure: it is almost always a run you stopped or one a
// newer push replaced.
const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "ERROR"]);
const IGNORED = new Set(["SKIPPED", "NEUTRAL", "CANCELLED", "STALE"]);

interface RawContext {
  __typename?: string;
  conclusion?: string | null;
  status?: string | null;
  state?: string | null;
}

/** Collapse per-check results into one state, worst news first. */
export function rollupChecks(contexts: RawContext[]): CiState {
  if (contexts.length === 0) return "none";
  let sawFail = false;
  let sawPending = false;
  let sawSignal = false;
  for (const c of contexts) {
    // A running CheckRun has a null conclusion; a StatusContext uses `state`
    // for both outcome and pending.
    const outcome = c.conclusion ?? c.state ?? null;
    const running = (c.status != null && c.status !== "COMPLETED") ||
      outcome === "PENDING" || outcome === "EXPECTED" || outcome === null;
    if (running) {
      sawPending = true;
      sawSignal = true;
      continue;
    }
    if (IGNORED.has(outcome)) continue;
    sawSignal = true;
    if (FAILING.has(outcome)) sawFail = true;
  }
  if (sawFail) return "fail";
  if (sawPending) return "pending";
  return sawSignal ? "pass" : "none";
}

// --- signals ----------------------------------------------------------------

/** Every signal a row carries, loudest first. Never empty. */
export function signalsFor(row: PrRow): Signal[] {
  if (row.isQueued) return ["queued"];
  const out: Signal[] = [];
  if (row.conflict) out.push("conflict");
  if (row.review === "CHANGES_REQUESTED") out.push("changes-requested");
  if (row.ci === "fail") out.push("checks-failed");
  if (row.unresolvedHuman > 0 || row.unresolvedBot > 0) out.push("unresolved");
  if (row.review === "REVIEW_REQUIRED") out.push("review-required");
  if (row.ci === "pending") out.push("checks-pending");
  if (row.review === "APPROVED") out.push("approved");
  if (out.length === 0) out.push("clean");
  return out.sort((a, b) => PRECEDENCE.indexOf(a) - PRECEDENCE.indexOf(b));
}

export function headline(row: PrRow): Signal {
  return signalsFor(row)[0]!;
}

// --- parsing ----------------------------------------------------------------

interface RawNode {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  createdAt?: string;
  mergeable?: string | null;
  headRefName?: string;
  reviewDecision?: string | null;
  reviewRequests?: { totalCount?: number } | null;
  latestOpinionatedReviews?: { nodes?: Array<{ state?: string } | null> | null } | null;
  mergeQueueEntry?: { state?: string } | null;
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } };
  reviewThreads?: {
    totalCount?: number;
    nodes?: Array<{
      isResolved?: boolean;
      comments?: {
        nodes?: Array<{ author?: { __typename?: string; login?: string } | null } | null> | null;
      } | null;
    } | null> | null;
  };
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: { contexts?: { nodes?: RawContext[] | null } | null } | null;
      };
    } | null> | null;
  };
}

const REVIEW_VALUES = new Set(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);

/** `reviewDecision` where GitHub gives one, otherwise derived from the latest
 * opinionated reviews the same way GitHub would: changes requested beats an
 * approval, and an approval beats an outstanding request. */
function reviewOf(n: RawNode): ReviewDecision {
  const given = n.reviewDecision;
  if (REVIEW_VALUES.has(given as string)) return given as ReviewDecision;
  const states = (n.latestOpinionatedReviews?.nodes ?? []).map((r) => r?.state);
  if (states.includes("CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  if (states.includes("APPROVED")) return "APPROVED";
  if ((n.reviewRequests?.totalCount ?? 0) > 0) return "REVIEW_REQUIRED";
  return null;
}

/** `viewer` is the signed-in login; threads the viewer answered last are not
 * counted as unresolved. Empty when unknown, which counts every thread. */
function toRow(n: RawNode, threadCap: number, viewer: string): PrRow {
  const threads = n.reviewThreads?.nodes ?? [];
  let unresolvedHuman = 0;
  let unresolvedBot = 0;
  for (const t of threads) {
    if (!t || t.isResolved !== false) continue;
    const last = t.comments?.nodes?.[0]?.author;
    if (viewer && last?.login === viewer) continue;
    if (last?.__typename === "Bot") unresolvedBot++;
    else unresolvedHuman++;
  }
  const total = n.reviewThreads?.totalCount ?? threads.length;
  const contexts = n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return {
    owner: n.repository?.owner?.login ?? "",
    repo: n.repository?.name ?? "",
    number: n.number!,
    title: (n.title ?? "").trim(),
    url: n.url ?? "",
    branch: n.headRefName ?? "",
    author: n.author?.login ?? "",
    isDraft: n.isDraft === true,
    createdAt: n.createdAt ?? "",
    review: reviewOf(n),
    ci: rollupChecks(contexts ?? []),
    conflict: n.mergeable === "CONFLICTING",
    unresolvedHuman,
    unresolvedBot,
    unresolvedCapped: total > threadCap && threads.length >= threadCap,
    isQueued: n.mergeQueueEntry != null,
  };
}

/** `search(type: ISSUE)` can return issues; drop anything without a number. */
function nodesOf(result: unknown): RawNode[] {
  const nodes = (result as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n: RawNode) => n && typeof n.number === "number")
    : [];
}

/** A search response to rows, newest first: on a team board the newest pull
 * requests are the ones nobody has looked at yet. */
export function parseBoard(payload: unknown, threadCap = 100, viewer = ""): PrList {
  const search = (payload as { data?: { search?: unknown } })?.data?.search ?? {};
  const rows = nodesOf(search)
    .map((n) => toRow(n, threadCap, viewer))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const issueCount = (search as { issueCount?: unknown }).issueCount;
  const total = typeof issueCount === "number" ? issueCount : rows.length;
  return { rows, omitted: Math.max(0, total - rows.length) };
}

// --- grouping -----------------------------------------------------------------

/** One repository on the board: its heading and its pull requests. */
export interface RepoGroup {
  owner: string;
  repo: string;
  rows: PrRow[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Rows to groups, in configured order.
 *
 * A configured repository always gets a group, even with nothing open, so the
 * board says "nothing open" rather than leaving it out. An owner entry adds a
 * group for each of its repositories that has open pull requests and is not
 * already configured on its own, sorted by name. Rows matching no entry (the
 * search never returns one, but a stale cache might) are dropped.
 */
export function groupRows(rows: readonly PrRow[], entries: readonly RepoEntry[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const index = new Map<string, RepoGroup>();
  const add = (owner: string, repo: string): RepoGroup => {
    const key = `${owner}/${repo}`.toLowerCase();
    let g = index.get(key);
    if (!g) {
      g = { owner, repo, rows: [] };
      index.set(key, g);
      groups.push(g);
    }
    return g;
  };
  const explicit = entries.filter((e) => e.kind === "repo");
  for (const e of entries) {
    if (e.kind === "repo") {
      add(e.owner, e.name);
      continue;
    }
    const names = [
      ...new Set(
        rows
          .filter((r) => same(r.owner, e.owner))
          .filter((r) => !explicit.some((x) => same(x.owner, r.owner) && same(x.name, r.repo)))
          .map((r) => r.repo),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const owner = rows.find((r) => same(r.owner, e.owner))?.owner ?? e.owner;
    for (const name of names) add(owner, name);
  }
  for (const row of rows) {
    const g = index.get(`${row.owner}/${row.repo}`.toLowerCase());
    if (g) {
      // A configured spelling may differ in case from GitHub's; show GitHub's.
      g.owner = row.owner;
      g.repo = row.repo;
      g.rows.push(row);
    }
  }
  return groups;
}

/** What a repository heading counts. Drafts are counted apart: they are not
 * asking anyone for anything yet. */
export interface GroupSummary {
  open: number;
  drafts: number;
  /** Stuck until the author acts: a LOUD headline. */
  stuck: number;
  /** Waiting on a reviewer. */
  review: number;
  /** Approved and not stuck. */
  approved: number;
}

export function summarize(rows: readonly PrRow[]): GroupSummary {
  const s: GroupSummary = { open: 0, drafts: 0, stuck: 0, review: 0, approved: 0 };
  for (const r of rows) {
    if (r.isDraft) {
      s.drafts++;
      continue;
    }
    s.open++;
    const h = headline(r);
    if (LOUD.includes(h)) s.stuck++;
    else if (r.review === "APPROVED") s.approved++;
    else if (r.review === "REVIEW_REQUIRED" || r.review === null) s.review++;
  }
  return s;
}

/** Whether repository headings need their owner to be unambiguous. */
export function needsOwner(groups: readonly RepoGroup[]): boolean {
  return new Set(groups.map((g) => g.owner.toLowerCase())).size > 1;
}
