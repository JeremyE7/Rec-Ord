/**
 * rec-ord — localStorage persistence
 *
 * Persists only the durable data (records + currentRecordId) under a single
 * key. The UI view (focus/expanded/addingEntry) is NOT persisted — on
 * reload the user reopens the app on the current focus, collapsed.
 *
 * Saves are debounced (200ms) to coalesce bursts of mutations (e.g. the
 * multiple state changes during a swipe-release).
 */

import type { PersistedState } from "./types";

const STORAGE_KEY = "rec-ord:state:v1";
const ROLLBACK_KEY = "rec-ord:rollback:v1";
const LAST_BACKUP_KEY = "rec-ord:last-backup:v1";
const DEBOUNCE_MS = 200;

function isPersistedState(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PersistedState>;
  if (!Array.isArray(v.records)) return false;
  if (v.currentRecordId !== null && typeof v.currentRecordId !== "string") {
    return false;
  }
  // Light shape check on each record — a corrupt entry should not crash the app.
  for (const r of v.records) {
    if (typeof r !== "object" || r === null) return false;
    const rec = r as {
      id?: unknown;
      name?: unknown;
      unit?: unknown;
      entries?: unknown;
      direction?: unknown;
    };
    if (typeof rec.id !== "string") return false;
    if (typeof rec.name !== "string") return false;
    if (typeof rec.unit !== "string") return false;
    if (!Array.isArray(rec.entries)) return false;
    // `direction` is optional; when present it must be "up", "down", or null.
    if (rec.direction !== undefined && rec.direction !== null) {
      if (rec.direction !== "up" && rec.direction !== "down") return false;
    }
  }
  return true;
}

/** Reads persisted state. A first visit starts empty. Returns null only on
 *  malformed JSON or storage errors. */
export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return { records: [], currentRecordId: null };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedState(parsed)) {
      console.error("[rec-ord] persisted state failed shape check; ignoring");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("[rec-ord] failed to load state:", err);
    return null;
  }
}

/** Coerces a loaded PersistedState to runtime-safe shape (entries sorted, ids valid). */
export function normalize(loaded: PersistedState | null): PersistedState {
  if (loaded === null) return { records: [], currentRecordId: null };
  // Re-sort each record's entries newest-first by date. A corrupt entry that
  // can't be parsed is dropped silently.
  const records = loaded.records
    .map((r) => ({
      ...r,
      entries: [...r.entries]
        .filter(
          (e): e is { id: string; value: number; date: string; note?: string } =>
            typeof e?.id === "string" &&
            typeof e?.value === "number" &&
            Number.isFinite(e.value) &&
            typeof e?.date === "string",
        )
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    }))
    // Drop records that lost all their entries (they have nothing to show).
    .filter((r) => r.entries.length > 0);

  const ids = new Set(records.map((r) => r.id));
  const currentRecordId =
    loaded.currentRecordId !== null && ids.has(loaded.currentRecordId)
      ? loaded.currentRecordId
      : (records[0]?.id ?? null);

  return { records, currentRecordId };
}

/* ---------------------------------------------------------------------------
 * Backup metadata and session rollback
 * ------------------------------------------------------------------------- */

/** Stores one pre-restore snapshot for this browser session. */
export function saveRollback(state: PersistedState): boolean {
  try {
    sessionStorage.setItem(ROLLBACK_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("[rec-ord] failed to save restore rollback:", err);
    return false;
  }
}

/** Returns the pre-restore snapshot when it is still valid. */
export function loadRollback(): PersistedState | null {
  try {
    const raw = sessionStorage.getItem(ROLLBACK_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedState(parsed)) {
      sessionStorage.removeItem(ROLLBACK_KEY);
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("[rec-ord] failed to load restore rollback:", err);
    return null;
  }
}

export function clearRollback(): void {
  try {
    sessionStorage.removeItem(ROLLBACK_KEY);
  } catch (err) {
    console.error("[rec-ord] failed to clear restore rollback:", err);
  }
}

export function saveLastBackupAt(timestamp: string): boolean {
  if (!Number.isFinite(Date.parse(timestamp))) return false;
  try {
    localStorage.setItem(LAST_BACKUP_KEY, timestamp);
    return true;
  } catch (err) {
    console.error("[rec-ord] failed to save backup timestamp:", err);
    return false;
  }
}

export function loadLastBackupAt(): string | null {
  try {
    const timestamp = localStorage.getItem(LAST_BACKUP_KEY);
    if (timestamp === null || !Number.isFinite(Date.parse(timestamp))) return null;
    return timestamp;
  } catch (err) {
    console.error("[rec-ord] failed to load backup timestamp:", err);
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * Debounced save
 * ------------------------------------------------------------------------- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: PersistedState | null = null;

function flush(): boolean {
  if (pendingState === null) return true;
  const toSave = pendingState;
  pendingState = null;
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    return true;
  } catch (err) {
    console.error("[rec-ord] failed to save state:", err);
    return false;
  }
}

/** Schedules a debounced save. Coalesces multiple calls within DEBOUNCE_MS. */
export function saveState(records: PersistedState["records"], currentRecordId: string | null): void {
  pendingState = { records, currentRecordId };
  if (saveTimer !== null) return;
  saveTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** Force any pending debounced save to run immediately. */
export function flushSave(): boolean {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    return flush();
  }
  return true;
}
