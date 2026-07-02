/**
 * rec-ord — Application entry point
 *
 * Wires together the store, persistence, gesture handlers, and view
 * renderers. The single source of truth is the `AppState` in `store.ts`;
 * everything else is a pure function of that state.
 *
 * Boot sequence:
 *   1. Load persisted records from localStorage.
 *   2. Build the initial AppState (records + currentRecordId from
 *      persistence; view = "focus", expanded = false, addingEntry = false).
 *   3. Mount the rendered app into `#app` and attach gestures.
 *   4. Subscribe to store changes: on every mutation, debounce-save
 *      and re-render the app.
 *
 * Re-entry on `astro:page-load`: the same `init` runs again after a
 * teardown that disposes the previous instance's listeners and gesture
 * bindings — so the app re-attaches cleanly after any future Astro
 * navigation. (The shell itself never navigates — it's a single page —
 * but the hook is the right one to use so future Astro client-side
 * routing still works.)
 *
 * Important: the store subscriber performs a PLAIN DOM update
 * (`updateDOM`). It does NOT wrap that update in another `commit` call.
 * Every state-changing call site that wants a specific view transition
 * wraps its `setState` in `commit(...)` itself; the resulting
 * `setState` → subscriber → `updateDOM` chain runs inside that
 * callback, so the DOM swap is captured by `startViewTransition` exactly
 * once. Nesting `commit` calls (outer + inner view transition) is not
 * supported by the View Transitions API — the inner one would either
 * throw or queue behind the outer one, producing a perceptible lag.
 */

import { flushSave, getSeedData, loadState, normalize, saveState } from "./persistence";
import { animateHero } from "./countup";
import { attachGestures, attachRowSwipe, type GestureHandlers } from "./gestures";
import { commit, makeEntry, makeRecord, sortEntries } from "./motion";
import { armDeleteConfirm, consumeDeleteConfirm, onRerender, renderApp, VIEW_ATTRS } from "./render";
import { getState, initState, setState, subscribe } from "./store";
import type { AppState, Entry, Record } from "./types";

const APP_ID = "app";

/* ---------------------------------------------------------------------------
 * State helpers
 * ------------------------------------------------------------------------- */

function currentRecord(state: AppState): Record | null {
  if (state.currentRecordId === null) return null;
  return state.records.find((r) => r.id === state.currentRecordId) ?? null;
}

function currentIndex(state: AppState): number {
  return state.records.findIndex((r) => r.id === state.currentRecordId);
}

/* ---------------------------------------------------------------------------
 * DOM updates
 *
 * Two helpers, used in different places:
 *
 *   - `updateDOM()` is the plain DOM swap. It runs INSIDE a `commit(...)`
 *     callback from the caller, so `startViewTransition` snapshots the
 *     new DOM after it has been swapped in. This is what every
 *     state-changing code path (gesture handlers, form submits, button
 *     clicks) ends up calling via the store subscriber.
 *
 *   - `rerender()` is the "default fade" wrapper — use it for the one
 *     case where the UI must re-render without a corresponding state
 *     change (the delete-record two-tap label flip). It commits the
 *     DOM swap with the generic "fade" transition name.
 * ------------------------------------------------------------------------- */

function updateDOM(): void {
  const mount = document.getElementById(APP_ID);
  if (mount === null) return;
  const fresh = renderApp(getState());
  mount.replaceChildren(fresh);
  wire(mount);

  // Animate the hero value count-up after the DOM swap. Reset the hero's
  // textContent to "0" BEFORE calling animateHero so the countup always
  // starts from zero (the scoreboard effect — "rolling from zero every
  // time the record changes"). If either the element or the value is
  // missing, we skip silently.
  const hero = document.getElementById("hero-value");
  if (hero !== null) {
    const state = getState();
    const record = state.records.find((r) => r.id === state.currentRecordId);
    if (record !== undefined && record.entries.length > 0) {
      hero.textContent = "0";
      void animateHero(hero, record.entries[0]!.value);
    }
  }
}

