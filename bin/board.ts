#!/usr/bin/env bun
// The board: a long-lived process owning one terminal, either a plugin pane or
// a herdr sidebar panel. Herdr has no background poll for plugins, so the poll
// loop lives here.

import { dirname } from "node:path";
import { loadConfig, reposNotice, reposWarning } from "../src/config.ts";
import { fetchBoard, fetchViewer, GhError } from "../src/gh.ts";
import { groupRows, needsOwner, type PrRow } from "../src/model.ts";
import { boardSearch } from "../src/query.ts";
import { type HitTarget, hitAt, hitTargets, render } from "../src/render.ts";
import { parseMouse } from "../src/mouse.ts";
import { openUrl } from "../src/open.ts";
import { readSnapshot, takeRefresh, writeSnapshot } from "../src/state.ts";

const PLUGIN_ROOT = process.env.HERDR_PLUGIN_ROOT ?? dirname(import.meta.dir);

const ESC = "\x1b";
const ALT_SCREEN_ON = `${ESC}[?1049h${ESC}[?25l`;
const ALT_SCREEN_OFF = `${ESC}[0m${ESC}[?1049l${ESC}[?25h`;
// Press/release only (1000), never motion (1002); SGR encoding (1006) because
// the legacy one caps coordinates at column 223.
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

const cfg = await loadConfig(PLUGIN_ROOT, process.env.HERDR_PLUGIN_CONFIG_DIR);
const search = boardSearch(cfg.repos) ?? "";
const warning = reposWarning(cfg.reposDropped);
if (warning) console.error(`herdr-pr-board: ${warning}`);
const notice = reposNotice(cfg.reposDropped);
const viewer = await fetchViewer();

let rows: PrRow[] = [];
let omitted = 0;
let fetchedAt: number | null = null;
let error: string | null = null;
let targets: HitTarget[] = [];
let lastPoll = 0;
let fetching = false;

// --- terminal ---------------------------------------------------------------

// Deafen the tty: -isig stops a stray Ctrl-C killing the board. Never `stty
// raw`, which drops output post-processing and stair-steps every line.
function deafen() {
  try {
    Bun.spawnSync(["stty", "-echo", "-icanon", "-isig", "-ixon", "-iexten"], {
      stdin: "inherit",
    });
  } catch {
    // Without a controllable tty the board stays readable, which is what matters.
  }
}

function geometry(): { cols: number; rows: number } {
  return {
    cols: Math.max(12, process.stdout.columns ?? 44),
    rows: Math.max(1, process.stdout.rows ?? 24),
  };
}

function paint() {
  const { cols, rows: height } = geometry();
  const groups = groupRows(rows, cfg.repos);
  const lines = render(groups, {
    cols,
    rows: height,
    now: Date.now(),
    fetchedAt,
    error,
    colour: cfg.colour,
    showOwner: cfg.showOwner === "always" ||
      (cfg.showOwner === "auto" && needsOwner(groups)),
    omitted,
    viewer,
    notice,
    unconfigured: cfg.repos.length === 0,
  });
  targets = hitTargets(lines);
  // Home then clear-to-end rather than clear-screen, which flickers.
  Bun.write(Bun.stdout, `${ESC}[H${ESC}[J${lines.join("\r\n")}`);
}

// --- data -------------------------------------------------------------------

async function refresh() {
  if (cfg.repos.length === 0) return;
  fetching = true;
  lastPoll = Date.now();
  try {
    const list = await fetchBoard(cfg.repos, cfg.maxPrs, 100, viewer);
    fetchedAt = Date.now();
    rows = list.rows;
    omitted = list.omitted;
    error = null;
    await writeSnapshot({ fetchedAt, search, rows, omitted });
  } catch (e) {
    // Keep the last good board; the top line turns red and says why.
    error = e instanceof GhError ? e.message : "refresh failed";
  } finally {
    fetching = false;
  }
}

// --- lifecycle --------------------------------------------------------------

function shutdown() {
  // Release the mouse before the alt screen, or the terminal keeps reporting
  // into whatever herdr puts in this cell next.
  Bun.write(Bun.stdout, MOUSE_OFF + ALT_SCREEN_OFF);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.on("uncaughtException", shutdown);
process.on("unhandledRejection", shutdown);
process.stdout.on("resize", () => paint());

deafen();
let pending = "";
try {
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const input = pending + chunk.toString("binary");
    const { events, rest } = parseMouse(input);
    pending = rest;
    // `r` outside a mouse report asks for a refresh; everything else typed at
    // the board is dropped.
    const typed = input.replace(/\x1b\[<[0-9;]*[Mm]/g, "");
    if (/(^|[^\x1b])r/.test(typed) && !fetching) {
      refresh().then(paint);
    }
    for (const e of events) {
      // The press of the left button only: herdr keeps the right one.
      if (!e.press || e.button !== 0) continue;
      const hit = hitAt(targets, e.row, e.col);
      if (hit) openUrl(hit.url);
    }
  });
  process.stdin.on("error", () => {});
} catch {
  // No readable stdin: nothing to drain, and the board is still readable.
}
Bun.write(Bun.stdout, ALT_SCREEN_ON + MOUSE_ON);

// Paint the cached board at once, labelled with its true age, so a restart is
// never a blank board for a whole poll interval.
const cached = await readSnapshot(search);
if (cached) {
  rows = cached.rows;
  omitted = cached.omitted;
  fetchedAt = cached.fetchedAt;
}
paint();
await refresh();

while (true) {
  // Repaint every second so the age stays honest; fetch on the poll interval
  // or when the refresh action leaves a marker.
  await Bun.sleep(1000);
  const forced = await takeRefresh().catch(() => false);
  if (!fetching && (forced || Date.now() - lastPoll >= cfg.pollSeconds * 1000)) {
    await refresh();
  }
  paint();
}
