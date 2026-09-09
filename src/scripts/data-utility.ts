/** Minimal, temporary DATA surface for portable backups and safe restores. */

import {
  BackupValidationError,
  createBackupFile,
  deliverBackup,
  parseBackupFile,
  type ParsedBackup,
} from "./backup";
import {
  beginDirectManipulation,
  hideTransientAction,
  prefersReducedMotion,
  resetDirectManipulation,
  rubberBand,
  showTransientAction,
  springBack,
  transitionUtilityStep,
  updateDragFeedback,
} from "./motion";
import {
  clearRollback,
  flushSave,
  loadLastBackupAt,
  loadRollback,
  normalize,
  saveLastBackupAt,
  saveRollback,
} from "./persistence";
import { formatValueForUnit, parseTagsInput, todayISO } from "./record-utils";
import {
  normalizeRoutineConfig,
  recordsForRoutine,
} from "./routines";
import { getState, setState } from "./store";
import {
  daysUntilDeletion,
  DELETION_CREATED_EVENT,
  DELETION_FAILED_EVENT,
  loadTrash,
  RESTORE_DELETED_EVENT,
  RESTORE_DELETED_RESULT_EVENT,
  TRASH_CHANGED_EVENT,
  type DeletionCreatedDetail,
  type DeletionFailedDetail,
  type DeletedItem,
  type RestoreDeletedDetail,
  type RestoreDeletedResultDetail,
} from "./trash";
import type { PersistedState, RoutineProfile, Weekday } from "./types";

interface DataElements {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
  surface: HTMLElement;
  content: HTMLElement;
  close: HTMLButtonElement;
  home: HTMLElement;
  trash: HTMLElement;
  preview: HTMLElement;
  routines: HTMLElement;
  summary: HTMLElement;
  lastBackup: HTMLElement;
  status: HTMLElement;
  backup: HTMLButtonElement;
  restore: HTMLButtonElement;
  undo: HTMLButtonElement;
  file: HTMLInputElement;
  previewFile: HTMLElement;
  previewDate: HTMLElement;
  previewCount: HTMLElement;
  confirmRestore: HTMLButtonElement;
  cancelRestore: HTMLButtonElement;
  trashList: HTMLElement;
  trashEmpty: HTMLElement;
  trashSummary: HTMLElement;
  routineList: HTMLElement;
  routineEmpty: HTMLElement;
  routineAdd: HTMLButtonElement;
  routineOverride: HTMLFormElement;
  routineOverrideDate: HTMLInputElement;
  routineOverrideSelect: HTMLSelectElement;
  routineOverrideSave: HTMLButtonElement;
  routineBack: HTMLButtonElement;
  hint: HTMLElement;
  deletionNotice: HTMLElement;
  deletionMessage: HTMLElement;
  deletionUndo: HTMLButtonElement;
}

type StatusTone = "neutral" | "success" | "error";
type DataStep = "home" | "preview" | "trash" | "routines";
type DragAxis = "horizontal" | "vertical";

const OPEN_ROUTINES_EVENT = "rec-ord:open-routines";
const ROUTINE_WEEKDAYS: ReadonlyArray<{ value: Weekday; label: string }> = [
  { value: 1, label: "MON" },
  { value: 2, label: "TUE" },
  { value: 3, label: "WED" },
  { value: 4, label: "THU" },
  { value: 5, label: "FRI" },
  { value: 6, label: "SAT" },
  { value: 0, label: "SUN" },
];

const SWIPE_LOCK_DISTANCE = 12;
const SWIPE_CLOSE_DISTANCE = 72;
const SWIPE_NAV_DISTANCE = 72;
const UNDO_VISIBILITY_MS = 8_000;

let controller: AbortController | null = null;
let pendingBackup: ParsedBackup | null = null;
let returnFocus: HTMLElement | null = null;
let busy = false;

