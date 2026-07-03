/**
 * rec-ord — View renderers
 *
 * Pure functions: each renderer takes the current `AppState` and returns a
 * fresh `HTMLElement` representing the current view. The app module is
 * responsible for swapping the rendered element into `#app` (inside a view
 * transition) and for attaching interaction listeners to it.
 *
 * Renderers use `document.createElement` for the main structure so that
 * the `view-transition-name` style can be applied at creation (this is
 * what allows the browser to pair the old and new elements during a
 * transition). No framework, no template strings for the main shapes.
 *
 * Every interactive element is a real `<button>` or `<input>`/`<form>`
 * with proper `name`/`type`/`required` and `aria-label`s — keyboard
 * navigation and screen readers work without extra effort.
 */

import type { AppState, Entry, Record, View } from "./types";
import {
  formatDelta,
  formatRelativeDate,
  formatValue,
  formatValueForUnit,
  latestEntry,
  previousEntry,
  todayISO,
} from "./motion";

/* ---------------------------------------------------------------------------
 * View-transition name constants
 *
 * These are paired across the old and new renders. The browser uses them
 * to identify which "old" pseudo-element maps to which "new" pseudo-element
 * so the corresponding elements can be crossfaded (the default animation
 * for named groups). This is what makes the hero number "turn into" the
 * new number, and the focus card container "grow" into the expanded form.
 * ------------------------------------------------------------------------- */

const VT_HERO = "hero";
const VT_RECORD_CARD = "record-card";
const VT_NEW_RECORD = "new-record";

/* ---------------------------------------------------------------------------
 * Local UI state (not persisted)
 *
 * Some interactions need ephemeral state that should NOT be persisted and
 * should NOT live in the global store (because it's not part of the data
 * model — it's UI state for the two-tap delete confirmation, the inline
 * entry-edit form, etc.). We keep it here in module scope; it survives
 * re-renders within the session and resets on reload.
 * ------------------------------------------------------------------------- */

interface DeleteConfirmLocal {
  recordId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const deleteConfirm: DeleteConfirmLocal = { recordId: null, timer: null };

/** ID of the entry currently being inline-edited in the expanded focus
 *  view. `null` means no entry is being edited. Like `deleteConfirm`,
 *  this is ephemeral UI state — not persisted, not in the global store. */
let editingEntryId: string | null = null;

/**
 * Public API for the delete-confirm two-tap pattern. The app module
 * drives the flow:
 *   - first tap:  `armDeleteConfirm(id)` + re-render
 *   - second tap: `consumeDeleteConfirm(id)` returns true → delete
 *   - 2.5s with no second tap: the timer in `armDeleteConfirm` calls
 *     `cancelDeleteConfirm` and dispatches `rec-ord:rerender` so the
 *     app re-renders and the button label reverts.
 */
export function armDeleteConfirm(recordId: string): void {
  if (deleteConfirm.timer !== null) {
    clearTimeout(deleteConfirm.timer);
  }
  deleteConfirm.recordId = recordId;
  deleteConfirm.timer = setTimeout(() => {
    deleteConfirm.recordId = null;
    deleteConfirm.timer = null;
    document.dispatchEvent(new CustomEvent("rec-ord:rerender"));
  }, 2500);
}

export function consumeDeleteConfirm(recordId: string): boolean {
  if (deleteConfirm.recordId === recordId) {
    if (deleteConfirm.timer !== null) {
      clearTimeout(deleteConfirm.timer);
    }
    deleteConfirm.recordId = null;
    deleteConfirm.timer = null;
    return true;
  }
  return false;
}

export function isDeleteConfirmArmed(recordId: string): boolean {
  return deleteConfirm.recordId === recordId;
}

export function cancelDeleteConfirm(): void {
  if (deleteConfirm.timer !== null) {
    clearTimeout(deleteConfirm.timer);
  }
  deleteConfirm.recordId = null;
  deleteConfirm.timer = null;
}

/** Returns the id of the entry currently being inline-edited, or null. */
export function getEditingEntryId(): string | null {
  return editingEntryId;
}

/** Sets the id of the entry currently being inline-edited. Pass `null`
 *  to clear. The caller is responsible for triggering a re-render. */
export function setEditingEntryId(id: string | null): void {
  editingEntryId = id;
}

/** Subscribes to local re-render triggers (the delete-confirm timeout). */
export function onRerender(handler: () => void): () => void {
  const listener = (): void => handler();
  document.addEventListener("rec-ord:rerender", listener);
  return () => document.removeEventListener("rec-ord:rerender", listener);
}

/* ---------------------------------------------------------------------------
 * Top-level dispatch
 * ------------------------------------------------------------------------- */

/** Returns the element that should replace the current `#app` child. */
export function renderApp(state: AppState): HTMLElement {
  // If a record is currently in delete-confirm mode but the user navigated
  // to a different record, cancel the confirm. The visual state will be
  // reflected on next render.
  if (deleteConfirm.recordId !== null && deleteConfirm.recordId !== state.currentRecordId) {
    cancelDeleteConfirm();
  }

  // If an entry is being inline-edited but the user navigated to a
  // different record (or the entry no longer exists — e.g. it was the
  // only entry and the record was deleted), clear the edit state so
  // the next render shows the read-only row.
  if (editingEntryId !== null) {
    const currentRecord = state.records.find((r) => r.id === state.currentRecordId);
    const stillExists =
      currentRecord !== undefined &&
      currentRecord.entries.some((e) => e.id === editingEntryId);
    if (!stillExists) {
      editingEntryId = null;
    }
  }

  if (state.records.length === 0) {
    return renderEmpty();
  }

  const view: View = state.view;
  if (view === "new") return renderNewRecord();
  if (view === "grid") return renderGrid(state);
  // view === "focus"
  return state.expanded ? renderFocusExpanded(state) : renderFocus(state);
}

/* ---------------------------------------------------------------------------
 * Sparkline
 *
 * A small SVG `<polyline>` that visualizes a record's value trend. Used
 * in two places:
 *   - the focus view (large, above the hero) — a quick visual scan of
 *     where the number is headed before the user reads it
 *   - the grid (small, below the delta) — a subtle trend hint per cell
 *
 * Implementation: entries are reversed to draw oldest→newest left→right.
 * Min/max are computed across the values; range is `max - min || 1` so
 * a flat series (all values equal) doesn't divide by zero. Each point
 * is mapped into the viewBox, inset 1px top/bottom so the stroke doesn't
 * touch the edges. The polyline uses the accent color at 0.7 opacity;
 * an optional circle marks the latest point at 0.95 opacity.
 *
 * With fewer than 2 entries, there is no meaningful trend — return a
 * short horizontal placeholder line so the layout doesn't jump and the
 * spot still reads as "a sparkline lives here".
 * ------------------------------------------------------------------------- */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SparklineOptions {
  // The rendered width: either a fixed pixel value (number) or a CSS
  // length (string, e.g. "100%"). When a string is passed, the SVG
  // is sized by CSS at render time and the internal viewBox uses
  // 320 as a numeric base for the coordinate system. The grid still
  // uses pixel widths; the collapsed focus top area uses "100%".
  width: number | string;
  height: number;
  showLatestDot?: boolean;
  className?: string;
}

// Numeric viewBox base used when the caller passes a string width
// (e.g. "100%"). Picked to match the typical horizontal width of the
// collapsed focus top area on a phone in portrait — large enough that
// the polyline looks like a real chart, small enough that the
// coordinates don't accumulate floating-point dust.
const SPARKLINE_STRING_WIDTH_BASE = 320;

export function renderSparkline(
  entries: ReadonlyArray<Entry>,
  options: SparklineOptions,
): SVGSVGElement {
  const width = options.width;
  const height = options.height;
  const showLatestDot = options.showLatestDot === true;
  const className = options.className ?? "";

  // The viewBox coordinate system needs a numeric base width so the
  // polyline points can be computed. When the caller passes a string
  // (e.g. "100%"), the actual rendered size is determined by CSS and
  // the SVG scales to fit — the viewBox base is just an internal
  // coordinate system.
  const numericBase: number =
    typeof width === "number" ? width : SPARKLINE_STRING_WIDTH_BASE;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${numericBase} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // `block` so `mx-auto` (focus view) actually centers the SVG; SVG
  // is `display: inline` by default which makes `margin: auto` a no-op.
  // `overflow-visible` so strokes at the right/bottom edge aren't clipped
  // by the viewBox.
  const classes: string[] = ["block", "overflow-visible"];
  if (className !== "") classes.push(className);
  svg.setAttribute("class", classes.join(" "));

  if (entries.length < 2) {
    // Placeholder: a short horizontal line at the vertical center, at
    // very low opacity. Reads as "there's a sparkline here, just not
    // enough data to draw one".
    const line = document.createElementNS(SVG_NS, "line");
    const yMid = String(height / 2);
    line.setAttribute("x1", "0");
    line.setAttribute("y1", yMid);
    line.setAttribute("x2", String(numericBase * 0.5));
    line.setAttribute("y2", yMid);
    line.setAttribute("stroke", "var(--color-accent)");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", "0.2");
    svg.append(line);
    return svg;
  }

  // Draw oldest → newest (left → right). The store keeps entries
  // newest-first, so reverse once.
  const ordered: Entry[] = [...entries].reverse();
  const n = ordered.length;
  let min = ordered[0]!.value;
  let max = ordered[0]!.value;
  for (const e of ordered) {
    if (e.value < min) min = e.value;
    if (e.value > max) max = e.value;
  }
  const range = max - min !== 0 ? max - min : 1;

  const points: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * numericBase;
    const y = 1 + (1 - (ordered[i]!.value - min) / range) * (height - 2);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }

