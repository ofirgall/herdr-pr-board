import { describe, expect, test } from "bun:test";
import type { RepoEntry } from "../src/config.ts";
import { groupRows, headline, parseBoard, rollupChecks, summarize } from "../src/model.ts";
import { node, payload, row } from "./helpers.ts";

describe("rollupChecks", () => {
  test("worst news wins and cancelled is not a failure", () => {
    expect(rollupChecks([])).toBe("none");
    expect(rollupChecks([{ conclusion: "SUCCESS", status: "COMPLETED" }])).toBe("pass");
    expect(rollupChecks([{ conclusion: "CANCELLED", status: "COMPLETED" }])).toBe("none");
    expect(rollupChecks([
      { conclusion: "SUCCESS", status: "COMPLETED" },
      { conclusion: null, status: "IN_PROGRESS" },
    ])).toBe("pending");
    expect(rollupChecks([
      { conclusion: "FAILURE", status: "COMPLETED" },
      { state: "PENDING" },
    ])).toBe("fail");
  });
});

describe("headline", () => {
  test("conflict outranks everything but the merge queue", () => {
    expect(headline(row({ conflict: true, review: "APPROVED", ci: "fail" }))).toBe("conflict");
    expect(headline(row({ conflict: true, isQueued: true }))).toBe("queued");
  });
  test("a pull request with no signals is clean", () => {
    expect(headline(row())).toBe("clean");
  });
});

describe("parseBoard", () => {
  test("rows come newest first, with authors and omitted counts", () => {
    const list = parseBoard(payload([
      node({ number: 1, createdAt: "2026-01-01T00:00:00Z" }),
      node({ number: 2, createdAt: "2026-02-01T00:00:00Z", author: { login: "bob" } }),
      { title: "an issue with no number" },
    ], 5));
    expect(list.rows.map((r) => r.number)).toEqual([2, 1]);
    expect(list.rows[0]!.author).toBe("bob");
    expect(list.omitted).toBe(3);
  });

  test("derives review from opinionated reviews when there is no decision", () => {
    const [r] = parseBoard(payload([
      node({ latestOpinionatedReviews: { nodes: [{ state: "APPROVED" }] } }),
    ])).rows;
    expect(r!.review).toBe("APPROVED");
  });

  test("threads the viewer answered last are not unresolved", () => {
    const thread = (login: string, type = "User") => ({
      isResolved: false,
      comments: { nodes: [{ author: { __typename: type, login } }] },
    });
    const [r] = parseBoard(
      payload([node({
        reviewThreads: {
          totalCount: 3,
          nodes: [thread("me"), thread("bob"), thread("ci", "Bot")],
        },
      })]),
      100,
      "me",
    ).rows;
    expect([r!.unresolvedHuman, r!.unresolvedBot]).toEqual([1, 1]);
  });
});

describe("groupRows", () => {
  const web: RepoEntry = { kind: "repo", owner: "acme", name: "web" };
  const api: RepoEntry = { kind: "repo", owner: "acme", name: "api" };
  const other: RepoEntry = { kind: "owner", owner: "other" };

  test("configured repositories keep their order and show even when empty", () => {
    const groups = groupRows([row({ repo: "web" })], [api, web]);
    expect(groups.map((g) => [g.repo, g.rows.length])).toEqual([["api", 0], ["web", 1]]);
  });

  test("an owner expands to its repositories with open pull requests, sorted", () => {
    const groups = groupRows([
      row({ owner: "other", repo: "zeta" }),
      row({ owner: "other", repo: "alpha" }),
      row({ owner: "other", repo: "alpha", number: 2 }),
    ], [other]);
    expect(groups.map((g) => [g.repo, g.rows.length])).toEqual([["alpha", 2], ["zeta", 1]]);
  });

  test("a repository listed on its own is not repeated under its owner", () => {
    const groups = groupRows([row({ repo: "web" }), row({ repo: "docs" })], [
      { kind: "owner", owner: "acme" },
      web,
    ]);
    expect(groups.map((g) => g.repo)).toEqual(["docs", "web"]);
  });

  test("GitHub's spelling wins over the configured one", () => {
    const groups = groupRows([row({ owner: "Acme", repo: "Web" })], [web]);
    expect([groups[0]!.owner, groups[0]!.repo]).toEqual(["Acme", "Web"]);
  });

  test("rows matching nothing configured are dropped", () => {
    expect(groupRows([row({ repo: "elsewhere" })], [web])[0]!.rows).toHaveLength(0);
  });
});

test("summarize counts drafts apart and sorts the rest by who must act", () => {
  expect(summarize([
    row({ isDraft: true, ci: "fail" }),
    row({ ci: "fail" }),
    row({ review: "REVIEW_REQUIRED" }),
    row(),
    row({ review: "APPROVED" }),
    row({ review: "APPROVED", conflict: true }),
  ])).toEqual({ open: 5, drafts: 1, stuck: 2, review: 2, approved: 1 });
});