function rerender(): void {
  commit(() => updateDOM(), "fade");
}

/* ---------------------------------------------------------------------------
 * Wire up interactions on a freshly-rendered root
 * ------------------------------------------------------------------------- */

function wire(root: HTMLElement): void {
  // Forms: new-record + inline add-entry
  const newRecordForm = root.querySelector<HTMLFormElement>(`[${VIEW_ATTRS.newRecordForm}]`);
  if (newRecordForm !== null) {
    newRecordForm.addEventListener("submit", onNewRecordSubmit);
  }

  const addEntryForm = root.querySelector<HTMLFormElement>(`[${VIEW_ATTRS.addEntryForm}]`);
  if (addEntryForm !== null) {
    addEntryForm.addEventListener("submit", onAddEntrySubmit);
  }

  // Unit preset picker (inside the new-record form)
  const unitPresets = root.querySelectorAll<HTMLButtonElement>(`[${VIEW_ATTRS.unitPreset}]`);
  unitPresets.forEach((btn) => {
    btn.addEventListener("click", onUnitPresetClick);
  });

  // Direction toggle (inside the new-record form)
  const directionButtons = root.querySelectorAll<HTMLButtonElement>(`[${VIEW_ATTRS.direction}]`);
  directionButtons.forEach((btn) => {
    btn.addEventListener("click", onDirectionClick);
  });

  // "+ NEW ENTRY" toggle button (collapsed → open inline form)
  const newEntryToggle = root.querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.newEntryToggle}]`);
  if (newEntryToggle !== null) {
    newEntryToggle.addEventListener("click", onNewEntryToggleClick);
  }

  // DELETE RECORD two-tap
  const deleteBtn = root.querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.deleteRecord}]`);
  if (deleteBtn !== null) {
    deleteBtn.addEventListener("click", onDeleteRecordClick);
  }

  // Grid cell taps
  const cells = root.querySelectorAll<HTMLButtonElement>(`button[${VIEW_ATTRS.recordId}]`);
  cells.forEach((cell) => {
    cell.addEventListener("click", onGridCellClick);
  });

  // Entry rows: swipe-to-delete
  const rows = root.querySelectorAll<HTMLLIElement>(`li[${VIEW_ATTRS.entryRow}]`);
  rows.forEach((row) => {
    const entryId = row.getAttribute(VIEW_ATTRS.entryId);
    if (entryId === null) return;
    attachRowSwipe(row, {
      onDelete: () => deleteEntry(entryId),
    });
  });

  // "LOAD EXAMPLES" button (empty state → populate with seed data)
  const loadExamplesBtn = root.querySelector<HTMLButtonElement>('[data-action="load-examples"]');
  if (loadExamplesBtn !== null) {
    loadExamplesBtn.addEventListener("click", loadExamples);
  }

  // "CANCEL" button in the new-record form (close form, return to focus)
  const closeNewBtn = root.querySelector<HTMLButtonElement>('[data-action="close-new"]');
  if (closeNewBtn !== null) {
    closeNewBtn.addEventListener("click", () => closeNewRecord());
  }
}

/* ---------------------------------------------------------------------------
 * Form + button handlers
 * ------------------------------------------------------------------------- */

/** Toggles the active visual state on a group of pill buttons (the
 *  preset row or the direction toggle). The button matching `active`
 *  gets the accent classes; the others get the muted classes. */
function setActivePill(buttons: NodeListOf<HTMLButtonElement>, active: HTMLButtonElement): void {
  const ACTIVE = ["border-accent", "text-accent"] as const;
  const INACTIVE = ["border-line", "text-ink-muted", "hover:text-ink", "hover:border-ink-muted"] as const;
  buttons.forEach((b) => {
    const isActive = b === active;
    for (const cls of ACTIVE) b.classList.toggle(cls, isActive);
    for (const cls of INACTIVE) b.classList.toggle(cls, !isActive);
  });
}

function onUnitPresetClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const preset = btn.getAttribute(VIEW_ATTRS.unitPreset) ?? "";
  const form = btn.closest("form");
  if (form === null) return;
  const unitInput = form.querySelector<HTMLInputElement>('input[name="unit"]');
  if (unitInput === null) return;
  unitInput.value = preset;
  if (preset === "") {
    // CUSTOM: clear and focus so the user can type a free-text unit.
    unitInput.focus();
  }
  // Update the active highlight across the whole preset row.
  const row = form.querySelector<HTMLDivElement>(
    `[data-unit-presets], [aria-label="Unit preset"]`,
  );
  if (row !== null) {
    const all = row.querySelectorAll<HTMLButtonElement>(`[${VIEW_ATTRS.unitPreset}]`);
    setActivePill(all, btn);
  }
}

function onDirectionClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const direction = btn.getAttribute(VIEW_ATTRS.direction) ?? "";
  const form = btn.closest("form");
  if (form === null) return;
  const hidden = form.querySelector<HTMLInputElement>('input[type="hidden"][name="direction"]');
  if (hidden === null) return;
  hidden.value = direction;
  // Update the active highlight across the whole direction row.
  const row = form.querySelector<HTMLDivElement>(
    `[data-direction-toggle], [aria-label="Direction"]`,
  );
  if (row !== null) {
    const all = row.querySelectorAll<HTMLButtonElement>(`[${VIEW_ATTRS.direction}]`);
    setActivePill(all, btn);
  }
}

function onNewRecordSubmit(e: SubmitEvent): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const valueRaw = data.get("value");
  const unit = String(data.get("unit") ?? "").trim().toUpperCase();
  const date = String(data.get("date") ?? "");
  // Direction is stored in a hidden input. Empty string = no preference.
  const directionRaw = String(data.get("direction") ?? "");
  const direction: "up" | "down" | null =
    directionRaw === "up" || directionRaw === "down" ? directionRaw : null;
  if (name === "" || unit === "" || date === "" || valueRaw === null) return;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return;

  const firstEntry: Entry = makeEntry(value, date);
  const record: Record = makeRecord(name, unit, firstEntry, direction);
  // New records go to the front (most recently created at index 0).
  commit(() => {
    setState((prev) => ({
      records: [record, ...prev.records],
      currentRecordId: record.id,
      view: "focus",
      expanded: false,
      addingEntry: false,
    }));
  }, "nav-vertical");
}

function onAddEntrySubmit(e: SubmitEvent): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const valueRaw = data.get("value");
  const date = String(data.get("date") ?? "");
  if (date === "" || valueRaw === null) return;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return;

  commit(() => {
    setState((prev) => {
      const record = currentRecord(prev);
      if (record === null) return prev;
      const newEntry: Entry = makeEntry(value, date);
      const newEntries = sortEntries([newEntry, ...record.entries]);
      const updated: Record = { ...record, entries: newEntries };
      return {
        records: prev.records.map((r) => (r.id === record.id ? updated : r)),
        addingEntry: false,
      };
    });
  }, "fade");
}

function onNewEntryToggleClick(): void {
  // The toggle button doubles as the form's cancel control: when the
  // inline form is open, its label is "CANCEL" and tapping it closes
  // the form (keeping the edit expansion). When the form is closed,
  // the label is "+ NEW ENTRY" and tapping it opens the form.
  commit(() => {
    setState((prev) => ({ addingEntry: !prev.addingEntry }));
  }, "fade");
}

function onDeleteRecordClick(e: MouseEvent): void {
  void e; // currently unused — the action is determined solely by the
  // render module's delete-confirm state.
  const state = getState();
  const record = currentRecord(state);
  if (record === null) return;

  if (consumeDeleteConfirm(record.id)) {
    // Second tap within 2.5s — actually delete.
    performDeleteRecord();
    return;
  }

  // First tap — arm the confirm. The render module's `armDeleteConfirm`
  // starts a 2.5s timer that calls `rec-ord:rerender` on expiry. We
  // also need to re-render RIGHT NOW so the button label flips to
  // "TAP TO CONFIRM". A direct call to `rerender()` does that with a
  // brief fade.
  armDeleteConfirm(record.id);
  rerender();
}