  const polyline = document.createElementNS(SVG_NS, "polyline");
  polyline.setAttribute("points", points.join(" "));
  polyline.setAttribute("fill", "none");
  polyline.setAttribute("stroke", "var(--color-accent)");
  polyline.setAttribute("stroke-width", "1.5");
  polyline.setAttribute("stroke-linecap", "round");
  polyline.setAttribute("stroke-linejoin", "round");
  polyline.setAttribute("opacity", "0.7");
  svg.append(polyline);

  if (showLatestDot) {
    const lastX = numericBase;
    const lastY = 1 + (1 - (ordered[n - 1]!.value - min) / range) * (height - 2);
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(lastX));
    circle.setAttribute("cy", lastY.toFixed(2));
    circle.setAttribute("r", "2");
    circle.setAttribute("fill", "var(--color-accent)");
    circle.setAttribute("opacity", "0.95");
    svg.append(circle);
  }

  return svg;
}

/* ---------------------------------------------------------------------------
 * Empty state
 * ------------------------------------------------------------------------- */

function renderEmpty(): HTMLElement {
  const section = document.createElement("section");
  section.className =
    "w-full max-w-7xl flex flex-col items-center gap-8";
  // The empty state doesn't have a view-transition-name; the default root
  // crossfade applies for the focus → empty transition.

  // Primary hint: swipe right to add.
  const hintGroup = document.createElement("div");
  hintGroup.className = "flex items-center gap-4";
  const bar = document.createElement("span");
  bar.className = "block w-0.5 h-5 bg-accent";
  bar.setAttribute("aria-hidden", "true");
  const label = document.createElement("p");
  label.className =
    "font-body font-semibold text-xs tracking-[0.2em] uppercase text-ink-muted";
  label.textContent = "SWIPE → TO ADD YOUR FIRST RECORD";
  hintGroup.append(bar, label);

  // Thin divider.
  const divider = document.createElement("span");
  divider.className = "block w-12 h-px bg-line";
  divider.setAttribute("aria-hidden", "true");

  // Secondary action: load a set of example records to see the app populated.
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-action", "load-examples");
  button.className =
    "font-body text-[0.625rem] tracking-[0.2em] uppercase text-ink-muted opacity-50 hover:opacity-100 hover:text-accent transition-all duration-200 cursor-pointer";
  button.textContent = "LOAD EXAMPLES";

  section.append(hintGroup, divider, button);
  return section;
}

/* ---------------------------------------------------------------------------
 * Focus card (collapsed)
 * ------------------------------------------------------------------------- */

function findCurrentRecord(state: AppState): Record | null {
  if (state.currentRecordId === null) return null;
  return state.records.find((r) => r.id === state.currentRecordId) ?? null;
}

