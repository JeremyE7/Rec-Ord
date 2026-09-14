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
 *      persistence; view = "focus", expanded = false, editingEntryId = null).
 *   3. Mount the rendered app into `#app` and attach gestures.
 *   4. Subscribe to store changes: on every mutation, debounce-save
 *      and re-render the app.
 *
 * The shell is a single-page application. State-changing actions run through
 * the GSAP motion controller, while the store subscriber performs the plain
 * DOM render inside that synchronous mutation.
 */

import { flushSave, loadState, normalize, saveState } from "./persistence";
import {
  attachGestures,
  attachLongPress,
  attachRowSwipe,
  type GestureHandlers,
} from "./gestures";
import { animateInitialView, celebrate, commit, disposeMotion } from "./motion";
import {
  isNewBest,
  latestEntry,
  makeEntry,
  makeRecord,
  normalizeQuickStep,
  parseTagsInput,
  sortEntries,
  todayISO,
} from "./record-utils";
import {
  advanceCaptureSession,
  captureSessionRecordId,
  createCaptureSession,
  recordsForRoutine,
  routineById,
  routineForDate,
} from "./routines";
import {
  armDeleteConfirm,
  consumeDeleteConfirm,
  onRerender,
  renderApp,
  VIEW_ATTRS,
} from "./render";
import { getState, initState, setState, subscribe } from "./store";
import {
  archiveDeletedEntry,
  archiveDeletedRecord,
  DELETION_CREATED_EVENT,
  DELETION_FAILED_EVENT,
  getDeletedItem,
  removeDeletedItem,
  RESTORE_DELETED_EVENT,
  RESTORE_DELETED_RESULT_EVENT,
  type DeletionCreatedDetail,
  type DeletionFailedDetail,
  type DeletedItem,
  type RestoreDeletedDetail,
  type RestoreDeletedResultDetail,
} from "./trash";
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

function requestEntryEdit(entryId: string): void {
  document.dispatchEvent(
    new CustomEvent("rec-ord:edit-entry", { detail: { entryId } }),
  );
}

