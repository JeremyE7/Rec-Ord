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
 * The shell is a single-page application. State-changing actions run through
 * the GSAP motion controller, while the store subscriber performs the plain
 * DOM render inside that synchronous mutation.
 */

import { flushSave, loadState, normalize, saveState } from "./persistence";
import { attachGestures, attachRowSwipe, type GestureHandlers } from "./gestures";
import {
  animateInitialView,
  celebrate,
  commit,
  disposeMotion,
} from "./motion";
import {
  isNewBest,
  latestEntry,
  makeEntry,
  makeRecord,
  sortEntries,
} from "./record-utils";
import {
  armDeleteConfirm,
  consumeDeleteConfirm,
  onRerender,
  renderApp,
  setEditingEntryId,
  VIEW_ATTRS,
} from "./render";
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
 *   - `updateDOM()` is the plain DOM swap. It runs inside the state mutation
 *     passed to `commit(...)`, allowing the motion controller to retain the
 *     previous node as an exit overlay.
 *
 *   - `rerender()` is the "default fade" wrapper — use it for the one
 *     case where the UI must re-render without a corresponding state
 *     change (the delete-record two-tap label flip). It commits the
 *     DOM swap with the generic fade transition.
 * ------------------------------------------------------------------------- */

function updateDOM(): void {
  const mount = document.getElementById(APP_ID);
  if (mount === null) return;
  const fresh = renderApp(getState());
  mount.replaceChildren(fresh);
  wire(mount);
}

function rerender(): void {
  void commit(() => updateDOM(), { type: "fade" });
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

  // Grid/list records are directly selectable. Native buttons provide tap,
  // click, Enter, and Space activation without adding visible controls.
  const recordCells = root.querySelectorAll<HTMLButtonElement>(
    `button[${VIEW_ATTRS.recordId}]`,
  );
  recordCells.forEach((cell) => {
    cell.addEventListener("click", onGridRecordClick);
  });

  // Entry rows: swipe-to-delete + tap-to-edit
  const rows = root.querySelectorAll<HTMLLIElement>(`li[${VIEW_ATTRS.entryRow}]`);
  rows.forEach((row) => {
    const entryId = row.getAttribute(VIEW_ATTRS.entryId);
    if (entryId === null) return;
    attachRowSwipe(row, {
      onDelete: () => deleteEntry(entryId),
    });
    // Tap → edit (but only when the row is in read-only mode — if the
    // user is already editing this row, the form's SAVE/CANCEL inputs
    // own the clicks). Dispatch the custom event; the listener in
    // init() updates `editingEntryId` and re-renders.
    row.addEventListener("click", () => {
      if (row.querySelector(`[${VIEW_ATTRS.entryEditForm}]`) !== null) return;
      document.dispatchEvent(
        new CustomEvent("rec-ord:edit-entry", { detail: { entryId } }),
      );
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (row.querySelector(`[${VIEW_ATTRS.entryEditForm}]`) !== null) return;
      event.preventDefault();
      document.dispatchEvent(
        new CustomEvent("rec-ord:edit-entry", { detail: { entryId } }),
      );
    });
  });

  // Edit entry form: submit → onEditEntrySubmit, cancel → clear + rerender
  const editEntryForms = root.querySelectorAll<HTMLFormElement>(
    `[${VIEW_ATTRS.entryEditForm}]`,
  );
  editEntryForms.forEach((form) => {
    form.addEventListener("submit", onEditEntrySubmit);
    // Escape inside the form cancels (the global keydown handler is a
    // no-op while focused in a form input, so the form needs its own).
    form.addEventListener("keydown", onEditFormKeyDown as EventListener);
  });

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
    b.setAttribute("aria-pressed", String(isActive));
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
  void commit(() => {
    setState((prev) => ({
      records: [record, ...prev.records],
      currentRecordId: record.id,
      view: "focus",
      expanded: false,
      addingEntry: false,
    }));
  }, { type: "panel", direction: "out" });
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

  // Build the entry up front so we can reference its id after the
  // state update (for the PR-pulse check below).
  const newEntry: Entry = makeEntry(value, date);

  const transition = commit(() => {
    setState((prev) => {
      const record = currentRecord(prev);
      if (record === null) return prev;
      const newEntries = sortEntries([newEntry, ...record.entries]);
      const updated: Record = { ...record, entries: newEntries };
      return {
        records: prev.records.map((r) => (r.id === record.id ? updated : r)),
        addingEntry: false,
      };
    });
  }, { type: "fade" });

  // PR pulse: if the new entry (now the latest, because it has today's
  // date in 99% of cases, and sortEntries puts it there regardless)
  // strictly beats every other entry in the record's direction, flash
  // the hero. No pulse when the record has no direction, when this was
  // the first entry, or when the value merely ties the previous best.
  const updatedRecord = currentRecord(getState());
  if (updatedRecord !== null) {
    const newLatest = latestEntry(updatedRecord);
    if (newLatest !== null && newLatest.id === newEntry.id) {
      if (isNewBest(updatedRecord, newEntry.id, value)) {
        void transition.then(() => {
          document.dispatchEvent(new CustomEvent("rec-ord:pr-pulse"));
        });
      }
    }
  }
}

