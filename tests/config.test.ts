import { describe, expect, test } from "bun:test";
import { parseConfig, parseRepoList, reposNotice, reposWarning } from "../src/config.ts";

describe("parseRepoList", () => {
  test("reads repositories and owners, split by spaces or commas", () => {
    expect(parseRepoList("acme/web, acme/api\nother/").entries).toEqual([
      { kind: "repo", owner: "acme", name: "web" },
      { kind: "repo", owner: "acme", name: "api" },
      { kind: "owner", owner: "other" },
    ]);
  });

  test("refuses a bare name rather than guessing an owner", () => {
    const { entries, dropped } = parseRepoList("web acme/web");
    expect(entries).toHaveLength(1);
    expect(dropped).toEqual(["web"]);
  });

  test("refuses malformed owners and names", () => {
    expect(parseRepoList("-acme/web acme/.. a/b/c /web").dropped).toEqual([
      "-acme/web",
      "acme/..",
      "a/b/c",
      "/web",
    ]);
  });

  test("collapses duplicates case-insensitively", () => {
    expect(parseRepoList("acme/web ACME/Web").entries).toHaveLength(1);
  });
});

describe("parseConfig", () => {
  test("reads every knob, stripping quotes and comments", () => {
    const cfg = parseConfig(`
# a comment
REPOS="acme/web"
POLL_SECONDS=30
MAX_PRS=500
SHOW_OWNER=always
COLOR=off
`);
    expect(cfg.repos).toEqual([{ kind: "repo", owner: "acme", name: "web" }]);
    expect(cfg.pollSeconds).toBe(30);
    expect(cfg.maxPrs).toBe(100);
    expect(cfg.showOwner).toBe("always");
    expect(cfg.colour).toBe(false);
  });

  test("ignores a poll interval under five seconds and unknown SHOW_OWNER", () => {
    const cfg = parseConfig("POLL_SECONDS=1\nSHOW_OWNER=sometimes");
    expect(cfg.pollSeconds).toBeUndefined();
    expect(cfg.showOwner).toBeUndefined();
  });

  test("COLOUR is accepted as well as COLOR", () => {
    expect(parseConfig("COLOUR=no").colour).toBe(false);
  });
});

test("dropped entries are reported short in the board and in full on stderr", () => {
  expect(reposNotice([])).toBeNull();
  expect(reposNotice(["web", "api"])).toBe("2 bad REPOS entries");
  expect(reposWarning(["web"])).toContain("web");
});