function focusEntryRow(entryId: string): void {
  const row = [
    ...document.querySelectorAll<HTMLElement>(`[${VIEW_ATTRS.entryId}]`),
  ].find((candidate) => candidate.dataset.entryId === entryId);
  if (row !== undefined) {
    row.focus({ preventScroll: true });
    return;
  }

  document
    .querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.newEntryToggle}]`)
    ?.focus({ preventScroll: true });
}

function filteredRecords(state: AppState): Record[] {
  const tagFilter = state.activeTagFilter ?? null;
  if (tagFilter !== null && tagFilter !== "") {
    return state.records.filter((r) => (r.tags ?? []).includes(tagFilter));
  }
  const routine = routineById(state.routineConfig, state.activeRoutineId);
  return routine === null
    ? state.records
    : recordsForRoutine(state.records, routine);
}

function currentRoutine(state: AppState): ReturnType<typeof routineById> {
  return routineById(state.routineConfig, state.activeRoutineId);
}

function todayRoutine(state: AppState): ReturnType<typeof routineForDate> {
  return routineForDate(state.routineConfig, todayISO());
}

function announceDeletion(item: DeletedItem): void {
  const detail: DeletionCreatedDetail = {
    itemId: item.id,
    kind: item.kind,
    message: item.kind === "record" ? "RECORD DELETED" : "ENTRY DELETED",
  };
  document.dispatchEvent(new CustomEvent(DELETION_CREATED_EVENT, { detail }));
}

function announceDeletionFailure(): void {
  const detail: DeletionFailedDetail = {
    message: "DELETE CANCELLED · RECOVERY COPY COULD NOT BE CREATED",
  };
  document.dispatchEvent(new CustomEvent(DELETION_FAILED_EVENT, { detail }));
}

function announceRestoreResult(detail: RestoreDeletedResultDetail): void {
  document.dispatchEvent(
    new CustomEvent(RESTORE_DELETED_RESULT_EVENT, { detail }),
  );
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
  // Forms: new-record + contextual entry/settings editors
  const newRecordForm = root.querySelector<HTMLFormElement>(
    `[${VIEW_ATTRS.newRecordForm}]`,
  );
  if (newRecordForm !== null) {
    newRecordForm.addEventListener("submit", onNewRecordSubmit);
  }

  const addEntryForm = root.querySelector<HTMLFormElement>(
    `[${VIEW_ATTRS.addEntryForm}]`,
  );
  if (addEntryForm !== null) {
    addEntryForm.addEventListener("submit", onAddEntrySubmit);
  }

  // Unit preset picker (inside the new-record form)
  const unitPresets = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.unitPreset}]`,
  );
  unitPresets.forEach((btn) => {
    btn.addEventListener("click", onUnitPresetClick);
  });

  // Direction toggle (inside the new-record form)
  const directionButtons = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.direction}]`,
  );
  directionButtons.forEach((btn) => {
    btn.addEventListener("click", onDirectionClick);
  });

  // ADD ENTRY action (expanded focus → contextual modal surface)
  const newEntryToggle = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.newEntryToggle}]`,
  );
  if (newEntryToggle !== null) {
    newEntryToggle.addEventListener("click", onNewEntryToggleClick);
  }

  const repeatBtn = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.repeatEntry}]`,
  );
  if (repeatBtn !== null) {
    repeatBtn.addEventListener("click", onRepeatEntryClick);
  }

  const tagFilterBtns = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.tagFilter}]`,
  );
  tagFilterBtns.forEach((btn) => {
    btn.addEventListener("click", onTagFilterClick);
  });

  const routineFilterBtns = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.routineFilter}]`,
  );
  routineFilterBtns.forEach((btn) => {
    btn.addEventListener("click", onRoutineFilterClick);
  });

  const routineOpen = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.routineOpen}]`,
  );
  if (routineOpen !== null) {
    routineOpen.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("rec-ord:open-routines"));
    });
  }

  const startRoutine = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.startRoutine}]`,
  );
  if (startRoutine !== null) {
    startRoutine.addEventListener("click", onStartRoutineClick);
  }

  const skipCapture = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.skipCapture}]`,
  );
  if (skipCapture !== null) {
    skipCapture.addEventListener("click", onSkipCaptureClick);
  }

  const quickValueBtns = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.quickValue}]`,
  );
  quickValueBtns.forEach((btn) => {
    btn.addEventListener("click", onQuickValueClick);
  });

  const recordSettingsForm = root.querySelector<HTMLFormElement>(
    `[${VIEW_ATTRS.recordSettingsForm}]`,
  );
  if (recordSettingsForm !== null) {
    recordSettingsForm.addEventListener("submit", onRecordSettingsSubmit);
  }

  const recordSettingsOpen = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.recordSettingsOpen}]`,
  );
  if (recordSettingsOpen !== null) {
    recordSettingsOpen.addEventListener("click", onRecordSettingsOpen);
  }

  const cancelEditors = root.querySelectorAll<HTMLButtonElement>(
    `[${VIEW_ATTRS.cancelEditor}]`,
  );
  cancelEditors.forEach((button) => {
    button.addEventListener("click", onCancelEditor);
  });

  // DELETE RECORD two-tap
  const deleteBtn = root.querySelector<HTMLButtonElement>(
    `[${VIEW_ATTRS.deleteRecord}]`,
  );
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

  // Entry rows: swipe-to-delete + tap-to-edit in a contextual modal
  const rows = root.querySelectorAll<HTMLLIElement>(
    `li[${VIEW_ATTRS.entryRow}]`,
  );
  rows.forEach((row) => {
    const entryId = row.getAttribute(VIEW_ATTRS.entryId);
    if (entryId === null) return;
    attachRowSwipe(row, {
      onDelete: () => deleteEntry(entryId),
    });
    // Tap → edit. The listener in init() opens the contextual modal while
    // preserving the row-to-surface shared transition.
    row.addEventListener("click", () => requestEntryEdit(entryId));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      requestEntryEdit(entryId);
    });
  });

  const latestEntryEdit = root.querySelector<HTMLElement>(
    `[${VIEW_ATTRS.latestEntryEdit}]`,
  );
  if (latestEntryEdit !== null) {
    const entryId = latestEntryEdit.getAttribute(VIEW_ATTRS.entryId);
    if (entryId !== null) {
      attachLongPress(latestEntryEdit, {
        onLongPress: () => {
          requestEntryEdit(entryId);
          return true;
        },
      });
      latestEntryEdit.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        requestEntryEdit(entryId);
      });
      latestEntryEdit.addEventListener("click", (event) => {
        // Assistive technologies activate custom button roles with a
        // synthetic click. Pointer users keep the deliberate hold gesture.
        if (event.detail === 0) requestEntryEdit(entryId);
      });
    }
  }

  // Contextual entry modal: submit → save, cancel → return to focus.
  const editEntryForm = root.querySelector<HTMLFormElement>(
    `[${VIEW_ATTRS.entryEditForm}]`,
  );
  if (editEntryForm !== null) {
    editEntryForm.addEventListener("submit", onEditEntrySubmit);
  }
}

