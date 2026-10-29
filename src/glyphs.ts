// Every glyph this plugin draws, in one place. Defined as \u{} escapes so a
// Nerd Font private-use-area codepoint is readable and editable without
// needing the font installed — and changing an icon is one line here rather
// than a grep across render.ts and token.ts.
//
// The Nerd Font name is in the comment; the Unicode column is the fallback
// the pane widget uses (visible in any terminal font). Where the two are the
// same glyph the comment says "universal".

// --- status cluster (pane) -------------------------------------------------

/** Review: approved. Universal. */
export const REVIEW_APPROVED = "󰀈"; // ✓
/** Review: changes requested. Universal. */
export const REVIEW_CHANGES = "󱋟"; // ✗
/** Review: required and not yet given. nf-fa-eye */
export const REVIEW_REQUIRED = "󰈈"; //
/** CI: passing. nf-fa-check_circle */
export const CI_PASS = ""; //
/** CI: failing. nf-oct-x_circle_fill */
export const CI_FAIL = ""; //
/** CI: still running. nf-cod-loading */
export const CI_PENDING = ""; //
/** Unresolved review threads by a human. nf-md-comment_text_outline */
export const THREADS = "󰅺"; // 󰅺
/** Unresolved review threads by a bot. nf-md-robot_outline */
export const BOT_THREADS = "󰚩"; // 󰚩

// --- row markers (pane lead column) ----------------------------------------

/** Cannot be merged — conflict. Universal. */
export const CONFLICT = "󱠫"; // ⊘
/** Draft pull request. Universal. */
export const DRAFT = "◌"; // ◌
/** Merged pull request. Universal (placeholder — set the codepoint below
 *  to a Nerd Font icon when one is chosen). */
export const MERGED = ""; // ●
/** A Herdr workspace is open on this branch. Universal. */
/** Pull request is in the merge queue. Universal. */
export const QUEUED = ""; // ▸
export const LINKED = "▪"; // ▪
/** Inbound: involved but not asked. Universal. */
export const INVOLVED = "◦"; // ◦

// --- structural (pane) -----------------------------------------------------

export const ELLIPSIS = "…"; // …
/** The dim filler that carries a repo heading to the right edge. */
export const RULE = "─"; // ─

// --- sidebar token only ----------------------------------------------------

/** Refreshing indicator while a lookup is in flight. Universal. */
export const REFRESHING = "⟳"; // ⟳
