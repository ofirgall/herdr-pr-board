// The other pure layer: groups in, terminal lines out. No I/O and no clock (the
// caller passes `now`), so every width, truncation and colour rule is tested
// offline.
//
// paint, width, clip, link, hitTargets and cluster are herdr-pr-tracker's, so
// the two widgets draw a pull request's signals identically.

import {
  type CiState,
  type GroupSummary,
  headline,
  LOUD,
  type PrRow,
  type RepoGroup,
  type ReviewDecision,
  type Signal,
  summarize,
} from "./model.ts";
import { CONFLICT, DRAFT, ELLIPSIS, QUEUED, RULE } from "./glyphs.ts";

const ESC = "\x1b";
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
/** Normal intensity: ends bold and dim and nothing else, so closing one never
 * drops the colour the run sits inside. */
const NORMAL = `${ESC}[22m`;

// Named ANSI-16 only, so the board follows the user's Herdr theme.
const FG = {
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  default: `${ESC}[39m`,
} as const;
type Colour = keyof typeof FG;

/** A clean pull request is deliberately uncoloured: if every row is coloured,
 * colour says nothing. */
export const SIGNAL_COLOUR: Record<Signal, Colour> = {
  conflict: "red",
  "changes-requested": "red",
  "checks-failed": "red",
  unresolved: "yellow",
  "review-required": "magenta",
  "checks-pending": "blue",
  approved: "green",
  queued: "blue",
  clean: "default",
};

const CI_GLYPH: Record<CiState, string> = { pass: "✓", fail: "✗", pending: "●", none: " " };
const REVIEW_GLYPH: Record<Exclude<ReviewDecision, null>, string> = {
  APPROVED: "✓",
  CHANGES_REQUESTED: "✗",
  REVIEW_REQUIRED: "◆",
};

/** Columns before the author: the draft/queued marker and a space. */
export const LEAD_WIDTH = 2;
/** Widest the author column grows; longer logins are clipped. */
export const AUTHOR_MAX = 12;
/** A title narrower than this is dropped before the cluster is. */
const MIN_TITLE = 8;

export interface RenderOpts {
  cols: number;
  rows: number;
  /** Milliseconds since the epoch, supplied so rendering stays pure. */
  now: number;
  /** When the displayed data was fetched; null before the first success. */
  fetchedAt: number | null;
  /** Why the last refresh failed, if it did. */
  error?: string | null;
  colour: boolean;
  /** Prefix headings with the owner. */
  showOwner: boolean;
  /** Pull requests the search matched beyond the ones fetched. */
  omitted?: number;
  /** The signed-in login, drawn as "you". */
  viewer?: string;
  /** A standing configuration problem, drawn under the board. */
  notice?: string | null;
  /** Nothing is configured: the board explains how to configure it. */
  unconfigured?: boolean;
}

function paint(text: string, colour: Colour, on: boolean): string {
  if (!on || colour === "default") return text;
  return `${FG[colour]}${text}${FG.default}`;
}

function dim(text: string, on: boolean): string {
  return on ? `${DIM}${text}${NORMAL}` : text;
}

function bold(text: string, on: boolean): string {
  return on ? `${BOLD}${text}${NORMAL}` : text;
}

/** Visible columns: code points, with SGR runs and OSC 8 wrappers counted as
 * zero. Double-width CJK still counts as one, a known limitation. */
export function width(s: string): number {
  const bare = s
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")
    .replace(/︎/g, "");
  return [...bare].length;
}

function clip(s: string, max: number): string {
  if (max <= 0) return "";
  const cp = [...s];
  if (cp.length <= max) return s;
  if (max === 1) return ELLIPSIS;
  return cp.slice(0, max - 1).join("") + ELLIPSIS;
}

/** OSC 8 hyperlink. The board claims the mouse, so a click is located with
 * `hitTargets` and opened by the board itself; the escape is what marks a span
 * as clickable. */
