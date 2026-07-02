/**
 * rec-ord — Motion + formatting helpers
 *
 * `commit(update, transitionName)` wraps a DOM mutation in
 * `document.startViewTransition()` and tags the document with
 * `data-transition="<name>"` so `motion.css` can pick the right keyframes
 * for the case. Honors `prefers-reduced-motion: reduce` by skipping the
 * View Transitions API entirely and applying the update synchronously.
 *
 * The formatters (formatValue, formatDelta, formatRelativeDate) are
 * the single source of truth for the strings shown in the UI.
 */

import type { Entry, Record } from "./types";

/* ---------------------------------------------------------------------------
 * View transition wrapper
 * ------------------------------------------------------------------------- */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Returns the current value of `prefers-reduced-motion`. Cached per call. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

/**
 * Wrap a DOM mutation in a browser view transition.
 *
 * - `transitionName` becomes `document.documentElement.dataset.transition`,
 *   which the `motion.css` rules key on to select the right keyframes.
 * - On reduced motion (or when the browser lacks `startViewTransition`),
 *   the update is applied synchronously without any animation.
 * - The `data-transition` attribute is cleared on the next `transitionend`
 *   on the documentElement so it doesn't leak into the next transition.
 */
export function commit(update: () => void, transitionName: string): void {
  const root = document.documentElement;

  const apply = (): void => {
    root.dataset.transition = transitionName;
    update();
  };

  const cleanup = (): void => {
    if (root.dataset.transition === transitionName) {
      delete root.dataset.transition;
    }
  };

  if (prefersReducedMotion() || typeof document.startViewTransition !== "function") {
    apply();
    // Best-effort cleanup: clear the attribute after a microtask so any
    // synchronous CSS that read it had a chance to.
    queueMicrotask(cleanup);
    return;
  }

  document.startViewTransition(() => {
    apply();
    return Promise.resolve();
  });

  // Clear the attribute once the view transition completes (its root
  // pseudo-element fires `transitionend`). The `once: true` flag is
  // important — we don't want to accidentally fire on inner transitions.
  root.addEventListener("transitionend", cleanup, { once: true });

  // Failsafe: if no transitionend ever fires (e.g. some browsers don't
  // emit it on the documentElement pseudo), clear after 1s anyway.
  setTimeout(cleanup, 1000);
}

/* ---------------------------------------------------------------------------
 * Value formatters
 * ------------------------------------------------------------------------- */

/**
 * Formats a number for the hero / value display.
 *
 * Rules:
 *  - Trailing `.0` is stripped (25 not 25.0, 25.5 stays 25.5).
 *  - Up to 1 decimal place.
 *  - If the number is an integer, returns the integer string.
 *  - If the value is finite and < 1e6, formats normally. Otherwise returns
 *    the raw string (we don't need a compact notation for personal tracking).
 *
 * Examples:
 *   formatValue(25)      -> "25"
 *   formatValue(25.5)    -> "25.5"
 *   formatValue(25.05)   -> "25"
 *   formatValue(25.50)   -> "25.5"
 */
export function formatValue(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Round to 1 decimal to drop floating-point dust, then strip trailing zeros.
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  // `toFixed(1)` is locale-independent (always "." as decimal) — we want
  // the hero to render `25.5` even in locales that would prefer `25,5`.
  return rounded.toFixed(1).replace(/\.0$/, "");
}

/**
 * Formats a signed delta between two values as `+X` / `−X` with the unit
 * appended. Uses the U+2212 MINUS SIGN, not a hyphen.
 *
 * The delta is `(newer - older)` — positive means the new value is larger.
 * For entries, the latest entry is the "newer" and the entry before it is
 * the "older".
 *
 * Examples:
 *   formatDelta(5,  25) -> "+5 DAYS"
 *   formatDelta(-0.6, 0) -> "−0.6 KG"
 *   formatDelta(0,  25) -> "+0 DAYS"   (display 0, not empty)
 */
export function formatDelta(newer: number, older: number, unit: string): string {
  const raw = newer - older;
  const sign = raw > 0 ? "+" : raw < 0 ? "\u2212" : "+"; // U+2212 MINUS SIGN
  return `${sign}${formatValue(Math.abs(raw))} ${unit}`;
}

/* ---------------------------------------------------------------------------
 * Date formatters
 *
 * `parseLocalDate` parses "YYYY-MM-DD" as a LOCAL date (not UTC), which is
 * what users mean when they enter a date in a date input. This avoids the
 * classic "entered June 28, displayed June 27" off-by-one in timezones
 * west of UTC.
 * ------------------------------------------------------------------------- */

