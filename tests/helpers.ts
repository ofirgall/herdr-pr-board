// Synthetic rows and search payloads, so each test states only what it is about.

import type { PrRow } from "../src/model.ts";

export function row(over: Partial<PrRow> = {}): PrRow {
  return {
    owner: "acme",
    repo: "web",
    number: 1,
    title: "A pull request",
    url: "https://github.com/acme/web/pull/1",
    branch: "b1",
    author: "alice",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    review: null,
    ci: "none",
    conflict: false,
    unresolvedHuman: 0,
    unresolvedBot: 0,
    unresolvedCapped: false,
    isQueued: false,
    ...over,
  };
}

/** A raw search node, the shape GitHub returns. */
export function node(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 1,
    title: "A pull request",
    url: "https://github.com/acme/web/pull/1",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00Z",
    headRefName: "b1",
    reviewDecision: null,
    author: { login: "alice" },
    repository: { name: "web", owner: { login: "acme" } },
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: { nodes: [] },
    ...over,
  };
}

export const payload = (nodes: unknown[], issueCount = nodes.length) => ({
  data: { search: { issueCount, nodes } },
});