function renderFocus(state: AppState): HTMLElement {
  const record = findCurrentRecord(state);
  if (record === null) {
    // Defensive: should never reach here (caller checks records.length).
    return renderEmpty();
  }
  const latest = latestEntry(record);
  if (latest === null) return renderEmpty();

  // The section is THE focus card for view-transition purposes. The
  // expanded view's section is a different element with the same
  // `view-transition-name: record-card`, so the browser pairs them on
  // long-press / collapse and morphs the height/content. The section is
  // `position: relative` so the ::after pseudo-element (swipe progress
  // bar, styled in motion.css) can anchor to its bottom edge.
  // `h-full` lets the inner `flex-1 justify-end` push the card content
  // to the bottom of the screen (Apple Music "now playing" feel).
  // Without `h-full` on the section + `flex-1` on the inner, the
  // section collapses to its content height and `justify-end` is a no-op
  // (content shows at the top instead of the bottom).
  const section = document.createElement("section");
  section.className =
    "relative w-full max-w-7xl h-full flex flex-col items-start gap-6 px-4 sm:px-8";
  section.dataset.focusCard = "true";
  section.style.viewTransitionName = VT_RECORD_CARD;

  // Current card content (context label + hero + stats, when applicable).
  section.append(renderFocusInner(record, latest, false));

  return section;
}

function renderFocusInner(record: Record, latest: Entry, expanded: boolean): HTMLElement {
  // Full card content: context + sparkline + hero + stats. The wrapper
  // section (collapsed focus and expanded focus) adds `data-focus-card`
  // and the shared `view-transition-name: record-card`, so the browser
  // pairs the two on long-press / collapse and morphs the height/content.
  //
  // Layout depends on `expanded`:
  //   - Collapsed: a top area (context + trend + sparkline) at the top
  //     of the screen and a bottom area (hero + stats) at the bottom.
  //     The inner is `flex flex-col h-full w-full flex-1` and a flex-1
  //     spacer between the two areas pushes the bottom area to the
  //     bottom edge — the "Apple Music now playing" feel, but with the
  //     empty top margin now occupied by dashboard-style metrics.
  //   - Expanded: top-center aligned (`items-center justify-start pt-4`).
  //     The content centers horizontally and sits at the top of the
  //     screen, with the history + form below it (also centered). No
  //     sparkline, no trend indicator — the per-entry history list
  //     below provides the detail.
  //
  // View-transition-name: we tag the inner with `card-head` ONLY when
  // collapsed. On expand, the old (collapsed, named) element fades out
  // and the new (expanded, unnamed) element appears — the outer section
  // `record-card` morph handles the overall height/position change, and
  // the card-head fade provides a clean visual transition for the card
  // content itself. On collapse, the new (collapsed, named) element
  // fades in, paired with the outer section's record-card morph. We
  // intentionally DON'T keep the name on the expanded inner: if we did,
  // the browser would try to pair a collapsed card-head with an
  // expanded one on collapse, producing a confusing layout morph.
  //
  // The new sparkline + trend indicator only exist in the collapsed
  // view. The browser handles their entrance/exit via the unnamed-
  // element crossfade (the default `expand`/`collapse` animation in
  // motion.css): when going to expanded, they fade out; when coming
  // back to collapsed, they fade in.
  const inner = document.createElement("div");
  if (expanded) {
    inner.className =
      // `flex-1` REMOVED: with two `flex-1` siblings (inner + expandedWrap)
      // each took 50% of the section, leaving the expandedWrap with
      // only half the viewport for the history + add-entry + delete.
      // When the history was long, the content overflowed the 50%
      // space and the add-entry button ended up below the visible
      // area. Now the inner takes its natural height (hero + stats)
      // and the expandedWrap is the SOLE `flex-1` sibling, filling
      // all remaining space and scrolling properly.
      "flex flex-col items-center justify-start gap-8 w-full pt-4";
  } else {
    // The inner fills the section's height (the section is `h-full`
    // and inner is the only child with `flex-1` in a flex column).
    // Children: top area (context + trend + sparkline), flex-1 spacer,
    // bottom area (hero + stats). The spacer takes the leftover
    // vertical space and pushes the bottom area to the bottom edge.
    // (`justify-end` is not used here — the spacer is the mechanism,
    // and it cooperates with the `gap-8` to keep the top and bottom
    // areas at least 32px apart.)
    inner.className = "flex flex-col h-full w-full gap-8 flex-1";
    inner.style.viewTransitionName = "card-head";
  }

  if (expanded) {
    // Edit / expanded view: hero at the top-center, stats below the
    // hero (only when there is a baseline entry — the expanded
    // history list already provides the per-entry detail). No
    // trend indicator and no sparkline here.
    inner.append(renderHero(record, latest));
    const prev = previousEntry(record);
    if (prev !== null) inner.append(renderStats(record, latest, prev));
  } else {
    // === Top area: context + trend indicator + sparkline ==========
    // Uses the top margin space that was empty in the previous
    // bottom-aligned layout. The sparkline is now LARGER and
    // full-width, and the trend indicator (↑/❚❚/—) sits to the
    // right of the context label.
    const prev = previousEntry(record);

    const top = document.createElement("div");
    top.className = "flex flex-col gap-4 w-full";

    // Row 1: context label (left) + trend indicator (right),
    // justified across the full width.
    const headerRow = document.createElement("div");
    headerRow.className = "flex items-center justify-between w-full gap-4";
    headerRow.append(renderContextLabel(record));
    headerRow.append(renderTrendIndicator(record, latest, prev));
    top.append(headerRow);

    // Row 2: the sparkline — LARGER (56px tall, vs 22px before),
    // full-width (responsive via `width: "100%"` and `w-full`), at
    // 50% opacity so it sits beneath the metric values visually.
    const sparkline = renderSparkline(record.entries, {
      width: "100%",
      height: 56,
      showLatestDot: true,
      className: "text-accent opacity-50 w-full",
    });
    top.append(sparkline);

    inner.append(top);

    // Flex-1 spacer. Lives in `inner` (between `top` and `bottom`),
    // not inside `top`: a `flex-1` child only grows inside a flex
    // container with a determined main-axis size, and `top` is
    // auto-sized (its own height = sum of its children's natural
    // sizes). Putting the spacer here lets it consume the leftover
    // vertical space and push the bottom area to the bottom edge.
    const spacer = document.createElement("div");
    spacer.className = "flex-1";
    inner.append(spacer);

    // === Bottom area: hero + stats ================================
    // Same bottom-left alignment as before; the stats are now
    // ALWAYS visible (with "—" values when there is no previous
    // entry), so the stats block matches the visual weight of the
    // top area's metrics.
    const bottom = document.createElement("div");
    bottom.className = "flex flex-col items-start gap-6 w-full";
    bottom.append(renderHero(record, latest));
    bottom.append(renderStats(record, latest, prev));
    inner.append(bottom);
  }

  return inner;
}

