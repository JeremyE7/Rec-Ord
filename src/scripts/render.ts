/**
 * rec-ord — View renderers
 *
 * Pure functions: each renderer takes the current `AppState` and returns a
 * fresh `HTMLElement` representing the current view. The app module is
 * responsible for swapping the rendered element into `#app` and attaching
 * interaction listeners to it.
 *
 * Renderers use `document.createElement` for predictable, framework-free DOM
 * output. Motion is applied by the GSAP controller after rendering.
 *
 * Every interactive element is a real `<button>` or `<input>`/`<form>`
 * with proper `name`/`type`/`required` and `aria-label`s — keyboard
 * navigation and screen readers work without extra effort.
 */

import type { AppState, Entry, Record, View } from "./types";
import {
  formatDelta,
  formatRelativeDate,
  formatValueForUnit,
  latestEntry,
  previousEntry,
  todayISO,
} from "./record-utils";

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

  const view: View = state.view;
  if (view === "new") return renderNewRecord();
  if (state.records.length === 0) return renderEmpty();
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
  // `Infinity` / `-Infinity` seeds eliminate the need for a special-case
  // `ordered[0]!` — any finite value replaces them on the first iteration.
  let min = Infinity;
  let max = -Infinity;
  for (const e of ordered) {
    if (e.value < min) min = e.value;
    if (e.value > max) max = e.value;
  }
  const range = max - min !== 0 ? max - min : 1;

  // Build the polyline points while remembering the last one for the
  // optional "latest dot" below. Iterating with `.entries()` (instead of
  // `ordered[i]`) keeps us type-safe under `noUncheckedIndexedAccess`.
  const points: string[] = [];
  let lastX = 0;
  let lastY = 0;
  for (const [i, e] of ordered.entries()) {
    const x = (i / (n - 1)) * numericBase;
    const y = 1 + (1 - (e.value - min) / range) * (height - 2);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    lastX = x;
    lastY = y;
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
  section.className = "empty-state";
  section.dataset.focusCard = "true";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "SWIPE RIGHT TO CREATE";

  const title = document.createElement("h1");
  title.className = "empty-state__title";
  title.textContent = "Track the progress that matters.";

  const description = document.createElement("p");
  description.className = "empty-state__description";
  description.textContent =
    "Create a record, add entries over time, and see your direction at a glance.";

  const gestureHint = document.createElement("p");
  gestureHint.className = "gesture-note";
  gestureHint.textContent = "Your data stays private on this device.";

  section.append(eyebrow, title, description, gestureHint);
  return section;
}

/* ---------------------------------------------------------------------------
 * Focus card (collapsed)
 * ------------------------------------------------------------------------- */

function findCurrentRecord(state: AppState): Record | null {
  if (state.currentRecordId === null) return null;
  return state.records.find((r) => r.id === state.currentRecordId) ?? null;
}

function normalizedUnit(unit: string): string {
  return unit.trim().toUpperCase();
}

function valueIncludesUnit(unit: string): boolean {
  return ["HRS", "MIN", "SEC"].includes(normalizedUnit(unit));
}

function formatValueWithUnit(value: number, unit: string): string {
  const normalized = normalizedUnit(unit);
  const formatted = formatValueForUnit(value, normalized);
  return valueIncludesUnit(normalized) ? formatted : `${formatted} ${normalized}`;
}

function renderFocus(state: AppState): HTMLElement {
  const record = findCurrentRecord(state);
  if (record === null) {
    // Defensive: should never reach here (caller checks records.length).
    return renderEmpty();
  }
  const latest = latestEntry(record);
  if (latest === null) return renderEmpty();

  const section = document.createElement("section");
  section.className = "focus-view app-view";
  section.dataset.focusCard = "true";
  section.append(renderFocusInner(record, latest, false));

  return section;
}

