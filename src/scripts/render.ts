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
import { formatDelta, formatRelativeDate, formatValue, latestEntry, previousEntry, todayISO } from "./motion";

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
 * model — it's UI state for the two-tap delete confirmation). We keep it
 * here in module scope; it survives re-renders within the session and
 * resets on reload.
 * ------------------------------------------------------------------------- */

interface DeleteConfirmLocal {
  recordId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const deleteConfirm: DeleteConfirmLocal = { recordId: null, timer: null };

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
  const section = document.createElement("section");
  section.className =
    "relative w-full max-w-7xl flex flex-col items-start gap-10 px-4 sm:px-8";
  section.dataset.focusCard = "true";
  section.style.viewTransitionName = VT_RECORD_CARD;

  // Current card content (context label + hero + stats, when applicable).
  section.append(renderFocusInner(record, latest));

  return section;
}

function renderFocusInner(record: Record, latest: Entry): HTMLElement {
  // Full card content: context + hero + stats. The wrapper section
  // (collapsed focus and expanded focus) adds `data-focus-card` and the
  // shared `view-transition-name: record-card`, so the browser pairs the
  // two on long-press / collapse and morphs the height/content.
  const inner = document.createElement("div");
  inner.className = "flex flex-col items-start text-left gap-10 w-full";

  // Context label
  inner.append(renderContextLabel(record));

  // Hero (value + unit + optional direction indicator)
  inner.append(renderHero(record, latest));

  // Stats row (PREVIOUS + CHANGE) — only when there is a baseline entry.
  const prev = previousEntry(record);
  if (prev !== null) {
    inner.append(renderStats(record, latest, prev));
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

function renderHero(record: Record, latest: Entry): HTMLElement {
  // Hero: the DOMINANT visual element. The value is huge, left-aligned,
  // and the first thing the eye sees. The unit sits below as a secondary
  // label. The direction indicator (if any) is a small badge.
  const heroWrap = document.createElement("div");
  heroWrap.className = "relative flex flex-col items-start text-left w-full";
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
  // leading and tracking. No text-shadow — the big yellow number is
  // striking enough on its own against the dark background.
  const value = document.createElement("h1");
  value.id = "hero-value";
  value.className =
    "font-display font-black leading-[0.85] tracking-[-0.05em] text-accent " +
    "text-[clamp(12rem,52vw,28rem)] tabular-nums";
  value.textContent = formatValue(latest.value);

  // Unit: displayed BELOW the value as a secondary label.
  const unit = document.createElement("div");
  unit.className =
    "font-body text-2xl tracking-[0.2em] uppercase text-ink-muted mt-2";
  unit.textContent = record.unit;

  heroWrap.append(value, unit);
  return heroWrap;
}

function renderStats(record: Record, latest: Entry, prev: Entry): HTMLElement {
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
  previousValue.textContent = `${formatValue(prev.value)} ${record.unit}`;
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
  changeValue.textContent = formatDelta(latest.value, prev.value, record.unit);
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
  section.className = "w-full max-w-7xl flex flex-col items-start gap-10 px-4 sm:px-8";
  section.dataset.focusCard = "true";
  section.style.viewTransitionName = VT_RECORD_CARD;

  section.append(renderFocusInner(record, latest));

  // --- Expanded content (entries history + add-entry form + delete) -----
  const expandedWrap = document.createElement("div");
  expandedWrap.className = "w-full flex flex-col items-start gap-6 pt-8";

  // Entries history (newest first; the latest is index 0 and is the
  // hero, so we show entries[1..] in the history. The latest is hidden
  // because it IS the hero.)
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
  addWrap.className = "w-full max-w-md flex flex-col items-start gap-4";

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
    "text-ink-muted/50 hover:text-ink-muted transition-colors";
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
 * ------------------------------------------------------------------------- */

function renderEntryRow(entry: Entry, record: Record): HTMLElement {
  const li = document.createElement("li");
  li.className =
    "flex items-center justify-between gap-4 py-2 border-b border-line/40 text-ink";
  li.dataset.entryId = entry.id;
  li.dataset.entryRow = "true";
  li.setAttribute("aria-label", `Entry: ${formatValue(entry.value)} ${record.unit}, ${formatRelativeDate(entry.date).toLowerCase()}`);

  const left = document.createElement("span");
  left.className = "font-body font-medium tabular-nums";
  left.textContent = `${formatValue(entry.value)} ${record.unit}`;

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
  section.className = "w-full max-w-7xl flex flex-col items-start gap-10 px-4 sm:px-8";
  section.dataset.newRecord = "true";
  section.style.viewTransitionName = VT_NEW_RECORD;

  // Cancel button at the top-right. The form is opened by swipe-right,
  // so there's no other way to close it without swiping left — this
  // gives a clear tap target.
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.dataset.action = "close-new";
  cancelBtn.className =
    "self-end font-body text-xs tracking-[0.2em] uppercase text-ink-muted " +
    "hover:text-ink transition-colors";
  cancelBtn.textContent = "CANCEL";

  // Title with top border for visual separation.
  const title = document.createElement("p");
  title.className =
    "font-body font-semibold text-2xl tracking-[0.2em] uppercase text-ink-muted " +
    "w-full pb-4 border-b border-line";
  title.textContent = "NEW RECORD";

  const form = document.createElement("form");
  form.className = "w-full max-w-2xl flex flex-col gap-8 text-left";
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
  // + delta (small, accent, tabular nums) below
  const right = document.createElement("div");
  right.className = "flex flex-col items-end gap-1 shrink-0";

  const valueEl = document.createElement("span");
  valueEl.className =
    "font-display font-extrabold text-4xl text-accent tabular-nums leading-none " +
    "transition-transform duration-200 group-hover:scale-[1.03] origin-right";
  valueEl.textContent = latest
    ? `${formatValue(latest.value)} ${record.unit}`
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
} as const;