function renderContextLabel(record: Record): HTMLElement {
  const context = document.createElement("div");
  context.className = "flex items-center gap-4";

  const bar = document.createElement("span");
  bar.className = "block w-0.5 h-5 bg-accent";
  bar.setAttribute("aria-hidden", "true");

  const label = document.createElement("p");
  label.className =
    "font-body font-semibold text-xs tracking-[0.2em] uppercase text-ink-muted";
  label.textContent = record.name.toUpperCase();

  context.append(bar, label);
  return context;
}

/**
 * Small status indicator for the top-right of the collapsed focus
 * header — shows whether the latest entry is progress, a pause/
 * regression, or no change vs the previous entry.
 *
 * Three visual states (small uppercase label, aria-hidden because the
 * delta is also visible in the stats block and the per-entry history
 * list):
 *   - "—" (em-dash) in muted ink at 50% opacity, when there's no
 *     previous entry (this is the first entry) OR the value is
 *     unchanged.
 *   - "↑" in the accent color, when the delta is in the record's
 *     "good" direction per `record.direction`:
 *       direction "up"   + delta > 0 → progress
 *       direction "down" + delta < 0 → progress (less is better)
 *       direction null   + delta > 0 → progress (default: up is good)
 *   - "❚❚" (pause bars) in muted ink, when the delta is in the
 *     "bad" direction (or for null direction + delta < 0).
 */
function renderTrendIndicator(
  record: Record,
  latest: Entry,
  previous: Entry | null,
): HTMLElement {
  const el = document.createElement("span");
  el.className =
    "font-body text-sm tracking-[0.1em] uppercase font-semibold";
  el.setAttribute("aria-hidden", "true");

  // No previous entry — first entry, no baseline to compare to.
  if (previous === null) {
    el.textContent = "—";
    el.className += " text-ink-muted/50";
    return el;
  }

  const delta = latest.value - previous.value;

  // No change between latest and previous — neutral state.
  if (delta === 0) {
    el.textContent = "—";
    el.className += " text-ink-muted/50";
    return el;
  }

  // What's the "good" direction for this record?
  //   - "up"   → delta > 0 is progress
  //   - "down" → delta < 0 is progress (less is better)
  //   - null   → delta > 0 is progress (default: up is good)
  const isGood = record.direction === "down" ? delta < 0 : delta > 0;

  if (isGood) {
    el.textContent = "↑";
    el.className += " text-accent";
  } else {
    // Pause / regression: the value moved in the "bad" direction
    // (or there is no direction and the value went down).
    el.textContent = "❚❚";
    el.className += " text-ink-muted";
  }

  return el;
}

function renderHero(record: Record, latest: Entry): HTMLElement {
  // Hero: the DOMINANT visual element. The value is huge, left-aligned,
  // and the first thing the eye sees. The unit sits below as a secondary
  // label. The direction indicator (if any) is a small badge.
  //
  // Overflow guard: `max-w-full overflow-hidden` on the wrapper is a
  // safety net for very long values (e.g. "999999"). The `clamp()` on
  // the h1 font-size already constrains the value visually, but if the
  // viewport is unusually narrow OR the value is unusually wide, the
  // h1 could overflow the container. The wrapper's `overflow-hidden`
  // clips any overshoot cleanly (no horizontal scrollbar, no layout
  // breakage on the flex parent).
  const heroWrap = document.createElement("div");
  // `flex flex-col items-start justify-end` so when the h1 wraps (e.g.,
  // a 3+ digit value on a narrow screen), the wrapper grows UPWARD
  // from its bottom-anchored position. The row that contains the hero
  // is `items-end`, so the hero sits at the bottom of the row; the
  // wrapper's `justify-end` anchors the h1+unit to the bottom of the
  // hero, and any wrapped lines of the h1 extend upward instead of
  // pushing the unit down.
  // `shrink-0` REMOVED: with it, the wrapper takes its natural width
  // (the full text width at 28rem font) and the h1 never has to
  // wrap. Without it, the wrapper is constrained by the row, and the
  // h1 wraps when the value is too wide.
  heroWrap.className =
    "relative flex flex-col items-start justify-end text-left max-w-full min-w-0";
  heroWrap.style.viewTransitionName = VT_HERO;

  // Direction indicator: small ↑ or ↓ badge in the top-right corner.
  // Rendered first in DOM so it's positioned absolutely before the value.
  if (record.direction === "up" || record.direction === "down") {
    const dir = document.createElement("span");
    dir.className =
      "absolute top-0 right-0 font-body text-sm tracking-[0.15em] uppercase " +
      "text-ink-muted opacity-50";
    dir.textContent = record.direction === "up" ? "↑" : "↓";
    dir.setAttribute("aria-hidden", "true");
    heroWrap.append(dir);
  }

  // Value: the big number. font-black (900) for maximum punch, tight
  // leading and tracking. The `data-hero` attribute is the hook for the
  // "nuevo récord" glow pulse — when an entry breaks the record's best,
  // app.ts adds a temporary `pr-pulse` class to this element to flash
  // a text-shadow. Without a breaking entry the element renders plain.
  //
  // `overflow-hidden text-clip` REMOVED: when the value is too wide for
  // the container, the h1 WRAPS (text-wrap) instead of truncating.
  // The hero wrapper's `justify-end` anchors the bottom, so wrapped
  // lines extend upward (the h1 grows in height and pushes the top
  // of the wrapper up, not the unit down). `min-w-0` allows the h1
  // to shrink in a flex context. `max-w-full` still caps the width.
  // `break-words` (overflow-wrap: break-word) lets the number itself
  // break across lines (numbers don't have natural break points).
  // Time units (HRS, MIN, SEC) use a SMALLER font ("1h 30m" is wider
  // than "30" so a smaller size keeps the hero visually balanced with
  // the integer/decimal records). Everything else uses the standard
  // hero size.
  const isTimeUnit = record.unit.toUpperCase().trim() === "HRS" ||
                     record.unit.toUpperCase().trim() === "MIN" ||
                     record.unit.toUpperCase().trim() === "SEC";
  const heroFontSize = isTimeUnit
    ? "text-[clamp(7rem,30vw,16rem)]"
    : "text-[clamp(12rem,52vw,28rem)]";
  const value = document.createElement("h1");
  value.id = "hero-value";
  value.dataset.hero = "true";
  value.className =
    "font-display font-black leading-[0.85] tracking-[-0.05em] text-accent " +
    heroFontSize + " tabular-nums max-w-full min-w-0 break-words";
  value.textContent = formatValueForUnit(latest.value, record.unit);

  // Unit: displayed BELOW the value as a secondary label.
  const unit = document.createElement("div");
  unit.className =
    "font-body text-2xl tracking-[0.2em] uppercase text-ink-muted mt-2";
  unit.textContent = record.unit;

  heroWrap.append(value, unit);
  return heroWrap;
}