/* ---------------------------------------------------------------------------
 * Form + button handlers
 * ------------------------------------------------------------------------- */

/** Toggles the active visual state on a group of pill buttons (the
 *  preset row or the direction toggle). The button matching `active`
 *  gets the accent classes; the others get the muted classes. */
function setActivePill(
  buttons: NodeListOf<HTMLButtonElement>,
  active: HTMLButtonElement,
): void {
  const ACTIVE = ["border-accent", "text-accent"] as const;
  const INACTIVE = [
    "border-line",
    "text-ink-muted",
    "hover:text-ink",
    "hover:border-ink-muted",
  ] as const;
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
    const all = row.querySelectorAll<HTMLButtonElement>(
      `[${VIEW_ATTRS.unitPreset}]`,
    );
    setActivePill(all, btn);
  }
}

function onDirectionClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const direction = btn.getAttribute(VIEW_ATTRS.direction) ?? "";
  const form = btn.closest("form");
  if (form === null) return;
  const hidden = form.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="direction"]',
  );
  if (hidden === null) return;
  hidden.value = direction;
  // Update the active highlight across the whole direction row.
  const row = form.querySelector<HTMLDivElement>(
    `[data-direction-toggle], [aria-label="Direction"]`,
  );
  if (row !== null) {
    const all = row.querySelectorAll<HTMLButtonElement>(
      `[${VIEW_ATTRS.direction}]`,
    );
    setActivePill(all, btn);
  }
}

