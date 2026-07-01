/**
 * rec-ord — Domain types
 *
 * A `Record` is a single thing the user is tracking (e.g. "Days without
 * smoking", "Weight", "Sleep"). Each record owns an ordered list of `Entry`s
 * (one per measurement). Entries are ordered newest-first by date.
 *
 * The app is generic: there is no notion of "exercise" or "PR" — only named
 * records with a value + unit + date, identical regardless of what the user
 * is tracking.
 */

export interface Entry {
  id: string; // crypto.randomUUID()
  value: number; // the measured value (positive number; sign of the delta comes from the ordering)
  date: string; // ISO date "YYYY-MM-DD" (local-time interpretation)
  note?: string; // reserved for future use; intentionally unused for now
}

/**
 * Optional "goal direction" for a record: which way is "better"?
 *   - "up":   more is better (e.g. a streak, sleep, meditation)
 *   - "down": less is better (e.g. weight loss goal)
 *   - null / undefined: no preference (purely a measurement)
 *
 * Records migrated from older builds (no field) are treated as null.
 */
export type Direction = "up" | "down" | null;

export interface Record {
  id: string; // crypto.randomUUID()
  name: string; // free text — e.g. "Days without smoking", "Weight"
  unit: string; // free text — e.g. "DAYS", "KG", "HRS", "MIN", "CAL"
  entries: Entry[]; // newest entry at index 0 (sorted by date desc on write)
  createdAt: string; // ISO timestamp; used to order records (newest first)
  direction?: Direction; // optional goal direction (default: null = neutral)
}

/** The top-level view the app is showing. */
export type View = "focus" | "new" | "grid";

/**
 * Full client-side app state.
 *
 * Persisted (records + currentRecordId): the user's data.
 * Resets on reload (view, expanded, addingEntry): clean reopen behavior.
 */
export interface AppState {
  records: Record[]; // ordered newest-record-first (records[0] = most recently created)
  currentRecordId: string | null; // which record is in focus; null when 0 records
  view: View;
  expanded: boolean; // long-press edit expansion of the current focus card
  addingEntry: boolean; // whether the inline "+ new entry" form is open inside edit
}

/** The shape that is actually persisted to localStorage. */
export interface PersistedState {
  records: Record[];
  currentRecordId: string | null;
}