export function parseLocalDate(iso: string): Date {
  const parts = iso.split("-");
  if (parts.length !== 3) return new Date(NaN);
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return new Date(NaN);
  }
  return new Date(y, m - 1, d);
}

/** Today as an ISO "YYYY-MM-DD" string in the user's local timezone. */
export function todayISO(): string {
  return isoDate(new Date());
}

/** Converts a Date to "YYYY-MM-DD" in the user's local timezone. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Returns the start-of-day for a given date (00:00:00.000 local). */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Returns the number of whole calendar days between two ISO dates
 * (`b - a` in days). Uses the user's local timezone.
 */
function daysBetween(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Formats an entry's date as a short relative label.
 *
 *   "TODAY"     if same calendar day
 *   "YESTERDAY" if 1 day ago
 *   "ND AGO"    for 2..6 days ago (e.g. "3D AGO")
 *   "1W AGO"    for 7..13 days ago
 *   "MON DD"    for older (e.g. "JUN 28"), via Intl
 */
export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const d = parseLocalDate(iso);
  if (Number.isNaN(d.getTime())) return iso.toUpperCase();
  const days = daysBetween(d, now);
  if (days === 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  if (days >= 2 && days <= 6) return `${days}D AGO`;
  if (days >= 7 && days <= 13) return "1W AGO";
  // Older — format as "MON DD" using Intl for locale-correct month abbreviation.
  // We force "en-US" so the labels are stable across the user's locale (this
  // is a personal app and the visual language is fixed).
  const monthFmt = new Intl.DateTimeFormat("en-US", { month: "short" }).format(d).toUpperCase();
  return `${monthFmt} ${d.getDate()}`;
}

/* ---------------------------------------------------------------------------
 * Record helpers
 * ------------------------------------------------------------------------- */

/** Sorts a record's entries newest-first by date (stable for equal dates). */
export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** Returns the latest entry of a record, or null if it has no entries. */
export function latestEntry(record: Record): Entry | null {
  return record.entries[0] ?? null;
}

/** Returns the second-latest entry (the "previous" baseline), or null. */
export function previousEntry(record: Record): Entry | null {
  return record.entries[1] ?? null;
}

/** Builds a new empty Entry. */
export function makeEntry(value: number, date: string, id?: string): Entry {
  return { id: id ?? crypto.randomUUID(), value, date };
}

/** Builds a new empty Record (no entries yet). */
export function makeRecord(
  name: string,
  unit: string,
  firstEntry: Entry,
  direction?: "up" | "down" | null,
): Record {
  const record: Record = {
    id: crypto.randomUUID(),
    name: name.trim(),
    unit: unit.trim().toUpperCase(),
    entries: [firstEntry],
    createdAt: new Date().toISOString(),
  };
  // Only attach the field if a real direction was chosen — keeps the
  // shape clean for the common case (no preference) and makes the
  // focus view's `record.direction` check trivial.
  if (direction === "up" || direction === "down") {
    record.direction = direction;
  }
  return record;
}

/**
 * Returns true when `newValue` strictly beats every OTHER entry's value
 * in the record's "good" direction.
 *
 *   - "up"   → newValue > Math.max(...otherValues)
 *   - "down" → newValue < Math.min(...otherValues)
 *   - null/undefined → always false (no "best" concept)
 *   - no other entries → always false (nothing to beat)
 *
 * `newEntryId` is the id of the entry being considered; it MUST be
 * excluded from `otherValues`. For an add, this is the id of the new
 * entry (which is already in `record.entries` when this is called). For
 * an edit, this is the id of the entry being edited (its value in
 * `record.entries` is the NEW value, which is what we want to compare).
 *
 * Used by the "nuevo récord" glow pulse on the hero.
 */
export function isNewBest(
  record: Record,
  newEntryId: string,
  newValue: number,
): boolean {
  if (record.direction !== "up" && record.direction !== "down") return false;
  const otherValues: number[] = [];
  for (const e of record.entries) {
    if (e.id === newEntryId) continue;
    otherValues.push(e.value);
  }
  if (otherValues.length === 0) return false;
  if (record.direction === "up") {
    let max = otherValues[0]!;
    for (const v of otherValues) {
      if (v > max) max = v;
    }
    return newValue > max;
  }
  // direction === "down"
  let min = otherValues[0]!;
  for (const v of otherValues) {
    if (v < min) min = v;
  }
  return newValue < min;
}