function onNewRecordSubmit(e: SubmitEvent): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  const valueRaw = data.get("value");
  const unit = String(data.get("unit") ?? "")
    .trim()
    .toUpperCase();
  const date = String(data.get("date") ?? "");
  const quickStepRaw = String(data.get("quickStep") ?? "").trim();
  // Direction is stored in a hidden input. Empty string = no preference.
  const directionRaw = String(data.get("direction") ?? "");
  const direction: "up" | "down" | null =
    directionRaw === "up" || directionRaw === "down" ? directionRaw : null;
  if (name === "" || unit === "" || date === "" || valueRaw === null) return;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return;
  const quickStep =
    quickStepRaw === "" ? undefined : normalizeQuickStep(Number(quickStepRaw));
  if (quickStepRaw !== "" && quickStep === undefined) return;

  const firstEntry: Entry = makeEntry(value, date);
  const selectedTags = parseTagsInput(String(data.get("tags") ?? ""));
  const routine = currentRoutine(getState()) ?? todayRoutine(getState());
  const tags = selectedTags ?? routine?.tags;
  const record: Record = makeRecord(
    name,
    unit,
    firstEntry,
    direction,
    tags,
    quickStep,
  );
  // New records go to the front (most recently created at index 0).
  void commit(
    () => {
      setState((prev) => ({
        records: [record, ...prev.records],
        currentRecordId: record.id,
        view: "focus",
        expanded: false,
        editingEntryId: null,
        captureSession: null,
      }));
    },
    { type: "panel", direction: "out" },
  );
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

  const before = getState();
  const recordBefore = currentRecord(before);
  if (recordBefore === null) return;
  const session = before.captureSession;
  const sessionRecordId = captureSessionRecordId(session);
  const isSessionEntry =
    session !== null && sessionRecordId === recordBefore.id;
  const nextSession = isSessionEntry ? advanceCaptureSession(session) : session;
  const nextRecordId = isSessionEntry
    ? captureSessionRecordId(nextSession)
    : null;
  const continueSession = isSessionEntry && nextRecordId !== null;

  // Build the entry up front so we can reference its id after the
  // state update (for the PR-pulse check below).
  const newEntry: Entry = makeEntry(value, date);

  const transition = commit(
    () => {
      setState((prev) => {
        const record = currentRecord(prev);
        if (record === null) return prev;
        const newEntries = sortEntries([newEntry, ...record.entries]);
        const updated: Record = { ...record, entries: newEntries };
        return {
          records: prev.records.map((r) => (r.id === record.id ? updated : r)),
          currentRecordId: continueSession ? nextRecordId : record.id,
          view: isSessionEntry && continueSession ? "entry" : "focus",
          expanded: continueSession
            ? true
            : isSessionEntry
              ? false
              : prev.expanded,
          editingEntryId: null,
          captureSession: isSessionEntry ? nextSession : prev.captureSession,
        };
      });
    },
    continueSession ? { type: "fade" } : { type: "modal", direction: "out" },
  );

  if (continueSession) {
    void transition.then(() => {
      document
        .querySelector<HTMLInputElement>(
          `[${VIEW_ATTRS.addEntryForm}] input[name="value"]`,
        )
        ?.focus({ preventScroll: true });
    });
  } else if (!isSessionEntry) {
    void transition.then(() => {
      document
        .querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.newEntryToggle}]`)
        ?.focus({ preventScroll: true });
    });
  }

  // PR pulse: if the new entry (now the latest, because it has today's
  // date in 99% of cases, and sortEntries puts it there regardless)
  // strictly beats every other entry in the record's direction, flash
  // the hero. No pulse when the record has no direction, when this was
  // the first entry, or when the value merely ties the previous best.
  const updatedRecord =
    getState().records.find((record) => record.id === recordBefore.id) ?? null;
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

function onRepeatEntryClick(): void {
  const state = getState();
  const record = currentRecord(state);
  if (record === null) return;
  const latest = latestEntry(record);
  if (latest === null) return;
  const newEntry: Entry = makeEntry(latest.value, todayISO());
  const transition = commit(
    () => {
      setState((prev) => {
        const r = currentRecord(prev);
        if (r === null) return prev;
        const newEntries = sortEntries([newEntry, ...r.entries]);
        const updated: Record = { ...r, entries: newEntries };
        return {
          records: prev.records.map((x) => (x.id === r.id ? updated : x)),
        };
      });
    },
    { type: "fade" },
  );
  const updatedRecord = currentRecord(getState());
  if (updatedRecord !== null) {
    const newLatest = latestEntry(updatedRecord);
    if (newLatest !== null && newLatest.id === newEntry.id) {
      if (isNewBest(updatedRecord, newEntry.id, newEntry.value)) {
        void transition.then(() => {
          document.dispatchEvent(new CustomEvent("rec-ord:pr-pulse"));
        });
      }
    }
  }
}

function onTagFilterClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const tag = btn.getAttribute(VIEW_ATTRS.tagFilter) ?? "";
  const next = tag === "" ? null : tag.toUpperCase();
  const state = getState();
  const visible =
    next === null
      ? state.records
      : state.records.filter((r) => (r.tags ?? []).includes(next));
  // If the current record is not in the filtered set, jump to first filtered record.
  const shouldJump =
    visible.length > 0 &&
    (state.currentRecordId === null ||
      !visible.some((r) => r.id === state.currentRecordId));
  void commit(
    () => {
      setState({
        activeTagFilter: next,
        activeRoutineId: null,
        ...(shouldJump
          ? {
              currentRecordId: visible[0]!.id,
              view: "focus" as const,
              expanded: false,
              editingEntryId: null,
            }
          : {}),
        ...(next !== null && visible.length > 0 && state.view === "grid"
          ? {}
          : {}),
      });
    },
    { type: "fade" },
  );
  // If we are in grid, stay in grid to show filtered list; if we jumped, the grid will re-render filtered.
}

function onRoutineFilterClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const routineId = btn.getAttribute(VIEW_ATTRS.routineFilter);
  if (routineId === null) return;
  const state = getState();
  const routine = routineById(state.routineConfig, routineId);
  if (routine === null) return;
  const visible = recordsForRoutine(state.records, routine);
  const shouldJump =
    visible.length > 0 &&
    (state.currentRecordId === null ||
      !visible.some((record) => record.id === state.currentRecordId));

  void commit(
    () => {
      setState({
        activeRoutineId: routine.id,
        activeTagFilter: null,
        captureSession: null,
        ...(shouldJump
          ? {
              currentRecordId: visible[0]!.id,
              view: "grid" as const,
              expanded: false,
              editingEntryId: null,
            }
          : {}),
      });
    },
    { type: "fade" },
  );
}

function onStartRoutineClick(): void {
  const state = getState();
  const routine = currentRoutine(state) ?? todayRoutine(state);
  if (routine === null) return;

  const session = createCaptureSession(state.records, routine, todayISO());
  const firstRecordId = captureSessionRecordId(session);
  if (firstRecordId === null) return;

  const transition = commit(
    () => {
      setState({
        activeRoutineId: routine.id,
        activeTagFilter: null,
        captureSession: session,
        currentRecordId: firstRecordId,
        view: "entry",
        expanded: true,
        editingEntryId: null,
      });
    },
    { type: "modal", direction: "in" },
  );

  void transition.then(() => {
    document
      .querySelector<HTMLInputElement>(
        `[${VIEW_ATTRS.addEntryForm}] input[name="value"]`,
      )
      ?.focus({ preventScroll: true });
  });
}

function onSkipCaptureClick(): void {
  const state = getState();
  const session = state.captureSession;
  if (
    session === null ||
    captureSessionRecordId(session) !== state.currentRecordId
  )
    return;
  const nextSession = advanceCaptureSession(session);
  const nextRecordId = captureSessionRecordId(nextSession);
  const continueSession = nextRecordId !== null;

  const transition = commit(
    () => {
      setState({
        captureSession: nextSession,
        currentRecordId: continueSession ? nextRecordId : state.currentRecordId,
        view: continueSession ? "entry" : "focus",
        expanded: continueSession,
        editingEntryId: null,
      });
    },
    { type: "record", direction: "up" },
  );

  if (continueSession) {
    void transition.then(() => {
      document
        .querySelector<HTMLInputElement>(
          `[${VIEW_ATTRS.addEntryForm}] input[name="value"]`,
        )
        ?.focus({ preventScroll: true });
    });
  }
}

function onQuickValueClick(e: MouseEvent): void {
  const btn = e.currentTarget as HTMLButtonElement;
  const value = Number(btn.getAttribute(VIEW_ATTRS.quickValue));
  if (!Number.isFinite(value)) return;
  const form = btn.closest("form");
  const input = form?.querySelector<HTMLInputElement>('input[name="value"]');
  if (input === undefined || input === null) return;
  input.value = String(value);
  input.focus({ preventScroll: true });
}

function onRecordSettingsSubmit(e: SubmitEvent): void {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const recordId = form.dataset.recordId;
  if (recordId === undefined) return;
  const data = new FormData(form);
  const tags = parseTagsInput(String(data.get("tags") ?? ""));
  const quickStepRaw = String(data.get("quickStep") ?? "").trim();
  const quickStep =
    quickStepRaw === "" ? undefined : normalizeQuickStep(Number(quickStepRaw));
  if (tags === undefined || (quickStepRaw !== "" && quickStep === undefined))
    return;

  const transition = commit(
    () => {
      setState((prev) => ({
        records: prev.records.map((record) => {
          if (record.id !== recordId) return record;
          const next: Record = { ...record, tags };
          if (quickStep === undefined) {
            delete next.quickStep;
          } else {
            next.quickStep = quickStep;
          }
          return next;
        }),
        view: "focus",
        expanded: true,
        editingEntryId: null,
      }));
    },
    { type: "modal", direction: "out" },
  );

  void transition.then(() => {
    document
      .querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.recordSettingsOpen}]`)
      ?.focus({ preventScroll: true });
  });
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

  const transition = commit(
    () => {
      setState((prev) => {
        const r = currentRecord(prev);
        if (r === null) return prev;
        const updatedEntries = r.entries.map((entry) =>
          entry.id === entryId ? { ...entry, value, date } : entry,
        );
        const updated: Record = { ...r, entries: sortEntries(updatedEntries) };
        return {
          records: prev.records.map((x) => (x.id === r.id ? updated : x)),
          view: "focus",
          expanded: true,
          editingEntryId: null,
          captureSession: null,
        };
      });
    },
    { type: "modal", direction: "out" },
  );

  void transition.then(() => {
    focusEntryRow(entryId);
  });

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