function onEditEntrySubmit(e: SubmitEvent): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const valueRaw = data.get("value");
  const date = String(data.get("date") ?? "");
  if (date === "" || valueRaw === null) return;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return;

  const entryId = form.dataset.entryId;
  if (entryId === undefined) return;

  const before = currentRecord(getState());
  if (before === null) return;
  const oldEntry = before.entries.find((entry) => entry.id === entryId);
  if (oldEntry === undefined) return;

  // Capture whether the edit changes the latest AND the value (the
  // hero). If the hero doesn't change, the glow pulse would land on a
  // number the user didn't just set, which is visually confusing.
  const wasLatest = latestEntry(before)?.id === entryId;
  const valueChanged = oldEntry.value !== value;

  // Clear the editing state BEFORE the state update so the render that
  // fires from the subscriber sees `editingEntryId === null` and shows
  // the read-only row (not the form).
  setEditingEntryId(null);

  const transition = commit(() => {
    setState((prev) => {
      const r = currentRecord(prev);
      if (r === null) return prev;
      const updatedEntries = r.entries.map((entry) =>
        entry.id === entryId ? { ...entry, value, date } : entry,
      );
      const updated: Record = { ...r, entries: sortEntries(updatedEntries) };
      return { records: prev.records.map((x) => (x.id === r.id ? updated : x)) };
    });
  }, { type: "fade" });

  // PR pulse on edit: only when the edited entry IS the latest after
  // the state update (which can change if the user re-dated an older
  // entry into the future) and the value actually changed, AND the new
  // value strictly beats every other entry.
  if (wasLatest && valueChanged) {
    const updated = currentRecord(getState());
    if (updated !== null) {
      const newLatest = latestEntry(updated);
      if (newLatest !== null && newLatest.id === entryId) {
        if (isNewBest(updated, entryId, value)) {
          void transition.then(() => {
            document.dispatchEvent(new CustomEvent("rec-ord:pr-pulse"));
          });
        }
      }
    }
  }
}

function onEditFormKeyDown(e: KeyboardEvent): void {
  // Escape inside the edit form → cancel. Enter is handled by the
  // form's default submit; this only adds the cancel path.
  if (e.key === "Escape") {
    e.preventDefault();
    setEditingEntryId(null);
    document.dispatchEvent(new CustomEvent("rec-ord:rerender"));
  }
}

