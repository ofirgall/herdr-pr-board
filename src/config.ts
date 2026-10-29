// The board's configuration: which repositories to watch, and a few knobs.
// Pure apart from `loadConfig`, so the parsing rules are tested offline.

import { join } from "node:path";

/** One configured source of pull requests. A repository is always shown, even
 * with nothing open; an owner expands to whichever of its repositories have
 * open pull requests. */
export type RepoEntry =
  | { kind: "repo"; owner: string; name: string }
  | { kind: "owner"; owner: string };

export interface Config {
  repos: RepoEntry[];
  /** `REPOS` entries the parser refused, verbatim, for the board to report. */
  reposDropped: string[];
  pollSeconds: number;
  /** Most pull requests fetched in one request (GitHub's search page cap is 100). */
  maxPrs: number;
  colour: boolean;
  /** "auto" prefixes repository headings with the owner only when the board
   * spans more than one owner. */
  showOwner: "auto" | "always" | "never";
}

export const DEFAULTS: Config = {
  repos: [],
  reposDropped: [],
  pollSeconds: 60,
  maxPrs: 100,
  colour: true,
  showOwner: "auto",
};

// A GitHub login: alphanumerics and hyphens, not starting or ending with a
// hyphen, at most 39 characters. A repository name also allows dots and
// underscores, but is never `.` or `..`.
const VALID_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const VALID_REPO_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/**
 * Split `REPOS` into entries. Whitespace and commas both separate.
 *
 * `owner/name` is one repository and `owner/` is every repository under an
 * owner. A bare `name` is refused rather than guessed at: GitHub answers a
 * malformed `repo:` qualifier with no error, so a guess that was wrong would
 * silently watch nothing. Duplicates collapse case-insensitively, the way
 * GitHub's qualifiers compare.
 */
export function parseRepoList(raw: string): { entries: RepoEntry[]; dropped: string[] } {
  const entries: RepoEntry[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(/[\s,]+/)) {
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const slash = token.indexOf("/");
    const owner = slash < 0 ? "" : token.slice(0, slash);
    const name = slash < 0 ? "" : token.slice(slash + 1);
    const ok = slash >= 0 && VALID_OWNER.test(owner) &&
      (name === "" || VALID_REPO_NAME.test(name));
    if (!ok) {
      dropped.push(token);
      continue;
    }
    entries.push(name === "" ? { kind: "owner", owner } : { kind: "repo", owner, name });
  }
  return { entries, dropped };
}

/** The pane-width sentence for refused `REPOS` entries, or null. */
export function reposNotice(dropped: readonly string[]): string | null {
  if (dropped.length === 0) return null;
  return `${dropped.length} bad REPOS ${dropped.length === 1 ? "entry" : "entries"}`;
}

/** The stderr sentence naming them, for a board run by hand. */
export function reposWarning(dropped: readonly string[]): string | null {
  if (dropped.length === 0) return null;
  return `dropped REPOS ${dropped.length === 1 ? "entry" : "entries"} ` +
    `${dropped.join(", ")}: each needs an owner, as "owner/name" or "owner/"`;
}

/** Parse `KEY=value` lines; `#` comments a line out and a matched pair of
 * quotes around a value is stripped. */
export function parseConfig(text: string): Partial<Config> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) value = value.slice(1, -1);
    out[key] = value;
  }

  const cfg: Partial<Config> = {};
  const int = (v: string | undefined, min: number) => {
    if (v == null) return undefined;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= min ? n : undefined;
  };
  if (out.REPOS != null) {
    const { entries, dropped } = parseRepoList(out.REPOS);
    cfg.repos = entries;
    cfg.reposDropped = dropped;
  }
  const poll = int(out.POLL_SECONDS, 5);
  if (poll != null) cfg.pollSeconds = poll;
  const max = int(out.MAX_PRS, 1);
  if (max != null) cfg.maxPrs = Math.min(max, 100);
  if (out.SHOW_OWNER === "always" || out.SHOW_OWNER === "never" || out.SHOW_OWNER === "auto") {
    cfg.showOwner = out.SHOW_OWNER;
  }
  const colour = out.COLOR ?? out.COLOUR;
  if (colour != null) {
    const v = colour.toLowerCase();
    cfg.colour = !(v === "0" || v === "off" || v === "false" || v === "no");
  }
  return cfg;
}

/** Read `config` from the plugin root, then from the plugin config dir, which
 * wins. */
export async function loadConfig(pluginRoot: string, configDir?: string): Promise<Config> {
  let cfg: Config = { ...DEFAULTS };
  for (const dir of [pluginRoot, configDir]) {
    if (!dir) continue;
    const file = Bun.file(join(dir, "config"));
    if (!(await file.exists())) continue;
    cfg = { ...cfg, ...parseConfig(await file.text()) };
  }
  return cfg;
}