function collectElements(): DataElements | null {
  const trigger = document.querySelector<HTMLButtonElement>("[data-data-trigger]");
  const dialog = document.querySelector<HTMLDialogElement>("#data-dialog");
  const surface = dialog?.querySelector<HTMLElement>("[data-data-surface]") ?? null;
  const content = dialog?.querySelector<HTMLElement>("[data-data-content]") ?? null;
  const close = dialog?.querySelector<HTMLButtonElement>("[data-data-close]") ?? null;
  const home = dialog?.querySelector<HTMLElement>('[data-data-step="home"]') ?? null;
  const trash = dialog?.querySelector<HTMLElement>('[data-data-step="trash"]') ?? null;
  const preview = dialog?.querySelector<HTMLElement>('[data-data-step="preview"]') ?? null;
  const routines = dialog?.querySelector<HTMLElement>('[data-data-step="routines"]') ?? null;
  const summary = dialog?.querySelector<HTMLElement>("[data-data-summary]") ?? null;
  const lastBackup = dialog?.querySelector<HTMLElement>("[data-last-backup]") ?? null;
  const status = dialog?.querySelector<HTMLElement>("[data-data-status]") ?? null;
  const backup = dialog?.querySelector<HTMLButtonElement>("[data-backup-action]") ?? null;
  const restore = dialog?.querySelector<HTMLButtonElement>("[data-restore-action]") ?? null;
  const undo = dialog?.querySelector<HTMLButtonElement>("[data-undo-restore]") ?? null;
  const file = dialog?.querySelector<HTMLInputElement>("[data-backup-file]") ?? null;
  const previewFile = dialog?.querySelector<HTMLElement>("[data-preview-file]") ?? null;
  const previewDate = dialog?.querySelector<HTMLElement>("[data-preview-date]") ?? null;
  const previewCount = dialog?.querySelector<HTMLElement>("[data-preview-count]") ?? null;
  const confirmRestore =
    dialog?.querySelector<HTMLButtonElement>("[data-confirm-restore]") ?? null;
  const cancelRestore =
    dialog?.querySelector<HTMLButtonElement>("[data-cancel-restore]") ?? null;
  const trashList = dialog?.querySelector<HTMLElement>("[data-trash-list]") ?? null;
  const trashEmpty = dialog?.querySelector<HTMLElement>("[data-trash-empty]") ?? null;
  const trashSummary = dialog?.querySelector<HTMLElement>("[data-trash-summary]") ?? null;
  const routineList = dialog?.querySelector<HTMLElement>("[data-routine-list]") ?? null;
  const routineEmpty = dialog?.querySelector<HTMLElement>("[data-routine-empty]") ?? null;
  const routineAdd = dialog?.querySelector<HTMLButtonElement>("[data-routine-add]") ?? null;
  const routineOverride = dialog?.querySelector<HTMLFormElement>("[data-routine-override]") ?? null;
  const routineOverrideDate = dialog?.querySelector<HTMLInputElement>("[data-routine-override-date]") ?? null;
  const routineOverrideSelect = dialog?.querySelector<HTMLSelectElement>("[data-routine-override-select]") ?? null;
  const routineOverrideSave = dialog?.querySelector<HTMLButtonElement>("[data-routine-override-save]") ?? null;
  const routineBack = dialog?.querySelector<HTMLButtonElement>("[data-routine-back]") ?? null;
  const hint = dialog?.querySelector<HTMLElement>("[data-data-hint]") ?? null;
  const deletionNotice = document.querySelector<HTMLElement>("[data-deletion-notice]");
  const deletionMessage = document.querySelector<HTMLElement>("[data-deletion-message]");
  const deletionUndo = document.querySelector<HTMLButtonElement>("[data-deletion-undo]");

  if (
    trigger === null ||
    dialog === null ||
    surface === null ||
    content === null ||
    close === null ||
    home === null ||
    trash === null ||
    preview === null ||
    routines === null ||
    summary === null ||
    lastBackup === null ||
    status === null ||
    backup === null ||
    restore === null ||
    undo === null ||
    file === null ||
    previewFile === null ||
    previewDate === null ||
    previewCount === null ||
    confirmRestore === null ||
    cancelRestore === null ||
    trashList === null ||
    trashEmpty === null ||
    trashSummary === null ||
    routineList === null ||
    routineEmpty === null ||
    routineAdd === null ||
    routineOverride === null ||
    routineOverrideDate === null ||
    routineOverrideSelect === null ||
    routineOverrideSave === null ||
    routineBack === null ||
    hint === null ||
    deletionNotice === null ||
    deletionMessage === null ||
    deletionUndo === null
  ) {
    console.error("[rec-ord] DATA utility markup is incomplete");
    return null;
  }

  return {
    trigger,
    dialog,
    surface,
    content,
    close,
    home,
    trash,
    preview,
    routines,
    summary,
    lastBackup,
    status,
    backup,
    restore,
    undo,
    file,
    previewFile,
    previewDate,
    previewCount,
    confirmRestore,
    cancelRestore,
    trashList,
    trashEmpty,
    trashSummary,
    routineList,
    routineEmpty,
    routineAdd,
    routineOverride,
    routineOverrideDate,
    routineOverrideSelect,
    routineOverrideSave,
    routineBack,
    hint,
    deletionNotice,
    deletionMessage,
    deletionUndo,
  };
}

function plural(value: number, singular: string, pluralForm = `${singular}S`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function formatTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(timestamp))
    .toUpperCase();
}

function persistedState(): PersistedState {
  const state = getState();
  return {
    records: state.records,
    currentRecordId: state.currentRecordId,
    routineConfig: state.routineConfig,
  };
}

function replaceState(data: PersistedState): boolean {
  const restored = normalize(data);
  setState({
    records: restored.records,
    currentRecordId: restored.currentRecordId,
    routineConfig: restored.routineConfig,
    view: "focus",
    expanded: false,
    editingEntryId: null,
    activeRoutineId: null,
    activeTagFilter: null,
    captureSession: null,
  });
  return flushSave();
}