function performDeleteRecord(): void {
  const state = getState();
  const record = currentRecord(state);
  if (record === null) return;

  // If it's the only record, the empty state is the destination.
  if (state.records.length === 1) {
    commit(() => {
      setState({
        records: [],
        currentRecordId: null,
        view: "focus",
        expanded: false,
        addingEntry: false,
      });
    }, "nav-vertical");
    return;
  }

  // Pick the neighbor: prefer the next-newer record (index - 1), fall
  // back to the next-older one (index + 1) if we were the first.
  const idx = currentIndex(state);
  const neighbor = state.records[idx - 1] ?? state.records[idx + 1] ?? null;

  commit(() => {
    setState({
      records: state.records.filter((r) => r.id !== record.id),
      currentRecordId: neighbor ? neighbor.id : null,
      view: "focus",
      expanded: false,
      addingEntry: false,
    });
  }, "nav-vertical");
}

function onGridCellClick(e: MouseEvent): void {
  const cell = e.currentTarget as HTMLButtonElement;
  const recordId = cell.getAttribute(VIEW_ATTRS.recordId);
  if (recordId === null) return;
  commit(() => {
    setState({
      currentRecordId: recordId,
      view: "focus",
      expanded: false,
      addingEntry: false,
    });
  }, "scale-morph");
}

function deleteEntry(entryId: string): void {
  const state = getState();
  const record = currentRecord(state);
  if (record === null) return;
  if (record.entries.length <= 1) {
    // Can't delete the last entry — instead, delete the record (mirrors
    // the common "remove the only measurement" intent).
    performDeleteRecord();
    return;
  }
  commit(() => {
    setState((prev) => {
      const r = currentRecord(prev);
      if (r === null) return prev;
      const updated: Record = { ...r, entries: r.entries.filter((e) => e.id !== entryId) };
      return { records: prev.records.map((x) => (x.id === r.id ? updated : x)) };
    });
  }, "fade");
}

/* ---------------------------------------------------------------------------
 * Named action functions
 *
 * Single source of truth for every navigation/view-change action. The
 * gesture handlers below wrap these, and the keyboard handler dispatches
 * to them too. Each function returns `true` when a commit happened
 * (used by the gesture handler to decide spring-back vs leave-in-place)
 * and `false` when the action was not applicable in the current state.
 * ------------------------------------------------------------------------- */

function goToNextRecord(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded) return false;
  const idx = currentIndex(state);
  const next = state.records[idx + 1];
  if (!next) return false; // last/oldest — spring back
  commit(() => {
    setState({ currentRecordId: next.id });
  }, "nav-vertical");
  return true;
}

function goToPreviousRecord(): boolean {
  const state = getState();
  if (state.view !== "focus") return false;
  if (state.expanded && state.addingEntry) {
    // Swipe-down on the inline form: cancel the form, keep the
    // edit expansion. The user can swipe again to fully collapse.
    commit(() => {
      setState({ addingEntry: false });
    }, "fade");
    return true;
  }
  if (state.expanded) {
    // Collapse edit.
    commit(() => {
      setState({ expanded: false, addingEntry: false });
    }, "collapse");
    return true;
  }
  const idx = currentIndex(state);
  const prev = state.records[idx - 1];
  if (!prev) return false; // first/newest — spring back
  commit(() => {
    setState({ currentRecordId: prev.id });
  }, "nav-vertical");
  return true;
}

function openNewRecord(): boolean {
  const state = getState();
  // Works from ANY focus-view state (including the empty state), so the
  // user can always open the "add new record" form.
  if (state.view !== "focus") return false;
  commit(() => {
    setState({ view: "new" });
  }, "push-horizontal-in");
  return true;
}

function closeNewRecord(): boolean {
  const state = getState();
  if (state.view !== "new") return false;
  commit(() => {
    setState({ view: "focus" });
  }, "push-horizontal-out");
  return true;
}

