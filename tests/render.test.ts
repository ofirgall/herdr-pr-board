import { describe, expect, test } from "bun:test";
import type { RepoGroup } from "../src/model.ts";
import {
  allocate,
  header,
  hitAt,
  hitTargets,
  prLine,
  render,
  type RenderOpts,
  repoHeader,
  UNCONFIGURED,
  width,
} from "../src/render.ts";
import { parseMouse } from "../src/mouse.ts";
import { row } from "./helpers.ts";

const NOW = Date.parse("2026-08-25T09:00:00Z");
const opts = (over: Partial<RenderOpts> = {}): RenderOpts => ({
  cols: 60,
  rows: 30,
  now: NOW,
  fetchedAt: NOW - 5_000,
  colour: false,
  showOwner: false,
  ...over,
});
const group = (repo: string, n: number, over = {}): RepoGroup => ({
  owner: "acme",
  repo,
  rows: Array.from({ length: n }, (_, i) =>
    row({ repo, number: i + 1, url: `https://github.com/acme/${repo}/pull/${i + 1}`, ...over })),
});

describe("header", () => {
  test("counts open and stuck, with the age flush right", () => {
    const line = header([group("web", 2, { ci: "fail" }), group("api", 1)], opts());
    expect(line.startsWith("3 open · 2 stuck")).toBe(true);
    expect(line.endsWith("5s ago")).toBe(true);
    expect(width(line)).toBe(60);
  });
  test("an error replaces the age", () => {
    expect(header([], opts({ error: "offline" })).endsWith("offline")).toBe(true);
  });
  test("before the first fetch it says it is loading", () => {
    expect(header([], opts({ fetchedAt: null }))).toContain("loading");
  });
});

describe("repoHeader", () => {
  test("names the repository and counts by state, flush right", () => {
    const g: RepoGroup = {
      owner: "acme",
      repo: "web",
      rows: [
        row({ ci: "fail" }),
        row({ review: "REVIEW_REQUIRED" }),
        row({ review: "APPROVED" }),
        row({ isDraft: true }),
      ],
    };
    const line = repoHeader(g, opts());
    expect(line.startsWith("web ─")).toBe(true);
    expect(line.endsWith("3 · 1✗ 1◆ 1✓ +1◌")).toBe(true);
    expect(width(line)).toBe(60);
  });
  test("an empty repository says none open", () => {
    expect(repoHeader(group("web", 0), opts()).endsWith("none open")).toBe(true);
  });
  test("the owner is shown when asked", () => {
    expect(repoHeader(group("web", 0), opts({ showOwner: true }))).toStartWith("acme/web ");
  });
});

describe("prLine", () => {
  test("is exactly the board width, with author, number and title", () => {
    const line = prLine(row({ number: 42, title: "Fix it" }), 5, opts());
    expect(width(line)).toBe(60);
    expect(line).toContain("alice #42 Fix it");
  });
  test("the viewer is drawn as you", () => {
    expect(prLine(row({ author: "me" }), 5, opts({ viewer: "Me" }))).toContain(" you ");
  });
  test("a long title is clipped, never the cluster", () => {
    const line = prLine(row({ title: "x".repeat(200), ci: "fail" }), 5, opts({ cols: 40 }));
    expect(width(line)).toBe(40);
    expect(line.endsWith("✗")).toBe(true);
  });
  test("a narrow board drops the author before the title", () => {
    const line = prLine(row({ number: 1, title: "Title" }), 12, opts({ cols: 30 }));
    expect(line).not.toContain("alice");
    expect(width(line)).toBe(30);
  });
});

describe("allocate", () => {
  test("everything fits when there is room", () => {
    expect(allocate([group("a", 2), group("b", 3)], 20)).toEqual([2, 3]);
  });
  test("rows go round-robin and a busy repository cannot starve the others", () => {
    // 2 headings + 1 gap + 2 `+N more` lines leave 3 rows.
    expect(allocate([group("a", 10), group("b", 10)], 8)).toEqual([2, 1]);
  });
  test("a small group that fits whole costs no `more` line", () => {
    // 2 headings + 1 gap + 1 `more` line leave 4: b takes its 1, a the rest.
    expect(allocate([group("a", 10), group("b", 1)], 8)).toEqual([3, 1]);
  });
});

describe("render", () => {
  test("never exceeds the board height and keeps every heading", () => {
    const groups = [group("a", 10), group("b", 10), group("c", 10)];
    const lines = render(groups, opts({ rows: 12 }));
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const name of ["a", "b", "c"]) {
      expect(lines.some((l) => l.startsWith(`${name} ─`))).toBe(true);
    }
    expect(lines.some((l) => l.includes("more"))).toBe(true);
  });
  test("every line is exactly as wide as the board or narrower", () => {
    for (const l of render([group("web", 3)], opts({ cols: 33 }))) {
      expect(width(l)).toBeLessThanOrEqual(33);
    }
  });
  test("nothing configured shows how to configure it", () => {
    expect(render([], opts({ unconfigured: true }))).toContain(UNCONFIGURED[0]!);
  });
  test("a notice sits on the last line", () => {
    const lines = render([group("a", 50)], opts({ rows: 10, notice: "1 bad REPOS entry" }));
    expect(lines.length).toBe(10);
    expect(lines.at(-1)).toContain("1 bad REPOS entry");
  });
});

describe("clicks", () => {
  test("a click on a pull request or a heading finds its link", () => {
    const lines = render([group("web", 1)], opts({ colour: true }));
    const targets = hitTargets(lines);
    const urls = targets.map((t) => t.url);
    expect(urls).toContain("https://github.com/acme/web/pulls");
    expect(urls).toContain("https://github.com/acme/web/pull/1");
    const pr = targets.find((t) => t.url.endsWith("/pull/1"))!;
    expect(hitAt(targets, pr.row, pr.from)?.url).toBe(pr.url);
    expect(hitAt(targets, pr.row, pr.to + 1)).toBeNull();
  });
  test("parseMouse decodes presses and keeps a split report", () => {
    const { events, rest } = parseMouse("\x1b[<0;12;3M\x1b[<0;1");
    expect(events.map((e) => [e.button, e.press, e.col, e.row])).toEqual([[0, true, 12, 3]]);
    expect(rest).toBe("\x1b[<0;1");
  });
  test("parseMouse drops wheel and motion reports", () => {
    expect(parseMouse("\x1b[<64;1;1M\x1b[<32;1;1M").events).toHaveLength(0);
  });
});