function onNewEntryToggleClick(): void {
  // Opening is an explicit transactional action. Closing is gestural:
  // swipe down once to dismiss the composer, then again to collapse edit.
  const opening = true;
  void commit(() => {
    setState({ addingEntry: opening });
  }, { type: "fade" }).then(() => {
    if (!opening) return;
    document.querySelector<HTMLInputElement>(
      `[${VIEW_ATTRS.addEntryForm}] input[name="value"]`,
    )?.focus({ preventScroll: true });
  });
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
    void commit(() => {
      setState({
        records: [],
        currentRecordId: null,
        view: "focus",
        expanded: false,
        addingEntry: false,
      });
    }, { type: "record", direction: "up" });
    return;
  }

  // Pick the neighbor: prefer the next-newer record (index - 1), fall
  // back to the next-older one (index + 1) if we were the first.
  const idx = currentIndex(state);
  const neighbor = state.records[idx - 1] ?? state.records[idx + 1] ?? null;

  const direction = neighbor === state.records[idx - 1] ? "down" : "up";
  void commit(() => {
    setState({
      records: state.records.filter((r) => r.id !== record.id),
      currentRecordId: neighbor ? neighbor.id : null,
      view: "focus",
      expanded: false,
      addingEntry: false,
    });
  }, { type: "record", direction });
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
  void commit(() => {
    setState((prev) => {
      const r = currentRecord(prev);
      if (r === null) return prev;
      const updated: Record = { ...r, entries: r.entries.filter((e) => e.id !== entryId) };
      return { records: prev.records.map((x) => (x.id === r.id ? updated : x)) };
    });
  }, { type: "fade" });
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

function goToNextRecord(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded) return false;
  const idx = currentIndex(state);
  const next = state.records[idx + 1];
  if (!next) return false; // last/oldest — spring back
  void commit(() => {
    setState({ currentRecordId: next.id });
  }, { type: "record", direction: "up", velocity });
  return true;
}

function goToPreviousRecord(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "focus") return false;
  if (state.expanded && state.addingEntry) {
    // Swipe-down on the inline form: cancel the form, keep the
    // edit expansion. The user can swipe again to fully collapse.
    void commit(() => {
      setState({ addingEntry: false });
    }, { type: "fade" });
    return true;
  }
  if (state.expanded) {
    // Collapse edit.
    setEditingEntryId(null);
    void commit(() => {
      setState({ expanded: false, addingEntry: false });
    }, { type: "expand", direction: "out" });
    return true;
  }
  const idx = currentIndex(state);
  const prev = state.records[idx - 1];
  if (!prev) return false; // first/newest — spring back
  void commit(() => {
    setState({ currentRecordId: prev.id });
  }, { type: "record", direction: "down", velocity });
  return true;
}

function openNewRecord(velocity?: number): boolean {
  const state = getState();
  // Only available from the collapsed focus view. In expanded view, the
  // user is in "edit mode" — horizontal swipes are intentionally blocked
  // by the gesture handler so the only way out is swipe-down.
  if (state.view !== "focus" || state.expanded) return false;
  void commit(() => {
    setState({ view: "new" });
  }, { type: "panel", direction: "in", velocity });
  return true;
}

function closeNewRecord(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "new") return false;
  void commit(() => {
    setState({ view: "focus" });
  }, { type: "panel", direction: "out", velocity });
  return true;
}

function toggleEdit(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded) return false;
  if (state.records.length === 0) return false;
  void commit(() => {
    setState({ expanded: true });
  }, { type: "expand", direction: "in" });
  return true;
}

function collapseEdit(): boolean {
  const state = getState();
  if (!state.expanded) return false;
  setEditingEntryId(null);
  void commit(() => {
    setState({ expanded: false, addingEntry: false });
  }, { type: "expand", direction: "out" });
  return true;
}

function focusGridRecord(recordId: string): boolean {
  const state = getState();
  if (state.view !== "grid") return false;
  if (!state.records.some((record) => record.id === recordId)) return false;

  void commit(() => {
    setState({
      view: "focus",
      currentRecordId: recordId,
      expanded: false,
      addingEntry: false,
    });
  }, { type: "grid", direction: "in" });
  return true;
}

