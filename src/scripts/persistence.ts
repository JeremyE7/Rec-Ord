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

import type { Entry, PersistedState, Record } from "./types";

const STORAGE_KEY = "rec-ord:state:v1";
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

/** Reads persisted state. If absent, returns the seed data so first-time
 *  visitors land on a populated app. Returns null only on malformed JSON or
 *  storage errors. */
export function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      // First-ever visit: hand back the seed. The store subscriber saves it
      // to localStorage on the first render, so the seed becomes permanent
      // (the next visit will read the saved copy).
      return getSeedData();
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
 * Debounced save
 * ------------------------------------------------------------------------- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: PersistedState | null = null;

function flush(): void {
  if (pendingState === null) return;
  const toSave = pendingState;
  pendingState = null;
  saveTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (err) {
    console.error("[rec-ord] failed to save state:", err);
  }
}

/** Schedules a debounced save. Coalesces multiple calls within DEBOUNCE_MS. */
export function saveState(records: PersistedState["records"], currentRecordId: string | null): void {
  pendingState = { records, currentRecordId };
  if (saveTimer !== null) return;
  saveTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** Force any pending debounced save to run immediately. */
export function flushSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    flush();
  }
}

/* ---------------------------------------------------------------------------
 * Seed data (first-visit examples + "LOAD EXAMPLES" button payload)
 *
 * Five diverse records demonstrating the generic nature of the tracker
 * (days, hours, weight, minutes). All dates are computed relative to "now"
 * so the seed always looks fresh, and the first record (most recent) is
 * the one the user lands on.
 * ------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

export function getSeedData(): PersistedState {
  const now = new Date();
  const isoNow = now.toISOString();
  const daysAgo = (n: number): string => {
    const d = new Date(now.getTime() - n * DAY_MS);
    // ISO-8601 always starts with "YYYY-MM-DD"; .slice is the type-safe
    // equivalent of .split("T")[0] under `noUncheckedIndexedAccess`.
    return d.toISOString().slice(0, 10);
  };
  const makeEntry = (value: number, daysBack: number): Entry => ({
    id: crypto.randomUUID(),
    value,
    date: daysAgo(daysBack),
  });

  const records: Record[] = [
    {
      id: crypto.randomUUID(),
      name: "STREAK",
      unit: "DAYS",
      createdAt: isoNow,
      entries: [
        makeEntry(30, 0),
        makeEntry(25, 6),
        makeEntry(20, 13),
        makeEntry(15, 21),
        makeEntry(10, 28),
        makeEntry(5, 35),
      ],
    },
    {
      id: crypto.randomUUID(),
      name: "WEIGHT",
      unit: "KG",
      createdAt: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
      entries: [
        makeEntry(78.2, 0),
        makeEntry(78.5, 3),
        makeEntry(78.8, 7),
        makeEntry(79.1, 12),
        makeEntry(79.4, 18),
        makeEntry(79.8, 25),
      ],
    },
    {
      id: crypto.randomUUID(),
      name: "SLEEP",
      unit: "HRS",
      createdAt: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
      entries: [
        makeEntry(7.5, 0),
        makeEntry(6.8, 1),
        makeEntry(7.2, 2),
        makeEntry(8.0, 3),
        makeEntry(7.0, 4),
      ],
    },
    {
      id: crypto.randomUUID(),
      name: "MEDITATION",
      unit: "MIN",
      createdAt: new Date(now.getTime() - 14 * DAY_MS).toISOString(),
      entries: [
        makeEntry(20, 0),
        makeEntry(15, 1),
        makeEntry(25, 2),
        makeEntry(10, 4),
      ],
    },
    {
      id: crypto.randomUUID(),
      name: "WORKOUT",
      unit: "MIN",
      createdAt: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
      entries: [
        makeEntry(45, 0),
        makeEntry(30, 1),
        makeEntry(60, 3),
        makeEntry(40, 4),
      ],
    },
  ];

  // `records` is defined inline above with five entries, so the first
  // element always exists at runtime. The `if` is for
  // `noUncheckedIndexedAccess` (which otherwise widens `records[0]`
  // to `Record | undefined`).
  const first = records[0];
  if (first === undefined) {
    throw new Error("getSeedData: seed records array is empty");
  }
  return {
    records,
    currentRecordId: first.id,
  };
}