function onNewEntryToggleClick(): void {
  const state = getState();
  if (state.view !== "focus" || !state.expanded) return;
  void commit(
    () => {
      setState({ view: "entry", editingEntryId: null });
    },
    { type: "modal", direction: "in" },
  ).then(() => {
    document
      .querySelector<HTMLInputElement>(
        `[${VIEW_ATTRS.addEntryForm}] input[name="value"]`,
      )
      ?.focus({ preventScroll: true });
  });
}

function onRecordSettingsOpen(): void {
  const state = getState();
  if (state.view !== "focus" || !state.expanded) return;
  void commit(
    () => {
      setState({ view: "record-settings", editingEntryId: null });
    },
    { type: "modal", direction: "in" },
  ).then(() => {
    document
      .querySelector<HTMLInputElement>(
        `[${VIEW_ATTRS.recordSettingsForm}] input[name="tags"]`,
      )
      ?.focus({ preventScroll: true });
  });
}

function onCancelEditor(): void {
  const state = getState();
  if (state.view === "entry") {
    closeEntryEditor();
  } else if (state.view === "record-settings") {
    closeRecordSettings();
  }
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
  const recordIndex = currentIndex(state);
  const deletedItem = archiveDeletedRecord(record, recordIndex);
  if (deletedItem === null) {
    announceDeletionFailure();
    rerender();
    return;
  }

  // If it's the only record, the empty state is the destination.
  if (state.records.length === 1) {
    void commit(
      () => {
        setState({
          records: [],
          currentRecordId: null,
          view: "focus",
          expanded: false,
          editingEntryId: null,
          captureSession: null,
        });
      },
      { type: "record", direction: "up" },
    );
    announceDeletion(deletedItem);
    return;
  }

  // Pick the neighbor: prefer the next-newer record (index - 1), fall
  // back to the next-older one (index + 1) if we were the first.
  const idx = currentIndex(state);
  const neighbor = state.records[idx - 1] ?? state.records[idx + 1] ?? null;

  const direction = neighbor === state.records[idx - 1] ? "down" : "up";
  void commit(
    () => {
      setState({
        records: state.records.filter((r) => r.id !== record.id),
        currentRecordId: neighbor ? neighbor.id : null,
        view: "focus",
        expanded: false,
        editingEntryId: null,
        captureSession: null,
      });
    },
    { type: "record", direction },
  );
  announceDeletion(deletedItem);
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
  const entryIndex = record.entries.findIndex((entry) => entry.id === entryId);
  if (entryIndex < 0) return;
  const entry = record.entries[entryIndex];
  if (entry === undefined) return;
  const deletedItem = archiveDeletedEntry(record, entry, entryIndex);
  if (deletedItem === null) {
    announceDeletionFailure();
    return;
  }
  void commit(
    () => {
      setState((prev) => {
        const r = currentRecord(prev);
        if (r === null) return prev;
        const updated: Record = {
          ...r,
          entries: r.entries.filter((e) => e.id !== entryId),
        };
        return {
          records: prev.records.map((x) => (x.id === r.id ? updated : x)),
        };
      });
    },
    { type: "fade" },
  );
  announceDeletion(deletedItem);
}