function onGridRecordClick(event: MouseEvent): void {
  const cell = event.currentTarget as HTMLButtonElement;
  const recordId = cell.getAttribute(VIEW_ATTRS.recordId);
  if (recordId !== null) focusGridRecord(recordId);
}

function openGrid(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded || state.records.length === 0) return false;
  void commit(() => {
    setState({ view: "grid" });
  }, { type: "grid", direction: "out" });
  return true;
}

function closeGrid(): boolean {
  const state = getState();
  if (state.view !== "grid") return false;
  const recordId = state.currentRecordId ?? state.records[0]?.id;
  return recordId === undefined ? false : focusGridRecord(recordId);
}

function handleSwipeLeft(velocity?: number): boolean {
  return getState().view === "new"
    ? closeNewRecord(velocity)
    : openGrid();
}

/* ---------------------------------------------------------------------------
 * Gesture handlers — thin wrappers over the named action functions.
 * ------------------------------------------------------------------------- */

const gestureHandlers: GestureHandlers = {
  onSwipeUp: (v) => goToNextRecord(v),
  onSwipeDown: (v) => goToPreviousRecord(v),
  onSwipeRight: (v) => openNewRecord(v),
  onSwipeLeft: (v) => handleSwipeLeft(v),
  onLongPress: () => toggleEdit(),
};

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
      handled = handleSwipeLeft();
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
      // Direct keyboard shortcut for toggling the record list.
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
  disposeMotion();
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
  // Always dispose a previous instance first (dev-mode HMR can re-run the
  // module without a full browser navigation).
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
  const initialView = renderApp(initial);
  mount.replaceChildren(initialView);
  wire(mount);
  animateInitialView(initialView);

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
    canSwipeVertical: (direction) => {
      const state = getState();
      if (state.view !== "focus") return false;
      const idx = currentIndex(state);
      if (direction === "up") {
        // Swiping up goes to the next (older) record.
        return state.records[idx + 1] !== undefined;
      }
      // Swiping down goes to the previous (newer) record, or collapses.
      if (state.expanded) return true; // swipe down always valid when expanded
      return state.records[idx - 1] !== undefined;
    },
    handlers: gestureHandlers,
  });

  // Keyboard shortcuts (desktop parity). The handler dispatches to the
  // same named action functions as the gesture handlers.
  document.addEventListener("keydown", onKeyDown);
  cleanups.push(() => document.removeEventListener("keydown", onKeyDown));

  // Persist + perform the plain DOM update on every state change. View
  // actions wrap their mutation in `commit`, which owns the animation.
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

  // Tap-to-edit: the render module dispatches `rec-ord:edit-entry`
  // with `detail.entryId` when a row is tapped. We set the local edit
  // state in the render module and re-render — the next render of
  // that row will swap its content for the inline edit form.
  const onEditEntry = (e: Event): void => {
    const detail = (e as CustomEvent<{ entryId: string }>).detail;
    if (detail === undefined) return;
    setEditingEntryId(detail.entryId);
    rerender();
  };
  document.addEventListener("rec-ord:edit-entry", onEditEntry);
  cleanups.push(() => document.removeEventListener("rec-ord:edit-entry", onEditEntry));

  // New personal best feedback is owned by GSAP, so repeated events can
  // interrupt and clean up the previous celebration without layout shifts.
  const onPrPulse = (): void => {
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    if (hero === null) return;
    celebrate(hero);
  };
  document.addEventListener("rec-ord:pr-pulse", onPrPulse);
  cleanups.push(() => document.removeEventListener("rec-ord:pr-pulse", onPrPulse));

  // Save any pending writes before the page unloads.
  const onPageHide = (): void => {
    flushSave();
  };
  window.addEventListener("pagehide", onPageHide);
  cleanups.push(() => window.removeEventListener("pagehide", onPageHide));
}

// The application has a single route and does not install Astro's client
// router, so normal document readiness is the only lifecycle required.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
