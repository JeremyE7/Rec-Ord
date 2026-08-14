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
import { formatValueForUnit } from "./record-utils";
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
import type { PersistedState } from "./types";

interface DataElements {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
  surface: HTMLElement;
  content: HTMLElement;
  close: HTMLButtonElement;
  home: HTMLElement;
  trash: HTMLElement;
  preview: HTMLElement;
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
  hint: HTMLElement;
  deletionNotice: HTMLElement;
  deletionMessage: HTMLElement;
  deletionUndo: HTMLButtonElement;
}

type StatusTone = "neutral" | "success" | "error";
type DataStep = "home" | "preview" | "trash";
type DragAxis = "horizontal" | "vertical";

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
  return { records: state.records, currentRecordId: state.currentRecordId };
}

function replaceState(data: PersistedState): boolean {
  const restored = normalize(data);
  setState({
    records: restored.records,
    currentRecordId: restored.currentRecordId,
    view: "focus",
    expanded: false,
    addingEntry: false,
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

  const setStatus = (message: string, tone: StatusTone = "neutral"): void => {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
  };

  const updateHint = (): void => {
    let hint: string;
    if (activeStep === "trash") {
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

  const openDialog = (): void => {
    if (elements.dialog.open) return;
    pendingBackup = null;
    returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : elements.trigger;
    showStep("home");
    setStatus("");
    refreshOverview();
    elements.dialog.showModal();
    requestAnimationFrame(() => {
      (elements.backup.disabled ? elements.restore : elements.backup).focus();
    });
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

  elements.trigger.addEventListener("click", openDialog, { signal });
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

  document.addEventListener(DELETION_CREATED_EVENT, onDeletionCreated, { signal });
  document.addEventListener(DELETION_FAILED_EVENT, onDeletionFailed, { signal });
  document.addEventListener(RESTORE_DELETED_RESULT_EVENT, onDeletedRestoreResult, {
    signal,
  });
  document.addEventListener(TRASH_CHANGED_EVENT, onTrashChanged, { signal });
  signal.addEventListener("abort", clearNoticeTimer, { once: true });

  elements.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  }, { signal });
  elements.dialog.addEventListener("close", () => {
    pendingBackup = null;
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