function renderStats(
  record: Record,
  latest: Entry,
  previous: Entry | null,
): HTMLElement {
  // The stats block is ALWAYS visible in the collapsed focus view,
  // even on the first entry, where `previous` is null. The PREVIOUS
  // and CHANGE columns render "—" when there's no baseline to
  // compare to. The expanded view still gates on `previous !== null`
  // (the call site decides whether to render stats at all).
  const stats = document.createElement("div");
  stats.className =
    "flex flex-col items-start gap-8 w-full pt-8 border-t border-line " +
    "md:flex-row md:justify-start";

  const previousCol = document.createElement("div");
  previousCol.className = "flex flex-col gap-1";
  const previousLabel = document.createElement("span");
  previousLabel.className =
    "font-body font-medium text-[0.625rem] leading-none tracking-[0.2em] " +
    "uppercase text-ink-muted opacity-50";
  previousLabel.textContent = "PREVIOUS";
  const previousValue = document.createElement("span");
  previousValue.className =
    "font-body font-medium text-xl leading-[1.1] tracking-[0.05em] " +
    "uppercase tabular-nums text-ink";
  previousValue.textContent =
    previous !== null
    ? `${formatValueForUnit(previous.value, record.unit)} ${record.unit}`
    : "—";
  previousCol.append(previousLabel, previousValue);

  const divider = document.createElement("span");
  divider.className =
    "hidden md:block w-px self-stretch min-h-12 bg-line";
  divider.setAttribute("aria-hidden", "true");

  const changeCol = document.createElement("div");
  changeCol.className = "flex flex-col gap-1";
  const changeLabel = document.createElement("span");
  changeLabel.className =
    "font-body font-medium text-[0.625rem] leading-none tracking-[0.2em] " +
    "uppercase text-ink-muted opacity-50";
  changeLabel.textContent = "CHANGE";
  const changeValue = document.createElement("span");
  changeValue.className =
    "font-body font-medium text-xl leading-[1.1] tracking-[0.05em] " +
    "uppercase tabular-nums text-accent";
  changeValue.textContent =
    previous !== null
      ? formatDelta(latest.value, previous.value, record.unit)
      : "—";
  changeCol.append(changeLabel, changeValue);

  stats.append(previousCol, divider, changeCol);
  return stats;
}

/* ---------------------------------------------------------------------------
 * Focus expanded (single card with history + form + delete)
 * ------------------------------------------------------------------------- */

function renderFocusExpandedSection(
  record: Record,
  latest: Entry,
  state: AppState,
): HTMLElement {
  const section = document.createElement("section");
  // The section is a flex column with a constrained height so the
  // inner entries list can scroll independently when there are many
  // entries. The hero, the "+ NEW ENTRY" toggle, and the delete button
  // are pinned to the top/bottom and don't scroll.
  section.className =
    "w-full max-w-7xl flex flex-col items-start gap-6 px-4 sm:px-8 " +
    "h-full max-h-[100dvh]";
  section.dataset.focusCard = "true";
  section.style.viewTransitionName = VT_RECORD_CARD;

  section.append(renderFocusInner(record, latest, true));

  // --- Expanded content (entries history + add-entry form + delete) -----
  //
  // This wrapper is the scrollable region for the expanded view. The
  // history can be long (dozens of entries), so it needs to scroll
  // independently of the card content above it.
  //
  // Key classes for the scroll fix:
  //   - `flex-1`        — fill the remaining vertical space in the section
  //                       (the section is `h-full max-h-[100dvh]`)
  //   - `min-h-0`       — CRITICAL: without this, flex children don't
  //                       shrink below their content size, and the
  //                       `overflow-y-auto` never triggers. The history
  //                       would push the section past the viewport.
  //   - `overflow-y-auto` — enables vertical scrolling when content
  //                       exceeds the wrapper's height
  //   - `max-w-md`      — keeps the history list readable (a 28rem
  //                       column is the max comfortable reading width)
  //   - `items-center`  — centers the history rows + form within the
  //                       column (matches the centered card content
  //                       above)
  const expandedWrap = document.createElement("div");
  expandedWrap.className =
    "min-h-0 overflow-y-auto w-full max-w-md flex flex-col items-center gap-6 pt-8 flex-1";

  // Entries history (newest first; the latest is index 0 and is the
  // hero, so we show entries[1..] in the history. The latest is hidden
  // because it IS the hero.) The list itself doesn't scroll — the
  // parent `expandedWrap` is the scroll region (it has
  // `overflow-y-auto min-h-0 flex-1`), so the whole expanded content
  // (history + add-entry form + delete) scrolls together as one
  // continuous region.
  const list = document.createElement("ul");
  list.className = "w-full max-w-md flex flex-col gap-1";

  const history = record.entries.slice(1);
  for (const entry of history) {
    list.append(renderEntryRow(entry, record));
  }
  expandedWrap.append(list);

  // "+ NEW ENTRY" affordance or inline form
  //
  // The toggle button is ALWAYS visible (header of this section).
  // When `addingEntry` is false its label is "+ NEW ENTRY" and tapping
  // it opens the inline form. When `addingEntry` is true its label
  // flips to "CANCEL" and tapping it closes the form (the form
  // disappears, the edit expansion stays). This makes the spec's
  // "Tapping the header button again cancels" instruction work.
  const addWrap = document.createElement("div");
  addWrap.className = "w-full max-w-md flex flex-col items-start gap-4 shrink-0";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className =
    "font-body text-xs tracking-[0.2em] uppercase text-accent " +
    "hover:text-ink transition-colors";
  toggle.textContent = state.addingEntry ? "CANCEL" : "+ NEW ENTRY";
  toggle.dataset.newEntryToggle = "true";
  addWrap.append(toggle);

  if (state.addingEntry) {
    addWrap.append(renderInlineAddEntryForm(record));
  }
  expandedWrap.append(addWrap);

  // DELETE RECORD (two-tap)
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  const inConfirm = isDeleteConfirmArmed(record.id);
  deleteBtn.className =
    "font-body text-[0.625rem] tracking-[0.2em] uppercase " +
    "text-ink-muted/50 hover:text-ink-muted transition-colors shrink-0";
  if (inConfirm) {
    // Subtle visual difference to indicate the "armed" state.
    deleteBtn.classList.remove("text-ink-muted/50");
    deleteBtn.classList.add("text-ink-muted");
  }
  deleteBtn.textContent = inConfirm ? "TAP TO CONFIRM" : "DELETE RECORD";
  deleteBtn.dataset.deleteRecord = "true";
  expandedWrap.append(deleteBtn);

  section.append(expandedWrap);
  return section;
}

