import { expect, test } from "bun:test";
import { boardArgs, boardSearch } from "../src/query.ts";

test("one search ORs every configured repository and owner", () => {
  expect(boardSearch([
    { kind: "repo", owner: "acme", name: "web" },
    { kind: "owner", owner: "other" },
  ])).toBe("is:pr is:open archived:false repo:acme/web user:other");
});

test("nothing configured is no search, never an unqualified one", () => {
  expect(boardSearch([])).toBeNull();
  expect(boardArgs([], 100, 100)).toBeNull();
});

test("the arguments carry the query and its variables", () => {
  const args = boardArgs([{ kind: "repo", owner: "acme", name: "web" }], 50, 20)!;
  expect(args).toContain("prs=50");
  expect(args).toContain("threads=20");
  expect(args.find((a) => a.startsWith("q="))).toBe(
    "q=is:pr is:open archived:false repo:acme/web",
  );
});