function renderFocusInner(record: Record, latest: Entry, expanded: boolean): HTMLElement {
  // Collapsed mode distributes overview data across the available height.
  // Expanded mode keeps a compact summary above the independently scrollable
  // entry history and forms.
  const inner = document.createElement("div");
  if (expanded) {
    inner.className = "record-summary record-summary--expanded";
  } else {
    // The inner fills the section's height (the section is `h-full`
    // and inner is the only child with `flex-1` in a flex column).
    // Children: top area (context + trend + sparkline), flex-1 spacer,
    // bottom area (hero + stats). The spacer takes the leftover
    // vertical space and pushes the bottom area to the bottom edge.
    // (`justify-end` is not used here — the spacer is the mechanism,
    // and it cooperates with the `gap-8` to keep the top and bottom
    // areas at least 32px apart.)
    inner.className = "record-summary";
  }

  if (expanded) {
    // Edit / expanded view: hero at the top-center, stats below the
    // hero (only when there is a baseline entry — the expanded
    // history list already provides the per-entry detail). No
    // trend indicator and no sparkline here.
    inner.append(renderHero(record, latest, true));
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
    top.dataset.motionLayer = "context";

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
    bottom.dataset.motionLayer = "hero";
    bottom.append(renderHero(record, latest, false));
    bottom.append(renderStats(record, latest, prev));
    inner.append(bottom);
  }

  return inner;
}