/* ---------------------------------------------------------------------------
 * Focus expanded (delegates to renderFocusExpandedSection)
 * ------------------------------------------------------------------------- */

function renderFocusExpanded(state: AppState): HTMLElement {
  const record = findCurrentRecord(state);
  if (record === null) return renderEmpty();
  const latest = latestEntry(record);
  if (latest === null) return renderEmpty();
  return renderFocusExpandedSection(record, latest, state);
}

/* ---------------------------------------------------------------------------
 * Entry row (used inside the history list)
 *
 * Two visual states for the row, switched by the local `editingEntryId`
 * in render.ts:
 *   - read-only (default): value on the left, relative date + a
 *     "<" swipe hint on the right
 *   - editing: the content is REPLACED by the inline edit form
 *     (renderEntryEditForm below). Tapping the row dispatches
 *     `rec-ord:edit-entry`, app.ts sets `editingEntryId`, and the next
 *     render swaps the content. Swipe-to-delete is still wired on the
 *     same <li> so the two gestures stay distinct: tap → edit, swipe
 *     left → delete.
 * ------------------------------------------------------------------------- */

function renderEntryRow(entry: Entry, record: Record): HTMLElement {
  const li = document.createElement("li");
  li.className =
    "flex items-center justify-between gap-4 py-2 border-b border-line/40 text-ink";
  li.dataset.entryId = entry.id;
  li.dataset.entryRow = "true";
  li.setAttribute("aria-label", `Entry: ${formatValueForUnit(entry.value, record.unit)} ${record.unit}, ${formatRelativeDate(entry.date).toLowerCase()}`);

  if (editingEntryId === entry.id) {
    li.append(renderEntryEditForm(entry, record));
    return li;
  }

  const left = document.createElement("span");
  left.className = "font-body font-medium tabular-nums";
  left.textContent = `${formatValueForUnit(entry.value, record.unit)} ${record.unit}`;

  const rightWrap = document.createElement("span");
  rightWrap.className = "flex items-center gap-3";

  const right = document.createElement("span");
  right.className =
    "font-body text-xs uppercase tracking-[0.1em] text-ink-muted";
  right.textContent = formatRelativeDate(entry.date);

  // Tiny hint that swiping left deletes it.
  const hint = document.createElement("span");
  hint.className = "text-ink-muted opacity-40 text-xs";
  hint.textContent = "\u2039"; // U+2039 SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  hint.setAttribute("aria-hidden", "true");

  rightWrap.append(right, hint);
  li.append(left, rightWrap);
  return li;
}

/* ---------------------------------------------------------------------------
 * Inline entry-edit form (replaces the row's read-only content while
 * the user is correcting a value/date).
 *
 * The form keeps the row's `flex items-center justify-between` layout:
 *   - top row: value input + unit hint + date input (one line)
 *   - bottom row: SAVE + CANCEL text buttons (right-aligned)
 *
 * Inputs are borderless, transparent, with a thin accent border on
 * focus — matches the rest of the design's "bare" input feel.
 *
 * Markers:
 *   - data-entry-edit-form="true"   — wire() finds it and binds submit
 *   - data-entry-id="<id>"          — wire() / onEditEntrySubmit read
 *                                     it to know which entry to update
 *   - data-cancel-edit (on CANCEL)  — wire() binds click → cancel
 *
 * Pressing Escape inside the form also cancels (the app's keydown
 * handler is no-op while focused in a form input, so the form gets
 * its own keydown listener).
 * ------------------------------------------------------------------------- */

function renderEntryEditForm(entry: Entry, record: Record): HTMLElement {
  const form = document.createElement("form");
  form.className = "w-full flex flex-col gap-2";
  form.dataset.entryEditForm = "true";
  form.dataset.entryId = entry.id;

  // --- Top row: value + unit + date ---------------------------------------
  const topRow = document.createElement("div");
  topRow.className = "flex items-center justify-between gap-3";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.value = String(entry.value);
  valueInput.setAttribute("aria-label", "Value");
  valueInput.className =
    "bg-transparent border-b border-line/40 focus:border-accent outline-none " +
    "font-body font-medium tabular-nums text-ink text-base w-20 text-left " +
    "transition-colors";

  const unitHint = document.createElement("span");
  unitHint.className =
    "font-body text-xs uppercase tracking-[0.1em] text-ink-muted opacity-50 shrink-0";
  unitHint.textContent = record.unit;

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.name = "date";
  dateInput.required = true;
  dateInput.value = entry.date;
  dateInput.setAttribute("aria-label", "Date");
  dateInput.className =
    "bg-transparent border-b border-line/40 focus:border-accent outline-none " +
    "font-body font-medium tabular-nums text-ink text-sm w-36 text-left " +
    "scheme-dark transition-colors";

  topRow.append(valueInput, unitHint, dateInput);

  // --- Bottom row: SAVE + CANCEL ------------------------------------------
  const bottomRow = document.createElement("div");
  bottomRow.className = "flex items-center justify-end gap-4";

  const save = document.createElement("button");
  save.type = "submit";
  save.className =
    "font-body text-[0.625rem] tracking-[0.2em] uppercase text-accent " +
    "hover:text-ink transition-colors cursor-pointer";
  save.textContent = "SAVE";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.dataset.cancelEdit = "true";
  cancel.className =
    "font-body text-[0.625rem] tracking-[0.2em] uppercase " +
    "text-ink-muted/60 hover:text-ink-muted transition-colors cursor-pointer";
  cancel.textContent = "CANCEL";

  bottomRow.append(save, cancel);

  form.append(topRow, bottomRow);
  return form;
}

/* ---------------------------------------------------------------------------
 * Inline add-entry form (inside the expanded focus)
 * ------------------------------------------------------------------------- */