function restoreDeletedItem(detail: RestoreDeletedDetail): void {
  const item = getDeletedItem(detail.itemId);
  if (item === null) {
    announceRestoreResult({
      ...detail,
      success: false,
      message: "ITEM IS NO LONGER AVAILABLE",
    });
    return;
  }

  const before = getState();
  let transition: Promise<void>;
  if (item.kind === "record") {
    if (before.records.some((record) => record.id === item.record.id)) {
      announceRestoreResult({
        ...detail,
        success: false,
        message: "RECORD ALREADY EXISTS",
      });
      return;
    }
    const records = [...before.records];
    records.splice(
      Math.min(item.originalIndex, records.length),
      0,
      item.record,
    );
    transition = commit(
      () => {
        setState({
          records,
          currentRecordId: item.record.id,
          view: "focus",
          expanded: detail.source === "immediate",
          editingEntryId: null,
          captureSession: null,
        });
      },
      { type: "record", direction: "down" },
    );
  } else {
    const parent = before.records.find((record) => record.id === item.recordId);
    if (parent === undefined) {
      announceRestoreResult({
        ...detail,
        success: false,
        message: "RESTORE THE PARENT RECORD FIRST",
      });
      return;
    }
    if (parent.entries.some((entry) => entry.id === item.entry.id)) {
      announceRestoreResult({
        ...detail,
        success: false,
        message: "ENTRY ALREADY EXISTS",
      });
      return;
    }
    const entries = [...parent.entries];
    entries.splice(Math.min(item.originalIndex, entries.length), 0, item.entry);
    const restored: Record = { ...parent, entries: sortEntries(entries) };
    transition = commit(
      () => {
        setState({
          records: before.records.map((record) =>
            record.id === restored.id ? restored : record,
          ),
          currentRecordId: restored.id,
          view: "focus",
          expanded: detail.source === "immediate",
          editingEntryId: null,
          captureSession: null,
        });
      },
      { type: "fade" },
    );
  }

  if (!flushSave()) {
    void commit(() => setState(before), { type: "fade" });
    flushSave();
    announceRestoreResult({
      ...detail,
      success: false,
      message: "RESTORE FAILED · ITEM KEPT",
    });
    return;
  }

  void transition;
  const removed = removeDeletedItem(item.id);
  announceRestoreResult({
    ...detail,
    success: true,
    message: removed
      ? "ITEM RESTORED"
      : "ITEM RESTORED · RECOVERY COPY REMAINS",
  });
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
  const list = filteredRecords(state);
  const idx = list.findIndex((r) => r.id === state.currentRecordId);
  if (idx === -1) {
    if (list.length === 0) return false;
    void commit(
      () => {
        setState({ currentRecordId: list[0]!.id });
      },
      { type: "record", direction: "up", velocity },
    );
    return true;
  }
  const next = list[idx + 1];
  if (!next) return false; // last/oldest — spring back
  void commit(
    () => {
      setState({ currentRecordId: next.id });
    },
    { type: "record", direction: "up", velocity },
  );
  return true;
}

