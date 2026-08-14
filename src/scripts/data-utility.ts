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
  prefersReducedMotion,
  rubberBand,
  springBack,
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
import { getState, setState } from "./store";
import type { PersistedState } from "./types";

interface DataElements {
  trigger: HTMLButtonElement;
  dialog: HTMLDialogElement;
  surface: HTMLElement;
  content: HTMLElement;
  close: HTMLButtonElement;
  home: HTMLElement;
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
}

type StatusTone = "neutral" | "success" | "error";

const SWIPE_LOCK_DISTANCE = 12;
const SWIPE_CLOSE_DISTANCE = 72;

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

  if (
    trigger === null ||
    dialog === null ||
    surface === null ||
    content === null ||
    close === null ||
    home === null ||
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
    cancelRestore === null
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

  const setStatus = (message: string, tone: StatusTone = "neutral"): void => {
    elements.status.textContent = message;
    elements.status.dataset.tone = tone;
  };

  const showStep = (step: "home" | "preview"): void => {
    elements.home.hidden = step !== "home";
    elements.preview.hidden = step !== "preview";
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
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    elements.dialog.toggleAttribute("aria-busy", value);
    elements.confirmRestore.disabled = value;
    elements.cancelRestore.disabled = value;
    refreshOverview();
  };

  const resetSurfaceMotion = (): void => {
    elements.surface.removeAttribute("style");
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
  elements.cancelRestore.addEventListener("click", () => {
    pendingBackup = null;
    showStep("home");
    setStatus("");
    refreshOverview();
    elements.restore.focus();
  }, { signal });

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
  elements.dialog.addEventListener("click", (event) => event.stopPropagation(), {
    signal,
  });
  elements.dialog.addEventListener("keydown", (event) => event.stopPropagation(), {
    signal,
  });

  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let latestY = 0;
  let dragging = false;
  let eligible = false;

  const resetPointer = (): void => {
    pointerId = null;
    latestY = 0;
    dragging = false;
    eligible = false;
  };

  elements.dialog.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (busy || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (!(event.target instanceof HTMLElement)) return;

    const interactive = event.target.closest("button, input, a, [contenteditable='true']");
    const scrollRegion = event.target.closest<HTMLElement>("[data-data-content]");
    eligible = interactive === null && (scrollRegion === null || scrollRegion.scrollTop <= 0);
    if (!eligible) return;

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
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
      if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
        eligible = false;
        return;
      }
      dragging = true;
      beginDirectManipulation(elements.surface);
      try {
        elements.surface.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is optional.
      }
    }

    event.preventDefault();
    latestY = dy;
    updateDragFeedback(elements.surface, 0, rubberBand(dy));
  }, { signal });

  const finishPointer = (event: PointerEvent, allowClose: boolean): void => {
    event.stopPropagation();
    if (pointerId !== event.pointerId) return;
    if (dragging) {
      if (allowClose && latestY >= SWIPE_CLOSE_DISTANCE) {
        closeDialog();
      } else if (prefersReducedMotion()) {
        resetSurfaceMotion();
      } else {
        springBack(elements.surface);
      }
    }
    try {
      if (elements.surface.hasPointerCapture(event.pointerId)) {
        elements.surface.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The browser may have released capture already.
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