function renderInlineAddEntryForm(record: Record): HTMLElement {
  const form = document.createElement("form");
  form.className = "w-full flex flex-col items-center gap-3";
  form.dataset.addEntryForm = "true";

  // Value + unit (read-only) on one line
  const valueRow = document.createElement("div");
  valueRow.className = "w-full flex items-baseline justify-center gap-3";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.placeholder = "0";
  valueInput.setAttribute("aria-label", "Value");
  valueInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-2xl font-display tabular-nums text-ink w-32 text-center " +
    "transition-colors";

  const unitHint = document.createElement("span");
  unitHint.className = "font-body text-xs uppercase tracking-[0.2em] text-ink-muted opacity-60";
  unitHint.textContent = `IN ${record.unit}`;

  valueRow.append(valueInput, unitHint);

  // Date input
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.name = "date";
  dateInput.required = true;
  dateInput.value = todayISO();
  dateInput.setAttribute("aria-label", "Date");
  dateInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-base font-body tabular-nums text-ink " +
    "scheme-dark transition-colors";

  // Submit
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className =
    "font-body text-xs tracking-[0.2em] uppercase text-accent " +
    "hover:text-ink transition-colors pt-2";
  submit.textContent = "SAVE";

  form.append(valueRow, dateInput, submit);
  return form;
}

/* ---------------------------------------------------------------------------
 * New-record form
 * ------------------------------------------------------------------------- */

/* Common unit presets for the new-record form. The last entry is the
 * CUSTOM sentinel (empty string) — clicking it clears the unit input and
 * focuses it so the user can type a free-text unit. */
const UNIT_PRESETS: ReadonlyArray<string> = [
  "DAYS",
  "KG",
  "LBS",
  "HRS",
  "MIN",
  "KM",
  "MI",
  "CAL",
  "REPS",
  "", // CUSTOM
];

function renderNewRecord(): HTMLElement {
  const section = document.createElement("section");
  // Constrain the section to the viewport so the form can scroll
  // independently. The cancel button and title are pinned to the top
  // (shrink-0) and the form fills the remaining space (flex-1) with
  // `scroll-region` styling.
  section.className =
    "w-full max-w-7xl flex flex-col items-start gap-6 px-4 sm:px-8 " +
    "h-full max-h-[100dvh]";
  section.dataset.newRecord = "true";
  section.style.viewTransitionName = VT_NEW_RECORD;

  // Cancel button at the top-right. The form is opened by swipe-right,
  // so there's no other way to close it without swiping left — this
  // gives a clear tap target.
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.dataset.action = "close-new";
  cancelBtn.className =
    "self-end shrink-0 font-body text-xs tracking-[0.2em] uppercase text-ink-muted " +
    "hover:text-ink transition-colors";
  cancelBtn.textContent = "CANCEL";

  // Title with top border for visual separation.
  const title = document.createElement("p");
  title.className =
    "shrink-0 font-body font-semibold text-2xl tracking-[0.2em] uppercase text-ink-muted " +
    "w-full pb-4 border-b border-line";
  title.textContent = "NEW RECORD";

  const form = document.createElement("form");
  // The form is the scroll region. `flex-1 min-h-0` lets it fill the
  // remaining vertical space and `scroll-region` enables native touch
  // scrolling on it. `h-full` + `overflow-y-auto` are added
  // explicitly as a belt-and-suspenders scroll fix — the form needs
  // to scroll when the keyboard pushes content up on mobile, and the
  // combo guarantees `overflow-y: auto` is active regardless of how
  // the parent flex container's height resolves.
  form.className =
    "w-full max-w-2xl flex flex-col gap-6 text-left " +
    "h-full overflow-y-auto flex-1 min-h-0 scroll-region";
  form.dataset.newRecordForm = "true";

  // Name — big and prominent
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.required = true;
  nameInput.placeholder = "e.g. Days without smoking";
  nameInput.setAttribute("aria-label", "Record name");
  nameInput.autocomplete = "off";
  nameInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-3xl font-display text-ink w-full " +
    "transition-colors";

  // Value — HUGE, yellow, the centerpiece
  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.placeholder = "0";
  valueInput.setAttribute("aria-label", "Value");
  valueInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-6xl font-display tabular-nums text-accent w-full text-center " +
    "transition-colors";

  // --- Unit preset picker: 3-column grid of large pill buttons --------
  const presetsRow = document.createElement("div");
  presetsRow.className = "grid grid-cols-3 sm:grid-cols-5 gap-3";
  presetsRow.setAttribute("role", "group");
  presetsRow.setAttribute("aria-label", "Unit preset");

  for (const preset of UNIT_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.unitPreset = preset;
    btn.textContent = preset === "" ? "CUSTOM" : preset;
    btn.className =
      "font-body text-sm tracking-[0.15em] uppercase " +
      "px-4 py-3 border transition-colors cursor-pointer " +
      "border-line text-ink-muted hover:text-ink hover:border-ink-muted";
    presetsRow.append(btn);
  }

  // --- Unit input --------------------------------------------------------
  const unitInput = document.createElement("input");
  unitInput.type = "text";
  unitInput.name = "unit";
  unitInput.required = true;
  unitInput.placeholder = "DAYS, KG, HRS...";
  unitInput.setAttribute("aria-label", "Unit");
  unitInput.autocomplete = "off";
  unitInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-2xl font-body tracking-[0.1em] uppercase text-ink w-full text-left " +
    "transition-colors";

  // --- Direction toggle: 3 large buttons in a row -----------------------
  const directionRow = document.createElement("div");
  directionRow.className = "grid grid-cols-3 gap-3";
  directionRow.setAttribute("role", "group");
  directionRow.setAttribute("aria-label", "Direction");

  const directionOptions: ReadonlyArray<{
    value: string;
    label: string;
    defaultActive: boolean;
  }> = [
    { value: "up", label: "↑ MORE", defaultActive: false },
    { value: "down", label: "↓ LESS", defaultActive: false },
    { value: "", label: "— ANY", defaultActive: true },
  ];

  for (const opt of directionOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.direction = opt.value;
    btn.textContent = opt.label;
    const stateClasses = opt.defaultActive
      ? "border-accent text-accent"
      : "border-line text-ink-muted hover:text-ink hover:border-ink-muted";
    btn.className =
      "font-body text-base tracking-[0.15em] uppercase " +
      "px-4 py-3 border transition-colors cursor-pointer " +
      stateClasses;
    directionRow.append(btn);
  }

  // Hidden input that carries the direction value through form submit.
  const directionHidden = document.createElement("input");
  directionHidden.type = "hidden";
  directionHidden.name = "direction";
  directionHidden.value = "";

  // Date
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.name = "date";
  dateInput.required = true;
  dateInput.value = todayISO();
  dateInput.setAttribute("aria-label", "Date");
  dateInput.className =
    "bg-transparent border-b border-line focus:border-accent outline-none " +
    "text-xl font-body tabular-nums text-ink w-full text-left " +
    "scheme-dark transition-colors";

  // Submit — full-width primary yellow button
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className =
    "font-body text-xl tracking-[0.2em] uppercase font-semibold " +
    "text-bg bg-accent hover:bg-accent-deep " +
    "py-4 transition-colors w-full border-t border-line mt-2";
  submit.textContent = "SAVE";

  form.append(
    nameInput,
    valueInput,
    presetsRow,
    unitInput,
    directionRow,
    directionHidden,
    dateInput,
    submit,
  );

  section.append(cancelBtn, title, form);
  return section;
}