function toggleEdit(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded) return false;
  if (state.records.length === 0) return false;
  commit(() => {
    setState({ expanded: true });
  }, "expand");
  return true;
}

function collapseEdit(): boolean {
  const state = getState();
  if (!state.expanded) return false;
  commit(() => {
    setState({ expanded: false, addingEntry: false });
  }, "collapse");
  return true;
}

function openGrid(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.records.length === 0) return false;
  commit(() => {
    setState({ view: "grid" });
  }, "scale-morph");
  return true;
}

function closeGrid(centroid?: { x: number; y: number }): boolean {
  const state = getState();
  if (state.view !== "grid") return false;
  // Try to focus the cell under the pinch centroid. If none, just
  // return to the current focus.
  const target = centroid ? findRecordIdAt(state, centroid) : null;
  commit(() => {
    setState({
      view: "focus",
      currentRecordId: target ?? state.currentRecordId,
      expanded: false,
      addingEntry: false,
    });
  }, "scale-morph");
  return true;
}

function findRecordIdAt(state: AppState, point: { x: number; y: number }): string | null {
  const elements = document.elementsFromPoint(point.x, point.y);
  for (const el of elements) {
    if (!(el instanceof HTMLElement)) continue;
    const id = el.getAttribute(VIEW_ATTRS.recordId);
    if (id !== null && state.records.some((r) => r.id === id)) return id;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Gesture handlers — thin wrappers over the named action functions.
 * ------------------------------------------------------------------------- */

const gestureHandlers: GestureHandlers = {
  onSwipeUp: () => goToNextRecord(),
  onSwipeDown: () => goToPreviousRecord(),
  onSwipeRight: () => openNewRecord(),
  onSwipeLeft: () => closeNewRecord(),
  onLongPress: () => toggleEdit(),
  onPinchOut: () => openGrid(),
  onPinchIn: (c) => closeGrid(c),
};

/* ---------------------------------------------------------------------------
 * Seed loader (used by the "LOAD EXAMPLES" button in the empty state)
 * ------------------------------------------------------------------------- */

function loadExamples(): void {
  const seed = getSeedData();
  commit(() => {
    setState({
      records: seed.records,
      currentRecordId: seed.currentRecordId,
      view: "focus",
      expanded: false,
      addingEntry: false,
    });
  }, "fade");
}

/* ---------------------------------------------------------------------------
 * Keyboard shortcuts (desktop parity)
 *
 * A single `keydown` listener on `document` dispatches to the same named
 * action functions as the gesture handlers. Skipped when the focus is
 * inside a form input/textarea/contentEditable so the user can type
 * freely. Modifier keys (Ctrl/Meta/Alt) are ignored so browser shortcuts
 * pass through. `preventDefault` is called only when the handler
 * actually fired, to avoid eating arrow-key scrolling when no action
 * applies.
 * ------------------------------------------------------------------------- */

function isFormElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

function onKeyDown(e: KeyboardEvent): void {
  // Browser shortcuts (Cmd+R, Ctrl+L, etc.) always pass through.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // While typing in a form, let the browser handle every key natively
  // (Enter submits, Escape clears, arrow keys move the caret, etc.).
  if (isFormElement(e.target)) return;

  let handled = false;
  switch (e.key) {
    case "ArrowUp":
      handled = goToNextRecord();
      break;
    case "ArrowDown":
      handled = goToPreviousRecord();
      break;
    case "ArrowRight":
      handled = openNewRecord();
      break;
    case "ArrowLeft":
      handled = closeNewRecord();
      break;
    case "Enter":
      // Long-press equivalent — toggle edit expansion from focus.
      handled = toggleEdit();
      break;
    case "Escape": {
      // Contextual back: grid → focus, new → focus, expanded → focus.
      const state = getState();
      if (state.view === "grid") {
        handled = closeGrid();
      } else if (state.view === "new") {
        handled = closeNewRecord();
      } else if (state.expanded) {
        handled = collapseEdit();
      }
      break;
    }
    case "g":
    case "G": {
      // Toggle grid (pinch equivalent).
      const state = getState();
      if (state.view === "grid") {
        handled = closeGrid();
      } else {
        handled = openGrid();
      }
      break;
    }
  }

  if (handled) {
    // Prevent the browser from scrolling on arrow keys / accepting Enter
    // on the body when our handler fired. Keys we didn't handle fall
    // through to the browser's default behavior.
    e.preventDefault();
  }
}

/* ---------------------------------------------------------------------------
 * Boot
 * ------------------------------------------------------------------------- */

let gestureCleanup: (() => void) | null = null;
let cleanups: Array<() => void> = [];

/** Dispose of every listener/handler from a previous `init()` run. */
function teardown(): void {
  if (gestureCleanup !== null) {
    try {
      gestureCleanup();
    } catch (err) {
      console.error("[rec-ord] gesture cleanup error:", err);
    }
    gestureCleanup = null;
  }
  for (const fn of cleanups) {
    try {
      fn();
    } catch (err) {
      console.error("[rec-ord] cleanup error:", err);
    }
  }
  cleanups = [];
}

function init(): void {
  // Always dispose the previous instance first — guards against
  // double-subscription if `astro:page-load` fires more than once
  // (e.g. dev-mode HMR, future client-side routing).
  teardown();

  // Load persisted data.
  const loaded = normalize(loadState());

  // Build the initial state: persisted records + currentRecordId;
  // view resets to focus/collapsed/no-inline-form.
  const initial: AppState = {
    records: loaded.records,
    currentRecordId: loaded.currentRecordId,
    view: "focus",
    expanded: false,
    addingEntry: false,
  };
  initState(initial);

  // Initial mount (no transition — first paint).
  const mount = document.getElementById(APP_ID);
  if (mount === null) {
    console.error("[rec-ord] #app mount element not found");
    return;
  }
  mount.replaceChildren(renderApp(initial));
  wire(mount);

  // Attach gestures to `document.body` (NOT `#app`) so pointer events
  // fired on the `<main>` padding around the card — the top, bottom and
  // sides of the screen — bubble up to the handler. Attaching to `#app`
  // would miss all events outside the card's bounding box. The render
  // mount stays at `#app` (the visual contract is unchanged).
  const gestureRoot = document.body;
  gestureCleanup = attachGestures({
    root: gestureRoot,
    getView: () => getState().view,
    getExpanded: () => getState().expanded,
    getHasRecords: () => getState().records.length > 0,
    handlers: gestureHandlers,
  });

  // Keyboard shortcuts (desktop parity). The handler dispatches to the
  // same named action functions as the gesture handlers.
  document.addEventListener("keydown", onKeyDown);
  cleanups.push(() => document.removeEventListener("keydown", onKeyDown));

  // Subscribe: persist + plain DOM update on every state change. The
  // DOM update is intentionally NOT wrapped in a `commit` here — every
  // state-changing call site already wraps `setState` in `commit` (with
  // the appropriate transition name), and the subscriber's plain update
  // runs inside that callback, so the browser snapshots the swap
  // exactly once.
  const unsub = subscribe((state) => {
    saveState(state.records, state.currentRecordId);
    updateDOM();
  });
  cleanups.push(unsub);

  // The render module's local state (delete-confirm timeout) dispatches
  // `rec-ord:rerender` when the confirm should silently revert. Listen
  // and re-render so the button label updates. Uses `rerender` (not
  // `updateDOM`) because there is no underlying state change to
  // trigger the subscriber — the label flip is purely UI state.
  const unsubRerender = onRerender(() => {
    rerender();
  });
  cleanups.push(unsubRerender);

  // Save any pending writes before the page unloads.
  const onPageHide = (): void => {
    flushSave();
  };
  window.addEventListener("pagehide", onPageHide);
  cleanups.push(() => window.removeEventListener("pagehide", onPageHide));
}

// Run init on first load AND on every Astro page-load event (so the app
// re-attaches correctly if the user ever navigates between Astro pages
// — currently never, but the hook is the right one).
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
document.addEventListener("astro:page-load", init);