function initializeDataUtility(): void {
  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;
  const elements = collectElements();
  if (elements === null) return;
  let activeStep: DataStep = "home";
  let trashCount = 0;
  let immediateItemId: string | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let activeRoutineEditorId: string | null = null;

  const setStatus = (message: string, tone: StatusTone = "neutral"): void => {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
  };

  const updateHint = (): void => {
    let hint: string;
    if (activeStep === "trash") {
      hint = "SWIPE RIGHT · DATA";
    } else if (activeStep === "routines") {
      hint = "SWIPE RIGHT · DATA";
    } else if (activeStep === "home" && trashCount > 0) {
      hint = "SWIPE LEFT · RECENTLY DELETED";
    } else {
      hint = "SWIPE DOWN TO CLOSE";
    }
    if (elements.hint.textContent !== hint) elements.hint.textContent = hint;
  };

  const showStep = (step: DataStep): void => {
    activeStep = step;
    elements.home.hidden = step !== "home";
    elements.trash.hidden = step !== "trash";
    elements.preview.hidden = step !== "preview";
    elements.routines.hidden = step !== "routines";
    if (step === "routines") refreshRoutines();
    updateHint();
  };

  const entryValue = (item: Extract<DeletedItem, { kind: "entry" }>): string => {
    const unit = item.recordUnit.trim().toUpperCase();
    const value = formatValueForUnit(item.entry.value, unit);
    return ["HRS", "MIN", "SEC"].includes(unit) ? value : `${value} ${unit}`;
  };

  const refreshTrash = (): void => {
    const items = loadTrash();
    const state = getState();
    trashCount = items.length;
    elements.trashList.replaceChildren();
    elements.trashEmpty.hidden = items.length > 0;
    elements.trashSummary.textContent = items.length === 0
      ? "NOTHING IS WAITING FOR RECOVERY"
      : `${plural(items.length, "ITEM")} · KEPT FOR 30 DAYS`;

    for (const item of items) {
      const wrapper = document.createElement("div");
      wrapper.className = "deleted-item";
      wrapper.setAttribute("role", "listitem");

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "deleted-item__restore";
      restore.dataset.restoreDeleted = item.id;

      const copy = document.createElement("span");
      copy.className = "deleted-item__copy";
      const kind = document.createElement("span");
      kind.className = "deleted-item__kind";
      kind.textContent = item.kind.toUpperCase();
      const title = document.createElement("strong");
      title.className = "deleted-item__title";
      title.textContent = item.kind === "record"
        ? item.record.name
        : entryValue(item);
      const meta = document.createElement("small");
      meta.className = "deleted-item__meta";
      const days = daysUntilDeletion(item);
      meta.textContent = item.kind === "record"
        ? `${plural(item.record.entries.length, "ENTRY", "ENTRIES")} · ${plural(days, "DAY")} LEFT`
        : `${item.recordName} · ${item.entry.date} · ${plural(days, "DAY")} LEFT`;
      copy.append(kind, title, meta);

      const action = document.createElement("span");
      action.className = "deleted-item__action";
      let canRestore = true;
      if (item.kind === "record") {
        if (state.records.some((record) => record.id === item.record.id)) {
          canRestore = false;
          action.textContent = "ALREADY RESTORED";
        }
      } else {
        const parent = state.records.find((record) => record.id === item.recordId);
        if (parent === undefined) {
          canRestore = false;
          action.textContent = "RESTORE RECORD FIRST";
        } else if (parent.entries.some((entry) => entry.id === item.entry.id)) {
          canRestore = false;
          action.textContent = "ALREADY RESTORED";
        }
      }
      if (canRestore) action.textContent = "RESTORE";
      restore.disabled = !canRestore || busy;
      restore.setAttribute(
        "aria-label",
        canRestore
          ? `Restore ${item.kind === "record" ? item.record.name : entryValue(item)}`
          : action.textContent,
      );
      restore.append(copy, action);
      wrapper.append(restore);
      elements.trashList.append(wrapper);
    }
    updateHint();
  };

  const refreshOverrideOptions = (): void => {
    const config = getState().routineConfig;
    const selectedDate = elements.routineOverrideDate.value || todayISO();
    elements.routineOverrideDate.value = selectedDate;
    const current = config.overrides.find((override) => override.date === selectedDate);

    elements.routineOverrideSelect.replaceChildren();
    const weekly = document.createElement("option");
    weekly.value = "__weekly__";
    weekly.textContent = "USE WEEKLY SCHEDULE";
    elements.routineOverrideSelect.append(weekly);

    const rest = document.createElement("option");
    rest.value = "__rest__";
    rest.textContent = "REST DAY · SHOW ALL RECORDS";
    elements.routineOverrideSelect.append(rest);

    for (const profile of config.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name.toUpperCase();
      elements.routineOverrideSelect.append(option);
    }

    elements.routineOverrideSelect.value = current === undefined
      ? "__weekly__"
      : current.routineId === null
        ? "__rest__"
        : current.routineId;
  };

  const updateRoutineConfig = (
    updater: (config: ReturnType<typeof normalizeRoutineConfig>) => ReturnType<typeof normalizeRoutineConfig>,
  ): void => {
    const next = updater(getState().routineConfig);
    setState({ routineConfig: normalizeRoutineConfig(next) });
  };

  const renderRoutineEditor = (profile: RoutineProfile): HTMLElement => {
    const wrapper = document.createElement("article");
    wrapper.className = "routine-editor";
    wrapper.setAttribute("role", "listitem");

    const form = document.createElement("form");
    form.className = "routine-editor__form";
    form.dataset.routineForm = "true";
    form.dataset.routineId = profile.id;

    const nameLabel = document.createElement("label");
    nameLabel.className = "form-field form-field--compact";
    const nameHeader = document.createElement("span");
    nameHeader.className = "form-field__header";
    const nameTitle = document.createElement("span");
    nameTitle.className = "form-field__label";
    nameTitle.textContent = "ROUTINE NAME";
    nameHeader.append(nameTitle);
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.required = true;
    nameInput.maxLength = 80;
    nameInput.value = profile.name;
    nameInput.className = "field-input field-input--compact";
    nameLabel.append(nameHeader, nameInput);

    const days = document.createElement("fieldset");
    days.className = "routine-editor__days";
    const daysLegend = document.createElement("legend");
    daysLegend.className = "form-field__label";
    daysLegend.textContent = "DAYS";
    days.append(daysLegend);
    const dayList = document.createElement("div");
    dayList.className = "routine-day-list";
    for (const weekday of ROUTINE_WEEKDAYS) {
      const label = document.createElement("label");
      label.className = "routine-day";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "weekday";
      input.value = String(weekday.value);
      input.checked = profile.weekdays.includes(weekday.value);
      const text = document.createElement("span");
      text.textContent = weekday.label;
      label.append(input, text);
      dayList.append(label);
    }
    days.append(dayList);

    const tagsLabel = document.createElement("label");
    tagsLabel.className = "form-field form-field--compact";
    const tagsHeader = document.createElement("span");
    tagsHeader.className = "form-field__header";
    const tagsTitle = document.createElement("span");
    tagsTitle.className = "form-field__label";
    tagsTitle.textContent = "TAGS";
    const tagsHint = document.createElement("span");
    tagsHint.className = "form-field__hint";
    tagsHint.textContent = "Any match · max 5";
    tagsHeader.append(tagsTitle, tagsHint);
    const tagsInput = document.createElement("input");
    tagsInput.type = "text";
    tagsInput.name = "tags";
    tagsInput.required = true;
    tagsInput.maxLength = 200;
    tagsInput.value = profile.tags.join(", ");
    tagsInput.placeholder = "BACK, BICEPS";
    tagsInput.className = "field-input field-input--compact uppercase";
    tagsLabel.append(tagsHeader, tagsInput);

    const order = document.createElement("div");
    order.className = "routine-editor__order";
    const orderHeader = document.createElement("div");
    orderHeader.className = "routine-editor__order-header";
    const orderTitle = document.createElement("span");
    orderTitle.className = "form-field__label";
    orderTitle.textContent = "CAPTURE ORDER";
    const orderHint = document.createElement("span");
    orderHint.className = "form-field__hint";
    orderHint.textContent = "Optional";
    orderHeader.append(orderTitle, orderHint);
    order.append(orderHeader);

    const matching = recordsForRoutine(getState().records, profile);
    if (matching.length === 0) {
      const empty = document.createElement("p");
      empty.className = "routine-editor__order-empty";
      empty.textContent = "SAVE TAGS TO SEE MATCHING RECORDS";
      order.append(empty);
    } else {
      const orderList = document.createElement("ol");
      orderList.className = "routine-order-list";
      matching.forEach((record, index) => {
        const item = document.createElement("li");
        item.className = "routine-order-item";
        const recordName = document.createElement("span");
        recordName.textContent = record.name;
        const controls = document.createElement("span");
        controls.className = "routine-order-item__controls";
        for (const direction of ["up", "down"] as const) {
          const move = document.createElement("button");
          move.type = "button";
          move.className = "routine-order-item__move";
          move.textContent = direction === "up" ? "↑" : "↓";
          move.dataset.routineMove = record.id;
          move.dataset.routineDirection = direction;
          move.disabled = direction === "up" ? index === 0 : index === matching.length - 1;
          move.setAttribute("aria-label", `${direction === "up" ? "Move up" : "Move down"} ${record.name}`);
          controls.append(move);
        }
        item.append(recordName, controls);
        orderList.append(item);
      });
      order.append(orderList);
    }

    const actions = document.createElement("div");
    actions.className = "routine-editor__actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "button button--primary button--compact";
    save.textContent = "SAVE ROUTINE";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button--danger button--compact";
    remove.textContent = "DELETE";
    remove.dataset.routineDelete = profile.id;
    actions.append(save, remove);

    form.append(nameLabel, days, tagsLabel, order, actions);
    form.addEventListener("submit", onRoutineSubmit, { signal });
    wrapper.append(form);
    return wrapper;
  };

  const routineSchedule = (profile: RoutineProfile): string => {
    if (profile.weekdays.length === 0) return "NO DAYS SET";
    if (profile.weekdays.length === ROUTINE_WEEKDAYS.length) return "EVERY DAY";
    return ROUTINE_WEEKDAYS
      .filter((day) => profile.weekdays.includes(day.value))
      .map((day) => day.label)
      .join(" · ");
  };

  const renderRoutineSummary = (profile: RoutineProfile): HTMLElement => {
    const wrapper = document.createElement("article");
    wrapper.className = "routine-summary";
    wrapper.setAttribute("role", "listitem");

    const copy = document.createElement("div");
    copy.className = "routine-summary__copy";
    const name = document.createElement("strong");
    name.className = "routine-summary__name";
    name.textContent = profile.name;
    const schedule = document.createElement("span");
    schedule.className = "routine-summary__meta";
    const tagSummary = profile.tags.length > 0 ? profile.tags.join(" + ") : "NO TAGS";
    schedule.textContent = `${routineSchedule(profile)} · ${tagSummary}`;
    copy.append(name, schedule);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button button--ghost button--compact";
    edit.textContent = "EDIT";
    edit.dataset.routineEdit = profile.id;
    edit.setAttribute("aria-label", `Edit routine ${profile.name}`);

    wrapper.append(copy, edit);
    return wrapper;
  };

  const refreshRoutines = (): void => {
    const profiles = getState().routineConfig.profiles;
    if (activeRoutineEditorId !== null && !profiles.some((profile) => profile.id === activeRoutineEditorId)) {
      activeRoutineEditorId = null;
    }
    elements.routineList.replaceChildren();
    elements.routineEmpty.hidden = profiles.length > 0;
    for (const profile of profiles) {
      elements.routineList.append(renderRoutineSummary(profile));
      if (profile.id === activeRoutineEditorId) {
        elements.routineList.append(renderRoutineEditor(profile));
      }
    }
    refreshOverrideOptions();
  };

  const onRoutineSubmit = (event: SubmitEvent): void => {
    if (busy) return;
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const routineId = form.dataset.routineId;
    if (routineId === undefined) return;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const tags = parseTagsInput(String(data.get("tags") ?? ""));
    const weekdays = data.getAll("weekday")
      .map((value) => Number(value))
      .filter((value): value is Weekday => Number.isInteger(value) && value >= 0 && value <= 6);
    if (name === "" || tags === undefined) {
      setStatus("ROUTINE NAME AND TAGS ARE REQUIRED", "error");
      return;
    }

    updateRoutineConfig((config) => ({
      ...config,
      profiles: config.profiles.map((profile) =>
        profile.id === routineId
          ? { ...profile, name, tags, weekdays: [...new Set(weekdays)].sort((a, b) => a - b) }
          : profile,
      ),
    }));
    activeRoutineEditorId = null;
    refreshRoutines();
    setStatus("ROUTINE SAVED", "success");
  };

  const onRoutineListClick = (event: MouseEvent): void => {
    if (busy || !(event.target instanceof Element)) return;
    const edit = event.target.closest<HTMLButtonElement>("[data-routine-edit]");
    if (edit !== null) {
      const routineId = edit.dataset.routineEdit;
      if (routineId === undefined) return;
      activeRoutineEditorId = routineId;
      refreshRoutines();
      setStatus("EDIT ROUTINE");
      requestAnimationFrame(() => {
        elements.routineList.querySelector<HTMLInputElement>(
          `[data-routine-id="${routineId}"] input[name="name"]`,
        )?.focus({ preventScroll: true });
      });
      return;
    }

    const remove = event.target.closest<HTMLButtonElement>("[data-routine-delete]");
    if (remove !== null) {
      const routineId = remove.dataset.routineDelete;
      if (routineId === undefined) return;
      const profile = getState().routineConfig.profiles.find((item) => item.id === routineId);
      if (profile === undefined || !window.confirm(`Delete routine ${profile.name}?`)) return;
      updateRoutineConfig((config) => ({
        profiles: config.profiles.filter((item) => item.id !== routineId),
        overrides: config.overrides.map((override) =>
          override.routineId === routineId ? { ...override, routineId: null } : override,
        ),
      }));
      if (activeRoutineEditorId === routineId) activeRoutineEditorId = null;
      refreshRoutines();
      setStatus("ROUTINE DELETED", "success");
      return;
    }

    const move = event.target.closest<HTMLButtonElement>("[data-routine-move]");
    if (move === null) return;
    const form = move.closest<HTMLFormElement>("[data-routine-form]");
    const routineId = form?.dataset.routineId;
    const recordId = move.dataset.routineMove;
    const direction = move.dataset.routineDirection;
    if (
      routineId === undefined ||
      recordId === undefined ||
      (direction !== "up" && direction !== "down")
    ) return;
    const profile = getState().routineConfig.profiles.find((item) => item.id === routineId);
    if (profile === undefined) return;
    const ordered = recordsForRoutine(getState().records, profile).map((record) => record.id);
    const index = ordered.indexOf(recordId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
    const currentRecordId = ordered[index];
    const targetRecordId = ordered[targetIndex];
    if (currentRecordId === undefined || targetRecordId === undefined) return;
    ordered[index] = targetRecordId;
    ordered[targetIndex] = currentRecordId;
    const visible = new Set(ordered);
    updateRoutineConfig((config) => ({
      ...config,
      profiles: config.profiles.map((item) =>
        item.id === routineId
          ? { ...item, recordIds: [...ordered, ...item.recordIds.filter((id) => !visible.has(id))] }
          : item,
      ),
    }));
    refreshRoutines();
  };

  const onRoutineAdd = (): void => {
    if (busy) return;
    const date = new Date();
    const profile: RoutineProfile = {
      id: crypto.randomUUID(),
      name: "New routine",
      weekdays: [date.getDay() as Weekday],
      tags: [],
      recordIds: [],
    };
    updateRoutineConfig((config) => ({
      ...config,
      profiles: [...config.profiles, profile],
    }));
    activeRoutineEditorId = profile.id;
    refreshRoutines();
    setStatus("ADD TAGS THEN SAVE", "neutral");
    requestAnimationFrame(() => {
      elements.routineList.querySelector<HTMLInputElement>(
        `[data-routine-id="${profile.id}"] input[name="name"]`,
      )?.focus({ preventScroll: true });
    });
  };

  const onRoutineOverrideSubmit = (event: SubmitEvent): void => {
    if (busy) return;
    event.preventDefault();
    const date = elements.routineOverrideDate.value;
    const selection = elements.routineOverrideSelect.value;
    if (date === "") {
      setStatus("CHOOSE A DATE", "error");
      return;
    }
    updateRoutineConfig((config) => {
      const overrides = config.overrides.filter((override) => override.date !== date);
      if (selection !== "__weekly__") {
        overrides.push({ date, routineId: selection === "__rest__" ? null : selection });
      }
      return { ...config, overrides };
    });
    refreshOverrideOptions();
    setStatus(selection === "__weekly__" ? "WEEKLY SCHEDULE RESTORED" : "DATE OVERRIDE SAVED", "success");
  };

  const refreshOverview = (): void => {
    const state = getState();
    const recordCount = state.records.length;
    const entryCount = state.records.reduce(
      (count, record) => count + record.entries.length,
      0,
    );
    elements.summary.textContent = `${plural(recordCount, "RECORD")} · ${plural(entryCount, "ENTRY", "ENTRIES")}`;

    const lastBackupAt = loadLastBackupAt();
    elements.lastBackup.textContent = lastBackupAt === null
      ? "NO EXTERNAL BACKUP YET"
      : `LAST BACKUP · ${formatTimestamp(lastBackupAt)}`;
    elements.backup.disabled = busy || recordCount === 0;
    elements.restore.disabled = busy;
    elements.undo.hidden = loadRollback() === null;
    elements.undo.disabled = busy;
    refreshTrash();
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    elements.dialog.toggleAttribute("aria-busy", value);
    elements.confirmRestore.disabled = value;
    elements.cancelRestore.disabled = value;
    elements.routineAdd.disabled = value;
    elements.routineOverrideSave.disabled = value;
    refreshOverview();
  };

  const resetSurfaceMotion = (): void => {
    resetDirectManipulation(elements.surface);
    resetDirectManipulation(elements.content);
  };

  const clearNoticeTimer = (): void => {
    if (noticeTimer === null) return;
    clearTimeout(noticeTimer);
    noticeTimer = null;
  };

  const hideDeletionNotice = (): void => {
    clearNoticeTimer();
    immediateItemId = null;
    hideTransientAction(elements.deletionNotice);
  };

  const showDeletionNotice = (
    message: string,
    itemId: string | null,
    duration = UNDO_VISIBILITY_MS,
  ): void => {
    clearNoticeTimer();
    immediateItemId = itemId;
    elements.deletionUndo.hidden = itemId === null;
    elements.deletionUndo.disabled = false;
    showTransientAction(elements.deletionNotice);
    elements.deletionMessage.textContent = message;
    noticeTimer = setTimeout(hideDeletionNotice, duration);
  };

  const navigateStep = async (
    target: Extract<DataStep, "home" | "trash">,
    focusDestination = false,
  ): Promise<void> => {
    if (busy || activeStep === target || activeStep === "preview") return;
    if (target === "trash" && trashCount === 0) return;
    const outgoing = activeStep === "home" ? elements.home : elements.trash;
    const incoming = target === "home" ? elements.home : elements.trash;
    setBusy(true);
    await transitionUtilityStep(
      outgoing,
      incoming,
      target === "trash" ? "left" : "right",
    );
    activeStep = target;
    setBusy(false);
    updateHint();
    if (focusDestination) {
      if (target === "trash") {
        const firstRestore = elements.trashList.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        );
        (firstRestore ?? elements.close).focus();
      } else {
        (elements.backup.disabled ? elements.restore : elements.backup).focus();
      }
    }
  };

  const closeDialog = (): void => {
    if (!elements.dialog.open || busy) return;
    elements.dialog.close();
  };

  const openDialog = (initialStep: DataStep = "home"): void => {
    if (elements.dialog.open) return;
    pendingBackup = null;
    returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : elements.trigger;
    showStep(initialStep);
    setStatus("");
    refreshOverview();
    elements.dialog.showModal();
    requestAnimationFrame(() => {
      if (initialStep === "routines") {
        elements.routineAdd.focus();
        return;
      }
      (elements.backup.disabled ? elements.restore : elements.backup).focus();
    });
  };

  const openRoutines = (): void => {
    if (!elements.dialog.open) {
      openDialog("routines");
      return;
    }
    pendingBackup = null;
    showStep("routines");
    setStatus("");
    refreshRoutines();
  };

  const onBackup = async (): Promise<void> => {
    if (busy || getState().records.length === 0) return;
    setBusy(true);
    setStatus("PREPARING BACKUP");
    const exportedAt = new Date();

    try {
      const file = createBackupFile(persistedState(), exportedAt);
      const delivery = await deliverBackup(file);
      if (delivery === "cancelled") {
        setStatus("BACKUP CANCELLED");
        return;
      }

      saveLastBackupAt(exportedAt.toISOString());
      refreshOverview();
      setStatus(
        delivery === "shared" ? "BACKUP SHARED" : "BACKUP DOWNLOADED",
        "success",
      );
    } catch (err) {
      console.error("[rec-ord] backup failed:", err);
      const message = err instanceof BackupValidationError
        ? err.message.toUpperCase()
        : "BACKUP COULD NOT BE CREATED";
      setStatus(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const chooseRestoreFile = (): void => {
    if (busy) return;
    elements.file.value = "";
    elements.file.click();
  };

  const onRestoreFile = async (): Promise<void> => {
    const file = elements.file.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    setStatus("CHECKING BACKUP");

    try {
      pendingBackup = await parseBackupFile(file);
      elements.previewFile.textContent = file.name.toUpperCase();
      elements.previewDate.textContent = `EXPORTED · ${formatTimestamp(pendingBackup.exportedAt)}`;
      elements.previewCount.textContent = `${plural(pendingBackup.recordCount, "RECORD")} · ${plural(pendingBackup.entryCount, "ENTRY", "ENTRIES")}`;
      setStatus("");
      showStep("preview");
      elements.confirmRestore.focus();
    } catch (err) {
      pendingBackup = null;
      const expectedValidationFailure = err instanceof BackupValidationError;
      if (!expectedValidationFailure) {
        console.error("[rec-ord] backup could not be read:", err);
      }
      const message = expectedValidationFailure
        ? err.message.toUpperCase()
        : "BACKUP COULD NOT BE READ";
      setStatus(message, "error");
      showStep("home");
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = (): void => {
    if (busy || pendingBackup === null) return;
    setBusy(true);
    setStatus("RESTORING BACKUP");

    if (!flushSave()) {
      setStatus("CURRENT DATA COULD NOT BE SECURED", "error");
      setBusy(false);
      return;
    }

    const current = persistedState();
    if (!saveRollback(current)) {
      setStatus("ROLLBACK COULD NOT BE CREATED", "error");
      setBusy(false);
      return;
    }

    const replacement = pendingBackup.data;
    pendingBackup = null;
    if (!replaceState(replacement)) {
      replaceState(current);
      clearRollback();
      showStep("home");
      refreshOverview();
      setStatus("RESTORE FAILED · CURRENT DATA KEPT", "error");
      setBusy(false);
      return;
    }

    showStep("home");
    refreshOverview();
    setStatus("BACKUP RESTORED · UNDO AVAILABLE", "success");
    setBusy(false);
    elements.undo.focus();
  };

  const undoRestore = (): void => {
    if (busy) return;
    const rollback = loadRollback();
    if (rollback === null) {
      refreshOverview();
      setStatus("NO RESTORE TO UNDO");
      return;
    }

    setBusy(true);
    const current = persistedState();
    if (!replaceState(rollback)) {
      replaceState(current);
      setStatus("UNDO FAILED · RESTORED DATA KEPT", "error");
      setBusy(false);
      return;
    }

    clearRollback();
    refreshOverview();
    setStatus("RESTORE UNDONE", "success");
    setBusy(false);
    (elements.backup.disabled ? elements.restore : elements.backup).focus();
  };

  const requestDeletedRestore = (
    itemId: string,
    source: RestoreDeletedDetail["source"],
  ): void => {
    const detail: RestoreDeletedDetail = { itemId, source };
    document.dispatchEvent(new CustomEvent(RESTORE_DELETED_EVENT, { detail }));
  };

  const onTrashClick = (event: MouseEvent): void => {
    if (busy || !(event.target instanceof Element)) return;
    const restore = event.target.closest<HTMLButtonElement>("[data-restore-deleted]");
    if (restore === null || restore.disabled) return;
    const itemId = restore.dataset.restoreDeleted;
    if (itemId === undefined) return;
    setBusy(true);
    setStatus("RESTORING ITEM");
    requestDeletedRestore(itemId, "trash");
  };

  const onDeletionCreated = (event: Event): void => {
    const detail = (event as CustomEvent<DeletionCreatedDetail>).detail;
    if (detail === undefined) return;
    showDeletionNotice(detail.message, detail.itemId);
    refreshOverview();
  };

  const onDeletionFailed = (event: Event): void => {
    const detail = (event as CustomEvent<DeletionFailedDetail>).detail;
    if (detail === undefined) return;
    showDeletionNotice(detail.message, null, 5_000);
  };

  const onDeletedRestoreResult = (event: Event): void => {
    const detail = (event as CustomEvent<RestoreDeletedResultDetail>).detail;
    if (detail === undefined) return;
    refreshOverview();
    if (detail.source === "immediate") {
      if (detail.success) {
        hideDeletionNotice();
      } else {
        showDeletionNotice(detail.message, detail.itemId);
      }
      return;
    }

    setBusy(false);
    setStatus(detail.message, detail.success ? "success" : "error");
    const nextRestore = elements.trashList.querySelector<HTMLButtonElement>(
      "button:not(:disabled)",
    );
    (nextRestore ?? elements.close).focus();
  };

  const onTrashChanged = (): void => {
    refreshOverview();
  };

  elements.trigger.addEventListener("click", () => openDialog(), { signal });
  elements.trigger.addEventListener("keydown", (event) => event.stopPropagation(), {
    signal,
  });
  elements.close.addEventListener("click", closeDialog, { signal });
  elements.backup.addEventListener("click", () => void onBackup(), { signal });
  elements.restore.addEventListener("click", chooseRestoreFile, { signal });
  elements.undo.addEventListener("click", undoRestore, { signal });
  elements.file.addEventListener("change", () => void onRestoreFile(), { signal });
  elements.confirmRestore.addEventListener("click", confirmRestore, { signal });
  elements.trashList.addEventListener("click", onTrashClick, { signal });
  elements.deletionUndo.addEventListener("click", () => {
    if (immediateItemId === null) return;
    elements.deletionUndo.disabled = true;
    elements.deletionMessage.textContent = "RESTORING ITEM";
    requestDeletedRestore(immediateItemId, "immediate");
  }, { signal });
  elements.cancelRestore.addEventListener("click", () => {
    pendingBackup = null;
    showStep("home");
    setStatus("");
    refreshOverview();
    elements.restore.focus();
  }, { signal });
  elements.routineAdd.addEventListener("click", onRoutineAdd, { signal });
  elements.routineList.addEventListener("click", onRoutineListClick, { signal });
  elements.routineOverride.addEventListener("submit", onRoutineOverrideSubmit, { signal });
  elements.routineBack.addEventListener("click", () => {
    showStep("home");
    setStatus("");
    elements.close.focus();
  }, { signal });

  document.addEventListener(DELETION_CREATED_EVENT, onDeletionCreated, { signal });
  document.addEventListener(DELETION_FAILED_EVENT, onDeletionFailed, { signal });
  document.addEventListener(RESTORE_DELETED_RESULT_EVENT, onDeletedRestoreResult, {
    signal,
  });
  document.addEventListener(TRASH_CHANGED_EVENT, onTrashChanged, { signal });
  document.addEventListener(OPEN_ROUTINES_EVENT, () => openRoutines(), { signal });
  signal.addEventListener("abort", clearNoticeTimer, { once: true });

  elements.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  }, { signal });
  elements.dialog.addEventListener("close", () => {
    pendingBackup = null;
    activeRoutineEditorId = null;
    showStep("home");
    resetSurfaceMotion();
    returnFocus?.focus({ preventScroll: true });
    returnFocus = null;
  }, { signal });
  let suppressDialogClick = false;
  elements.dialog.addEventListener("click", (event) => {
    if (suppressDialogClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressDialogClick = false;
      return;
    }
  }, { signal, capture: true });
  elements.dialog.addEventListener("click", (event) => event.stopPropagation(), {
    signal,
  });
  elements.dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (busy || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "ArrowLeft" && activeStep === "home" && trashCount > 0) {
      event.preventDefault();
      void navigateStep("trash", true);
    } else if (event.key === "ArrowRight" && activeStep === "trash") {
      event.preventDefault();
      void navigateStep("home", true);
    }
  }, { signal });

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let latestX = 0;
  let latestY = 0;
  let dragging = false;
  let eligible = false;
  let canCloseVertically = false;
  let dragAxis: DragAxis | null = null;
  let dragTarget: HTMLElement | null = null;

  const resetPointer = (): void => {
    pointerId = null;
    latestX = 0;
    latestY = 0;
    dragging = false;
    eligible = false;
    canCloseVertically = false;
    dragAxis = null;
    dragTarget = null;
  };

  elements.dialog.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (busy || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (!(event.target instanceof Element)) return;

    const excluded = event.target.closest(
      "input, a, [contenteditable='true'], [data-data-close]",
    );
    const scrollRegion = event.target.closest<HTMLElement>("[data-data-content]");
    eligible = excluded === null;
    if (!eligible) return;
    canCloseVertically = scrollRegion === null || scrollRegion.scrollTop <= 0;

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    latestX = 0;
    latestY = 0;
    dragging = false;
  }, { signal });

  elements.dialog.addEventListener("pointermove", (event) => {
    event.stopPropagation();
    if (!eligible || pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_LOCK_DISTANCE) return;
      if (Math.abs(dx) > Math.abs(dy)) {
        dragAxis = "horizontal";
        dragTarget = elements.content;
      } else if (dy > 0 && canCloseVertically) {
        dragAxis = "vertical";
        dragTarget = elements.surface;
      } else {
        eligible = false;
        return;
      }
      dragging = true;
      suppressDialogClick = true;
      beginDirectManipulation(dragTarget);
      try {
        dragTarget.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is optional.
      }
    }

    event.preventDefault();
    latestX = dx;
    latestY = dy;
    if (dragAxis === "horizontal") {
      updateDragFeedback(elements.content, rubberBand(dx), 0);
    } else {
      updateDragFeedback(elements.surface, 0, rubberBand(dy));
    }
  }, { signal });

  const finishPointer = (event: PointerEvent, allowClose: boolean): void => {
    event.stopPropagation();
    if (pointerId !== event.pointerId) return;
    if (dragging) {
      if (dragAxis === "vertical") {
        if (allowClose && latestY >= SWIPE_CLOSE_DISTANCE) {
          closeDialog();
        } else if (prefersReducedMotion()) {
          resetDirectManipulation(elements.surface);
        } else {
          springBack(elements.surface);
        }
      } else {
        const navigateToTrash =
          allowClose &&
          activeStep === "home" &&
          trashCount > 0 &&
          latestX <= -SWIPE_NAV_DISTANCE;
        const navigateToHome =
          allowClose &&
          activeStep === "trash" &&
          latestX >= SWIPE_NAV_DISTANCE;
        if (navigateToTrash || navigateToHome) {
          resetDirectManipulation(elements.content);
          void navigateStep(navigateToTrash ? "trash" : "home");
        } else if (prefersReducedMotion()) {
          resetDirectManipulation(elements.content);
        } else {
          springBack(elements.content);
        }
      }
    }
    try {
      if (dragTarget?.hasPointerCapture(event.pointerId)) {
        dragTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The browser may have released capture already.
    }
    if (dragging) {
      window.setTimeout(() => {
        suppressDialogClick = false;
      }, 0);
    }
    resetPointer();
  };

  elements.dialog.addEventListener("pointerup", (event) => {
    finishPointer(event, true);
  }, { signal });
  elements.dialog.addEventListener("pointercancel", (event) => {
    finishPointer(event, false);
  }, { signal });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeDataUtility, { once: true });
} else {
  initializeDataUtility();
}