export function link(url: string, text: string, on: boolean): string {
  if (!on || !url) return text;
  return `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
}

/** A clickable span of a painted frame. Rows and columns are 1-based, matching
 * mouse reports. */
export interface HitTarget {
  row: number;
  from: number;
  to: number;
  url: string;
}

/** Where the links are in a rendered frame. Derived from the painted lines, so
 * whatever is hyperlinked is clickable by construction. */
export function hitTargets(lines: string[]): HitTarget[] {
  const out: HitTarget[] = [];
  const OPEN = `${ESC}]8;;`;
  const ST = `${ESC}\\`;
  lines.forEach((line, i) => {
    let col = 1;
    let url: string | null = null;
    let from = 1;
    let j = 0;
    while (j < line.length) {
      if (line[j] !== ESC) {
        const next = line.indexOf(ESC, j);
        const chunk = next === -1 ? line.slice(j) : line.slice(j, next);
        col += width(chunk);
        j += chunk.length;
        continue;
      }
      if (line.startsWith(OPEN, j)) {
        const end = line.indexOf(ST, j);
        if (end === -1) break;
        const href = line.slice(j + OPEN.length, end);
        if (href) {
          url = href;
          from = col;
        } else if (url) {
          if (col > from) out.push({ row: i + 1, from, to: col - 1, url });
          url = null;
        }
        j = end + ST.length;
        continue;
      }
      const sgr = /^\x1b\[[0-9;]*m/.exec(line.slice(j));
      j += sgr ? sgr[0].length : 1;
    }
    if (url && col > from) out.push({ row: i + 1, from, to: col - 1, url });
  });
  return out;
}

export function hitAt(targets: HitTarget[], row: number, col: number): HitTarget | null {
  return targets.find((t) => t.row === row && col >= t.from && col <= t.to) ?? null;
}

/** The right-hand status cluster: conflict, review, unresolved threads, CI.
 * Fixed width so it aligns down the board. */
export const CLUSTER_WIDTH = 9;

function cluster(row: PrRow, colour: boolean): string {
  const hasHuman = row.unresolvedHuman > 0;
  const hasBot = row.unresolvedBot > 0;
  const count = hasHuman ? row.unresolvedHuman : row.unresolvedBot;
  const flag = hasHuman || hasBot
    ? `${hasHuman ? "⚑" : "⚐"}${row.unresolvedCapped ? "99+" : String(count)}`
    : "";
  const flagCell = flag.padEnd(4, " ");
  const reviewCell = row.review ? REVIEW_GLYPH[row.review] : " ";
  const ciCell = CI_GLYPH[row.ci];
  const conflictCell = row.conflict ? CONFLICT : " ";
  if (!colour) return `${conflictCell} ${reviewCell} ${flagCell}${ciCell}`;

  const reviewColour: Colour = row.review === "APPROVED"
    ? "green"
    : row.review === "CHANGES_REQUESTED"
    ? "red"
    : row.review === "REVIEW_REQUIRED"
    ? "magenta"
    : "default";
  const ciColour: Colour = row.ci === "pass"
    ? "green"
    : row.ci === "fail"
    ? "red"
    : row.ci === "pending"
    ? "blue"
    : "default";
  return `${paint(conflictCell, row.conflict ? "red" : "default", true)} ` +
    `${paint(reviewCell, reviewColour, true)} ` +
    `${flag ? paint(flagCell, hasHuman ? "yellow" : "blue", true) : flagCell}` +
    `${paint(ciCell, ciColour, true)}`;
}

/** Frames for the pre-first-fetch spinner, one per one-second repaint. */
export const SPINNER = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];

export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length]!;
}

export function relativeAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The author as drawn: "you" for the viewer. */
export function authorLabel(row: PrRow, viewer = ""): string {
  if (viewer && row.author.toLowerCase() === viewer.toLowerCase()) return "you";
  return row.author || "ghost";
}

/**
 * The top line: how many pull requests are open, how many are stuck, and how
 * old the data is. A failed refresh replaces the age, in red, because stale
 * data that does not say so is worse than none.
 */
export function header(groups: readonly RepoGroup[], o: RenderOpts): string {
  const rows = groups.flatMap((g) => g.rows);
  const total = rows.length + (o.omitted ?? 0);
  const stuck = rows.filter((r) => !r.isDraft && LOUD.includes(headline(r))).length;
  const left = o.fetchedAt == null && !o.error
    ? `${spinner(o.now)} loading`
    : `${total} open${stuck > 0 ? ` · ${stuck} stuck` : ""}`;
  const right = o.error
    ? o.error
    : o.fetchedAt == null
    ? ""
    : relativeAge(o.now - o.fetchedAt);
  const leftPainted = stuck > 0 && o.fetchedAt != null
    ? `${total} open · ${bold(paint(`${stuck} stuck`, "red", o.colour), o.colour)}`
    : left;
  const gap = o.cols - width(left) - width(right);
  if (gap < 1) return clip(left, o.cols);
  const rightPainted = o.error ? paint(right, "red", o.colour) : dim(right, o.colour);
  return `${leftPainted}${" ".repeat(gap)}${rightPainted}`;
}

/** A heading's counts, plain and painted: `4 · 2✗ 1◆ 1✓ +2◌`. Zero counts are
 * left out; a group with nothing open says so. */
function counts(s: GroupSummary, colour: boolean): { plain: string; painted: string } {
  if (s.open === 0 && s.drafts === 0) {
    return { plain: "none open", painted: dim("none open", colour) };
  }
  const parts: Array<[string, Colour, boolean]> = [];
  if (s.stuck > 0) parts.push([`${s.stuck}✗`, "red", true]);
  if (s.review > 0) parts.push([`${s.review}◆`, "magenta", false]);
  if (s.approved > 0) parts.push([`${s.approved}✓`, "green", false]);
  const plainParts = parts.map(([t]) => t);
  const paintedParts = parts.map(([t, c, loud]) => {
    const p = paint(t, c, colour);
    return loud ? bold(p, colour) : p;
  });
  if (s.drafts > 0) {
    plainParts.push(`+${s.drafts}${DRAFT}`);
    paintedParts.push(dim(`+${s.drafts}${DRAFT}`, colour));
  }
  const lead = String(s.open);
  return {
    plain: [lead, ...(plainParts.length ? ["·", ...plainParts] : [])].join(" "),
    painted: [bold(lead, colour), ...(paintedParts.length ? [dim("·", colour), ...paintedParts] : [])]
      .join(" "),
  };
}

export function repoUrl(g: RepoGroup): string {
  return `https://github.com/${g.owner}/${g.repo}/pulls`;
}