function goToPreviousRecord(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "focus") return false;
  if (state.expanded) {
    // Collapse edit.
    void commit(
      () => {
        setState({
          expanded: false,
          editingEntryId: null,
          captureSession: null,
        });
      },
      { type: "expand", direction: "out" },
    );
    return true;
  }
  const list = filteredRecords(state);
  const idx = list.findIndex((r) => r.id === state.currentRecordId);
  if (idx === -1) {
    if (list.length === 0) return false;
    void commit(
      () => {
        setState({ currentRecordId: list[list.length - 1]!.id });
      },
      { type: "record", direction: "down", velocity },
    );
    return true;
  }
  const prev = list[idx - 1];
  if (!prev) return false; // first/newest — spring back
  void commit(
    () => {
      setState({ currentRecordId: prev.id });
    },
    { type: "record", direction: "down", velocity },
  );
  return true;
}

function openNewRecord(velocity?: number): boolean {
  const state = getState();
  // Only available from the collapsed focus view. In expanded view, the
  // user is in "edit mode" — horizontal swipes are intentionally blocked
  // by the gesture handler so the only way out is swipe-down.
  if (state.view !== "focus" || state.expanded) return false;
  void commit(
    () => {
      setState({ view: "new", editingEntryId: null, captureSession: null });
    },
    { type: "panel", direction: "in", velocity },
  );
  return true;
}

function closeNewRecord(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "new") return false;
  void commit(
    () => {
      setState({ view: "focus", editingEntryId: null, captureSession: null });
    },
    { type: "panel", direction: "out", velocity },
  );
  return true;
}