/* ---------------------------------------------------------------------------
 * Grid (all records)
 * ------------------------------------------------------------------------- */

function renderGrid(state: AppState): HTMLElement {
  const section = document.createElement("section");
  section.className = "w-full max-w-7xl flex flex-col items-center gap-10";
  section.dataset.grid = "true";
  // Intentionally NOT setting `viewTransitionName: VT_GRID` here. The
  // grid section is part of the root transition (simple fade) — giving
  // it its own named pseudo-element created an extra animated layer
  // whose default timing didn't sync cleanly with the shared-element
  // morph and the root fade, producing a visible wobble. Only the
  // current record's cell carries the shared `view-transition-name`
  // (set in `renderGridCell`), so the browser only has one element to
  // morph: the big focus card into that one small row.

  const title = document.createElement("p");
  title.className =
    "font-body font-semibold text-xs tracking-[0.2em] uppercase text-ink-muted";
  title.textContent = "ALL RECORDS";

  const grid = document.createElement("div");
  grid.className = "w-full flex flex-col";

  const records = state.records;
  records.forEach((record, i) => {
    const isLast = i === records.length - 1;
    grid.append(
      renderGridCell(record, record.id === state.currentRecordId, isLast),
    );
  });

  section.append(title, grid);
  return section;
}

function renderGridCell(
  record: Record,
  isCurrent: boolean,
  isLast: boolean,
): HTMLElement {
  const cell = document.createElement("button");
  cell.type = "button";
  cell.className = [
    "group flex items-baseline justify-between gap-6 py-5 w-full text-left",
    "transition-colors duration-200 cursor-pointer",
    isLast ? "" : "border-b border-line/40",
    "hover:bg-line/[0.04]",
  ]
    .filter(Boolean)
    .join(" ");
  cell.dataset.recordId = record.id;
  if (isCurrent) cell.dataset.currentRecord = "true";
  // No `view-transition-name` on the cell. The grid transition is a simple
  // root crossfade — no shared element morph. The previous "shrink" effect
  // (the browser interpolating the big focus card into this small row)
  // used the browser's automatic size/position interpolation, which has
  // an internal timing that produces a visible wobble on a 400px → 60px
  // size change. A clean root crossfade avoids it entirely.

  const latest = latestEntry(record);
  const previous = previousEntry(record);
  const n = record.entries.length;

  // Left side: name (small, uppercase) + date (tiny, more muted)
  const left = document.createElement("div");
  left.className = "flex flex-col gap-1 min-w-0";

  const name = document.createElement("span");
  name.className =
    "font-body font-semibold text-[0.6875rem] tracking-[0.2em] uppercase text-ink-muted";
  name.textContent = record.name;
  left.append(name);

  const dateLine = document.createElement("span");
  dateLine.className =
    "font-body text-[0.5625rem] tracking-[0.15em] uppercase text-ink-muted/60";
  if (latest) {
    const rel = formatRelativeDate(latest.date).toLowerCase();
    dateLine.textContent = `${rel} · ${n} ${n === 1 ? "entry" : "entries"}`;
  } else {
    dateLine.textContent = "—";
  }
  left.append(dateLine);

  // Right side: value + unit (big, yellow, display font — the hero)
  // + delta (small, accent, tabular nums) + a thin trend sparkline
  // below. The sparkline is intentionally subtle (opacity-60, 48×14)
  // so it adds visual interest without competing with the value.
  const right = document.createElement("div");
  right.className = "flex flex-col items-end gap-1 shrink-0";

  const valueEl = document.createElement("span");
  valueEl.className =
    "font-display font-extrabold text-4xl text-accent tabular-nums leading-none " +
    "transition-transform duration-200 group-hover:scale-[1.03] origin-right";
  valueEl.textContent = latest
    ? `${formatValueForUnit(latest.value, record.unit)} ${record.unit}`
    : "—";
  // Re-introduce the shared element morph for the current record's hero
  // value. Applied to JUST the value element (not the whole cell/section)
  // so the browser morphs the big focus card number into this small row
  // number without the wobble that occurred when the entire section had
  // the view-transition-name.
  if (isCurrent) {
    valueEl.style.viewTransitionName = VT_HERO;
  }
  right.append(valueEl);

  const deltaEl = document.createElement("span");
  deltaEl.className =
    "font-body text-[0.6875rem] tracking-[0.15em] uppercase tabular-nums text-accent/70";
  if (latest && previous) {
    deltaEl.textContent = formatDelta(latest.value, previous.value, record.unit);
  } else {
    deltaEl.textContent = "—";
  }
  right.append(deltaEl);

  // Trend sparkline — 48×14, no latest dot (too small), opacity-60 so
  // it sits beneath the value+delta visually. With < 2 entries, the
  // helper renders a short placeholder line at 0.2 opacity so the
  // layout stays the same.
  const sparkline = renderSparkline(record.entries, {
    width: 48,
    height: 14,
    showLatestDot: false,
    className: "text-accent opacity-60 mt-1",
  });
  right.append(sparkline);

  cell.append(left, right);
  return cell;
}

/* ---------------------------------------------------------------------------
 * Re-exported utilities used by app.ts to detect view-specific elements
 * without re-querying the DOM with a class string.
 * ------------------------------------------------------------------------- */

export const VIEW_ATTRS = {
  focusCard: "data-focus-card",
  newRecord: "data-new-record",
  grid: "data-grid",
  newRecordForm: "data-new-record-form",
  addEntryForm: "data-add-entry-form",
  newEntryToggle: "data-new-entry-toggle",
  deleteRecord: "data-delete-record",
  entryRow: "data-entry-row",
  recordId: "data-record-id",
  currentRecord: "data-current-record",
  entryId: "data-entry-id",
  unitPreset: "data-unit-preset",
  direction: "data-direction",
  entryEditForm: "data-entry-edit-form",
  cancelEdit: "data-cancel-edit",
} as const;