/** A repository heading: the name (a link to its pull requests), a dim rule to
 * the counts, and the counts flush right. */
export function repoHeader(g: RepoGroup, o: RenderOpts): string {
  const name = `${o.showOwner ? `${g.owner}/` : ""}${g.repo}`;
  const c = counts(summarize(g.rows), o.colour);
  const room = o.cols - width(c.plain) - 2;
  if (room < Math.min(width(name), 6)) {
    return link(repoUrl(g), bold(clip(name, o.cols), o.colour), o.colour);
  }
  const shown = clip(name, room - 1);
  const rule = o.cols - width(shown) - width(c.plain) - 2;
  return `${link(repoUrl(g), bold(shown, o.colour), o.colour)} ` +
    `${dim(RULE.repeat(Math.max(1, rule)), o.colour)} ${c.painted}`;
}

/**
 * One pull request on one line: marker, author, `#N title` (a link), cluster.
 * The line is coloured by the headline signal; a draft is dimmed throughout.
 * A narrowing board sheds the title first, then the author, never the cluster.
 */
export function prLine(row: PrRow, authorWidth: number, o: RenderOpts): string {
  const marker = row.isQueued ? QUEUED : row.isDraft ? DRAFT : " ";
  const sig = headline(row);
  const colourOf = SIGNAL_COLOUR[sig];
  const loud = LOUD.includes(sig);

  const num = `#${row.number}`;
  let avail = o.cols - LEAD_WIDTH - CLUSTER_WIDTH - 1;
  let author = clip(authorLabel(row, o.viewer), authorWidth).padEnd(authorWidth, " ");
  if (avail - authorWidth - 1 < num.length + 1 + MIN_TITLE) author = "";
  if (author) avail -= authorWidth + 1;
  const titleRoom = avail - num.length - 1;
  const title = titleRoom >= 1 ? clip(row.title, titleRoom) : "";
  const body = title ? `${num} ${title}` : clip(num, Math.max(0, avail));
  const pad = " ".repeat(Math.max(0, avail - width(body)));

  // A draft is not asking for anything yet: its number and title are dimmed
  // rather than coloured, while the cluster keeps its colours.
  let bodyPainted = row.isDraft ? dim(body, o.colour) : paint(body, colourOf, o.colour);
  if (loud && !row.isDraft) bodyPainted = bold(bodyPainted, o.colour);
  const authorPainted = author
    ? (author.trimEnd() === "you" ? paint(author, "default", o.colour) : dim(author, o.colour)) + " "
    : "";
  return `${dim(marker, o.colour)} ${authorPainted}${link(row.url, bodyPainted, o.colour)}${pad} ` +
    cluster(row, o.colour);
}