function closeEntryEditor(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "entry") return false;
  const entryId = state.editingEntryId;
  const keepExpanded = state.captureSession === null && state.expanded;
  void commit(
    () => {
      setState({
        view: "focus",
        expanded: keepExpanded,
        editingEntryId: null,
        captureSession: null,
      });
    },
    { type: "modal", direction: "out", velocity },
  ).then(() => {
    if (entryId !== null) {
      focusEntryRow(entryId);
      return;
    }
    document
      .querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.newEntryToggle}]`)
      ?.focus({ preventScroll: true });
  });
  return true;
}

function closeRecordSettings(velocity?: number): boolean {
  const state = getState();
  if (state.view !== "record-settings") return false;
  void commit(
    () => {
      setState({
        view: "focus",
        expanded: true,
        editingEntryId: null,
      });
    },
    { type: "modal", direction: "out", velocity },
  ).then(() => {
    document
      .querySelector<HTMLButtonElement>(`[${VIEW_ATTRS.recordSettingsOpen}]`)
      ?.focus({ preventScroll: true });
  });
  return true;
}

function toggleEdit(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded) return false;
  if (state.records.length === 0) return false;
  void commit(
    () => {
      setState({ expanded: true, editingEntryId: null });
    },
    { type: "expand", direction: "in" },
  );
  return true;
}

function collapseEdit(): boolean {
  const state = getState();
  if (!state.expanded) return false;
  void commit(
    () => {
      setState({ expanded: false, editingEntryId: null, captureSession: null });
    },
    { type: "expand", direction: "out" },
  );
  return true;
}

function focusGridRecord(recordId: string): boolean {
  const state = getState();
  if (state.view !== "grid") return false;
  if (!state.records.some((record) => record.id === recordId)) return false;

  void commit(
    () => {
      setState({
        view: "focus",
        currentRecordId: recordId,
        expanded: false,
        editingEntryId: null,
        captureSession: null,
      });
    },
    { type: "grid", direction: "in" },
  );
  return true;
}

function onGridRecordClick(event: MouseEvent): void {
  const cell = event.currentTarget as HTMLButtonElement;
  const recordId = cell.getAttribute(VIEW_ATTRS.recordId);
  if (recordId !== null) focusGridRecord(recordId);
}

function openGrid(): boolean {
  const state = getState();
  if (state.view !== "focus" || state.expanded || state.records.length === 0)
    return false;
  void commit(
    () => {
      setState({
        view: "grid",
        activeTagFilter: null,
        editingEntryId: null,
        captureSession: null,
      });
    },
    { type: "grid", direction: "out" },
  );
  return true;
}

function closeGrid(): boolean {
  const state = getState();
  if (state.view !== "grid") return false;
  const recordId = state.currentRecordId ?? state.records[0]?.id;
  return recordId === undefined ? false : focusGridRecord(recordId);
}

function handleSwipeLeft(velocity?: number): boolean {
  const view = getState().view;
  if (view === "new") return closeNewRecord(velocity);
  if (view === "entry") return closeEntryEditor(velocity);
  if (view === "record-settings") return closeRecordSettings(velocity);
  return openGrid();
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
  // While typing in a form, let the browser handle every key natively.
  // Contextual editors keep Escape available as their close action.
  if (isFormElement(e.target)) {
    const view = getState().view;
    const isContextualEditor = view === "entry" || view === "record-settings";
    if (!isContextualEditor || e.key !== "Escape") return;
  }

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
      // Contextual back: editor/grid/expanded surface → focus.
      const state = getState();
      if (state.view === "grid") {
        handled = closeGrid();
      } else if (state.view === "new") {
        handled = closeNewRecord();
      } else if (state.view === "entry") {
        handled = closeEntryEditor();
      } else if (state.view === "record-settings") {
        handled = closeRecordSettings();
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
  // view resets to focus/collapsed with no active editor.
  const initial: AppState = {
    records: loaded.records,
    currentRecordId: loaded.currentRecordId,
    routineConfig: loaded.routineConfig,
    view: "focus",
    expanded: false,
    editingEntryId: null,
    activeTagFilter: null,
    activeRoutineId: loaded.activeRoutineId,
    captureSession: null,
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
      const list = filteredRecords(state);
      const idx = list.findIndex((r) => r.id === state.currentRecordId);
      if (direction === "up") {
        // Swiping up goes to the next (older) record within filtered set.
        return list[idx + 1] !== undefined;
      }
      // Swiping down goes to the previous (newer) record, or collapses.
      if (state.expanded) return true; // swipe down always valid when expanded
      return list[idx - 1] !== undefined;
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
    saveState(
      state.records,
      state.currentRecordId,
      state.routineConfig,
      state.activeRoutineId,
    );
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
  // with `detail.entryId` when a row is tapped. Move to the contextual
  // entry modal instead of replacing the row in place.
  const onEditEntry = (e: Event): void => {
    const detail = (e as CustomEvent<{ entryId: string }>).detail;
    if (detail === undefined) return;
    const state = getState();
    if (state.view !== "focus" || !state.expanded) return;
    const record = currentRecord(state);
    if (
      record === null ||
      !record.entries.some((entry) => entry.id === detail.entryId)
    )
      return;
    void commit(
      () => {
        setState({
          view: "entry",
          expanded: true,
          editingEntryId: detail.entryId,
          captureSession: null,
        });
      },
      { type: "modal", direction: "in" },
    ).then(() => {
      document
        .querySelector<HTMLInputElement>(
          `[${VIEW_ATTRS.entryEditForm}] input[name="value"]`,
        )
        ?.focus({ preventScroll: true });
    });
  };
  document.addEventListener("rec-ord:edit-entry", onEditEntry);
  cleanups.push(() =>
    document.removeEventListener("rec-ord:edit-entry", onEditEntry),
  );

  // New personal best feedback is owned by GSAP, so repeated events can
  // interrupt and clean up the previous celebration without layout shifts.
  const onPrPulse = (): void => {
    const hero = document.querySelector<HTMLElement>("[data-hero]");
    if (hero === null) return;
    celebrate(hero);
  };
  document.addEventListener("rec-ord:pr-pulse", onPrPulse);
  cleanups.push(() =>
    document.removeEventListener("rec-ord:pr-pulse", onPrPulse),
  );

  const onRestoreDeleted = (event: Event): void => {
    const detail = (event as CustomEvent<RestoreDeletedDetail>).detail;
    if (detail === undefined) return;
    restoreDeletedItem(detail);
  };
  document.addEventListener(RESTORE_DELETED_EVENT, onRestoreDeleted);
  cleanups.push(() =>
    document.removeEventListener(RESTORE_DELETED_EVENT, onRestoreDeleted),
  );

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