function renderContextLabel(record: Record): HTMLElement {
  const context = document.createElement("div");
  context.className = "flex items-center gap-4";

  const bar = document.createElement("span");
  bar.className = "block w-2 h-2 rounded-full bg-accent shadow-[0_0_18px_rgba(244,201,93,0.42)]";
  bar.setAttribute("aria-hidden", "true");

  const label = document.createElement("p");
  label.className =
    "font-body font-semibold text-xs tracking-[0.2em] uppercase text-ink-muted";
  label.textContent = record.name.toUpperCase();
  label.dataset.flipId = `record-label-${record.id}`;

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

function renderHero(record: Record, latest: Entry, compact: boolean): HTMLElement {
  // Hero: the DOMINANT visual element. The value is huge, left-aligned,
  // and the first thing the eye sees. The unit sits below as a secondary
  // label. The direction indicator (if any) is a small badge.
  //
  // The value stays on one visible line even while Flip interpolates its
  // width. Allowing word breaks here makes multi-character values stack
  // vertically while the animated width is still narrower than the glyphs.
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
    `hero-value-wrap ${compact ? "hero-value-wrap--compact" : ""}`;
  if (compact) heroWrap.dataset.motionLayer = "hero";

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

  // Value: the dominant number. `data-hero` is the GSAP celebration hook
  // when a new entry becomes a personal best.
  //
  // `whitespace-nowrap`, normal overflow wrapping, and visible overflow are
  // intentionally scoped to this main hero value; grid/list values keep their
  // own layout behavior.
  // Time units (HRS, MIN, SEC) use a SMALLER font ("1h 30m" is wider
  // than "30" so a smaller size keeps the hero visually balanced with
  // the integer/decimal records). Everything else uses the standard
  // hero size.
  const isTimeUnit = record.unit.toUpperCase().trim() === "HRS" ||
                     record.unit.toUpperCase().trim() === "MIN" ||
                     record.unit.toUpperCase().trim() === "SEC";
  const heroFontSize = isTimeUnit
    ? compact
      ? "text-[clamp(3.75rem,18vw,6rem)]"
      : "text-[clamp(5.5rem,24vw,11rem)]"
    : compact
      ? "text-[clamp(4.5rem,22vw,8rem)]"
      : "text-[clamp(7rem,38vw,20rem)]";
  const value = document.createElement("h1");
  value.id = "hero-value";
  value.dataset.hero = "true";
  value.className = `font-display font-black leading-[0.85] tracking-[-0.05em] text-accent ${heroFontSize} tabular-nums max-w-full min-w-0 whitespace-nowrap [overflow-wrap:normal] overflow-visible`;
  value.textContent = formatValueForUnit(latest.value, record.unit);
  value.dataset.flipId = `record-value-${record.id}`;

  // Unit: displayed BELOW the value as a secondary label.
  const unit = document.createElement("div");
  unit.className = compact
    ? "font-body text-sm tracking-[0.2em] uppercase text-ink-muted mt-1"
    : "font-body text-xl tracking-[0.2em] uppercase text-ink-muted mt-2";
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
  stats.className = "stats-grid";

  const previousCol = document.createElement("div");
  previousCol.className = "stat-item";
  const previousLabel = document.createElement("span");
  previousLabel.className = "stat-label";
  previousLabel.textContent = "PREVIOUS";
  const previousValue = document.createElement("span");
  previousValue.className = "stat-value";
  previousValue.textContent =
    previous !== null
    ? formatValueWithUnit(previous.value, record.unit)
    : "—";
  previousCol.append(previousLabel, previousValue);

  const changeCol = document.createElement("div");
  changeCol.className = "stat-item";
  const changeLabel = document.createElement("span");
  changeLabel.className = "stat-label";
  changeLabel.textContent = "CHANGE";
  const changeValue = document.createElement("span");
  changeValue.className = "stat-value stat-value--accent";
  changeValue.textContent =
    previous !== null
      ? formatDelta(latest.value, previous.value, record.unit)
      : "—";
  changeCol.append(changeLabel, changeValue);

  stats.append(previousCol, changeCol);
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
  section.className = "expanded-view app-view";
  section.dataset.focusCard = "true";

  const header = document.createElement("header");
  header.className = "view-header";
  header.dataset.motionLayer = "header";
  const heading = document.createElement("div");
  heading.className = "view-header__heading";
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "SWIPE DOWN TO CLOSE";
  const title = document.createElement("h2");
  title.className = "view-header__title";
  title.textContent = record.name;
  heading.append(eyebrow, title);
  header.append(heading);

  section.append(header, renderFocusInner(record, latest, true));

  // Entry controls and history share one bounded native scroll region.
  const expandedWrap = document.createElement("div");
  expandedWrap.className = "expanded-content scroll-region";
  expandedWrap.dataset.motionLayer = "details";

  // The newest entry is already represented by the hero value.
  const list = document.createElement("ul");
  list.className = "entry-list";

  const history = record.entries.slice(1);
  for (const entry of history) {
    list.append(renderEntryRow(entry, record));
  }

  // The composer stays above history so adding an entry never requires
  // scrolling through the entire record first.
  const addWrap = document.createElement("div");
  addWrap.className = "entry-composer";

  if (state.addingEntry) {
    addWrap.append(renderInlineAddEntryForm(record));
  } else {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "button button--primary button--compact";
    toggle.textContent = "ADD ENTRY";
    toggle.dataset.newEntryToggle = "true";
    addWrap.append(toggle);
  }
  expandedWrap.append(addWrap, list);

  // DELETE RECORD (two-tap)
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  const inConfirm = isDeleteConfirmArmed(record.id);
  deleteBtn.className =
    "button button--danger button--compact";
  if (inConfirm) {
    deleteBtn.classList.add("button--danger-confirm");
  }
  deleteBtn.textContent = inConfirm ? "CONFIRM DELETE" : "DELETE RECORD";
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
  li.className = "entry-row";
  li.dataset.entryId = entry.id;
  li.dataset.entryRow = "true";
  li.setAttribute(
    "aria-label",
    `Entry: ${formatValueWithUnit(entry.value, record.unit)}, ${formatRelativeDate(entry.date).toLowerCase()}. Press Enter to edit or swipe left to delete.`,
  );

  if (editingEntryId === entry.id) {
    li.classList.add("entry-row--editing");
    li.append(renderEntryEditForm(entry, record));
    return li;
  }

  li.tabIndex = 0;
  li.setAttribute("role", "button");

  const left = document.createElement("span");
  left.className = "font-body font-medium tabular-nums";
  left.textContent = formatValueWithUnit(entry.value, record.unit);

  const rightWrap = document.createElement("span");
  rightWrap.className = "flex items-center gap-3";

  const right = document.createElement("span");
  right.className =
    "font-body text-xs uppercase tracking-[0.1em] text-ink-muted";
  right.textContent = formatRelativeDate(entry.date);

  // Visible affordance for the optional destructive gesture.
  const hint = document.createElement("span");
  hint.className = "entry-row__hint";
  hint.textContent = "SWIPE LEFT";
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

function renderField(
  labelText: string,
  input: HTMLInputElement,
  hint?: string,
  compact = false,
): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = compact ? "form-field form-field--compact" : "form-field";

  const header = document.createElement("span");
  header.className = "form-field__header";
  const name = document.createElement("span");
  name.className = "form-field__label";
  name.textContent = labelText;
  header.append(name);

  if (hint !== undefined) {
    const hintElement = document.createElement("span");
    hintElement.className = "form-field__hint";
    hintElement.textContent = hint;
    header.append(hintElement);
  }

  label.append(header, input);
  return label;
}

function renderEntryEditForm(entry: Entry, record: Record): HTMLElement {
  const form = document.createElement("form");
  form.className = "entry-edit-form";
  form.dataset.entryEditForm = "true";
  form.dataset.entryId = entry.id;
  form.dataset.motionLayer = "local";

  // --- Top row: value + unit + date ---------------------------------------
  const topRow = document.createElement("div");
  topRow.className = "form-grid form-grid--compact";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.value = String(entry.value);
  valueInput.inputMode = "decimal";
  valueInput.className = "field-input field-input--compact tabular-nums";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.name = "date";
  dateInput.required = true;
  dateInput.value = entry.date;
  dateInput.className = "field-input field-input--compact tabular-nums scheme-dark";

  topRow.append(
    renderField("VALUE", valueInput, record.unit, true),
    renderField("DATE", dateInput, undefined, true),
  );

  // --- Bottom row: SAVE + CANCEL ------------------------------------------
  const bottomRow = document.createElement("div");
  bottomRow.className = "form-actions form-actions--compact";

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button button--primary button--compact";
  save.textContent = "SAVE";

  bottomRow.append(save);

  form.append(topRow, bottomRow);
  return form;
}

/* ---------------------------------------------------------------------------
 * Inline add-entry form (inside the expanded focus)
 * ------------------------------------------------------------------------- */

function renderInlineAddEntryForm(record: Record): HTMLElement {
  const form = document.createElement("form");
  form.className = "entry-form app-surface";
  form.dataset.addEntryForm = "true";
  form.dataset.motionLayer = "local";

  const heading = document.createElement("div");
  heading.className = "form-heading";
  const title = document.createElement("h3");
  title.className = "form-heading__title";
  title.textContent = "New entry";
  const description = document.createElement("p");
  description.className = "form-heading__description";
  description.textContent = `Add the latest value for ${record.name}.`;
  heading.append(title, description);

  const fields = document.createElement("div");
  fields.className = "form-grid";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.placeholder = "0";
  valueInput.inputMode = "decimal";
  valueInput.className = "field-input field-input--large tabular-nums";

  // Date input
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.name = "date";
  dateInput.required = true;
  dateInput.value = todayISO();
  dateInput.className = "field-input tabular-nums scheme-dark";

  // Submit
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "button button--primary";
  submit.textContent = "SAVE ENTRY";

  fields.append(
    renderField("VALUE", valueInput, record.unit),
    renderField("DATE", dateInput),
  );
  form.append(heading, fields, submit);
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
  section.className = "new-record-view app-view";
  section.dataset.newRecord = "true";

  const header = document.createElement("header");
  header.className = "view-header";
  header.dataset.motionLayer = "header";
  const heading = document.createElement("div");
  heading.className = "view-header__heading";
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "SWIPE LEFT TO CLOSE";
  const title = document.createElement("h1");
  title.className = "view-header__title";
  title.textContent = "New record";
  heading.append(eyebrow, title);
  header.append(heading);

  const form = document.createElement("form");
  // The form owns vertical scrolling so it remains usable when the virtual
  // keyboard reduces the visual viewport.
  form.className = "record-form scroll-region";
  form.id = "new-record-form";
  form.dataset.newRecordForm = "true";
  form.dataset.motionLayer = "form";

  // Name — big and prominent
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.name = "name";
  nameInput.required = true;
  nameInput.placeholder = "e.g. Days without smoking";
  nameInput.autocomplete = "off";
  nameInput.className = "field-input field-input--large";

  // Value — HUGE, yellow, the centerpiece
  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.name = "value";
  valueInput.required = true;
  valueInput.step = "any";
  valueInput.placeholder = "0";
  valueInput.inputMode = "decimal";
  valueInput.className = "field-input field-input--hero tabular-nums";

  // --- Unit preset picker: 3-column grid of large pill buttons --------
  const presetsRow = document.createElement("div");
  presetsRow.className = "option-grid option-grid--units";
  presetsRow.dataset.unitPresets = "true";
  presetsRow.setAttribute("role", "group");
  presetsRow.setAttribute("aria-label", "Unit preset");

  for (const preset of UNIT_PRESETS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.unitPreset = preset;
    btn.textContent = preset === "" ? "CUSTOM" : preset;
    btn.className = "option-pill border-line text-ink-muted hover:text-ink hover:border-ink-muted";
    btn.setAttribute("aria-pressed", "false");
    presetsRow.append(btn);
  }

  // --- Unit input --------------------------------------------------------
  const unitInput = document.createElement("input");
  unitInput.type = "text";
  unitInput.name = "unit";
  unitInput.required = true;
  unitInput.placeholder = "DAYS, KG, HRS...";
  unitInput.autocomplete = "off";
  unitInput.className = "field-input uppercase";

  // --- Direction toggle: 3 large buttons in a row -----------------------
  const directionRow = document.createElement("div");
  directionRow.className = "option-grid option-grid--direction";
  directionRow.dataset.directionToggle = "true";
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
    btn.className = `option-pill ${stateClasses}`;
    btn.setAttribute("aria-pressed", String(opt.defaultActive));
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
  dateInput.className = "field-input tabular-nums scheme-dark";

  // Submit — full-width primary yellow button
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.setAttribute("form", form.id);
  submit.className = "button button--primary button--large";
  submit.textContent = "CREATE RECORD";

  const intro = document.createElement("p");
  intro.className = "record-form__intro";
  intro.textContent =
    "Define what you want to track. You can change individual entries later.";

  const essentials = document.createElement("div");
  essentials.className = "form-grid form-grid--essentials";
  essentials.append(
    renderField("RECORD NAME", nameInput, "Keep it short and specific"),
    renderField("STARTING VALUE", valueInput, "Your first entry"),
  );

  const presetsGroup = document.createElement("fieldset");
  presetsGroup.className = "form-section";
  const presetsLegend = document.createElement("legend");
  presetsLegend.className = "form-field__label";
  presetsLegend.textContent = "UNIT PRESET";
  presetsGroup.append(presetsLegend, presetsRow);

  const directionGroup = document.createElement("fieldset");
  directionGroup.className = "form-section";
  const directionLegend = document.createElement("legend");
  directionLegend.className = "form-field__label";
  directionLegend.textContent = "WHAT COUNTS AS PROGRESS?";
  directionGroup.append(directionLegend, directionRow, directionHidden);

  const details = document.createElement("div");
  details.className = "form-grid";
  details.append(
    renderField("UNIT", unitInput, "Choose a preset or enter your own"),
    renderField("START DATE", dateInput),
  );

  const footer = document.createElement("div");
  footer.className = "record-form__footer";
  footer.dataset.motionLayer = "footer";
  footer.append(submit);

  form.append(intro, essentials, presetsGroup, details, directionGroup);
  section.append(header, form, footer);
  return section;
}

/* ---------------------------------------------------------------------------
 * Grid (all records)
 * ------------------------------------------------------------------------- */

function renderGrid(state: AppState): HTMLElement {
  const section = document.createElement("section");
  section.className = "grid-view app-view scroll-region";
  section.dataset.grid = "true";

  const header = document.createElement("header");
  header.className = "view-header";
  header.dataset.motionLayer = "header";
  const heading = document.createElement("div");
  heading.className = "view-header__heading";
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "TAP A RECORD TO FOCUS";
  const title = document.createElement("h1");
  title.className = "view-header__title";
  title.textContent = `${state.records.length} ${state.records.length === 1 ? "record" : "records"}`;
  heading.append(eyebrow, title);
  header.append(heading);

  const grid = document.createElement("div");
  grid.className = "records-list app-surface";

  const records = state.records;
  records.forEach((record, i) => {
    const isLast = i === records.length - 1;
    grid.append(
      renderGridCell(record, record.id === state.currentRecordId, isLast),
    );
  });

  section.append(header, grid);
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
    "record-list-item group",
    isCurrent ? "record-list-item--current" : "",
    isLast ? "record-list-item--last" : "",
  ]
    .filter(Boolean)
    .join(" ");
  cell.dataset.recordId = record.id;
  cell.dataset.motionLayer = "grid-item";
  cell.setAttribute("aria-label", `Focus ${record.name}`);
  if (isCurrent) {
    cell.dataset.currentRecord = "true";
    cell.setAttribute("aria-current", "true");
  }

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
  name.dataset.flipId = `record-label-${record.id}`;
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

  const valueLine = document.createElement("span");
  valueLine.className =
    "font-display font-extrabold text-4xl text-accent tabular-nums leading-none " +
    "whitespace-nowrap transition-transform duration-200 group-hover:scale-[1.03] origin-right";

  const valueEl = document.createElement("span");
  valueEl.textContent = latest
    ? formatValueForUnit(latest.value, record.unit)
    : "—";
  valueEl.dataset.flipId = `record-value-${record.id}`;
  valueLine.append(valueEl);

  if (latest && !valueIncludesUnit(record.unit)) {
    const unitEl = document.createElement("span");
    unitEl.className = "ml-[0.18em]";
    unitEl.textContent = normalizedUnit(record.unit);
    valueLine.append(unitEl);
  }

  right.append(valueLine);

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
} as const;