/**
 * Split a row budget across groups. Every heading is always shown; rows are
 * handed out one per group per round, so one busy repository cannot push the
 * others off the board. A group that loses rows gets a `+N more` line, paid
 * for out of its share.
 */
export function allocate(groups: readonly RepoGroup[], budget: number): number[] {
  const shown = groups.map(() => 0);
  // Headings, plus a blank line between groups.
  let left = budget - groups.length - Math.max(0, groups.length - 1);
  const more = (i: number) => shown[i]! < groups[i]!.rows.length;
  // Reserve the `+N more` line for every group that will not fit whole, which
  // is decided after the round-robin; iterate until stable.
  for (let pass = 0; pass < 2; pass++) {
    shown.fill(0);
    let room = left;
    let progress = true;
    while (room > 0 && progress) {
      progress = false;
      for (let i = 0; i < groups.length && room > 0; i++) {
        if (!more(i)) continue;
        shown[i]!++;
        room--;
        progress = true;
      }
    }
    const truncated = groups.filter((g, i) => shown[i]! < g.rows.length).length;
    if (pass === 0) left -= truncated;
  }
  return shown;
}

/** The hint drawn when no repositories are configured. */
export const UNCONFIGURED = [
  "No repositories configured.",
  "Set REPOS in the plugin config,",
  "e.g. REPOS=\"owner/repo owner/\"",
];

/** The whole board. */
export function render(groups: readonly RepoGroup[], o: RenderOpts): string[] {
  const out: string[] = [header(groups, o)];
  if (o.rows > 2) out.push("");
  const notice = o.notice
    ? paint("⚠", "yellow", o.colour) + dim(` ${clip(o.notice, Math.max(0, o.cols - 3))}`, o.colour)
    : null;
  const budget = Math.max(0, o.rows - out.length - (notice ? 1 : 0));

  if (o.unconfigured) {
    for (const l of UNCONFIGURED) out.push(dim(clip(l, o.cols), o.colour));
    if (notice) out.push(notice);
    return out.slice(0, o.rows);
  }

  const all = groups.flatMap((g) => g.rows);
  const authorWidth = Math.min(
    AUTHOR_MAX,
    Math.max(0, ...all.map((r) => width(authorLabel(r, o.viewer)))),
  );
  const shown = allocate(groups, budget);
  groups.forEach((g, i) => {
    if (i > 0) out.push("");
    out.push(repoHeader(g, o));
    for (const row of g.rows.slice(0, shown[i])) out.push(prLine(row, authorWidth, o));
    const hidden = g.rows.length - shown[i]!;
    if (hidden > 0) {
      out.push(" ".repeat(LEAD_WIDTH) + dim(`${ELLIPSIS} +${hidden} more`, o.colour));
    }
  });
  if (all.length === 0 && o.fetchedAt != null && groups.length === 0) {
    out.push(paint("✓", "green", o.colour) + dim(" all clear", o.colour));
  }
  if (notice) out.push(notice);
  return out.slice(0, o.rows);
}
