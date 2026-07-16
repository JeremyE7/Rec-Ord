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
import {
  collapse,
  expand,
  fade,
  navVertical,
  pushHorizontal,
  scaleMorph,
} from "./view-transitions";

/* ---------------------------------------------------------------------------
 * View transition wrapper
 * ------------------------------------------------------------------------- */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Returns the current value of `prefers-reduced-motion`. Cached per call. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

/**
 * Wrap a DOM mutation in a view transition.
 *
 * - Captures the old element before the update
 * - Applies the DOM mutation
 * - Captures the new element
 * - Animates old out + new in using the appropriate transition function
 * - On reduced motion, the update is applied synchronously without animation
 *
 * The `transitionName` determines which transition function to use:
 *   - "nav-vertical" → slide up/down (swipe between records)
 *   - "push-horizontal-in" → slide right (focus → new-record)
 *   - "push-horizontal-out" → slide left (new-record → focus)
 *   - "expand" → fade + grow (focus → expanded)
 *   - "collapse" → fade + shrink (expanded → focus)
 *   - "scale-morph" → scale down/up (focus ↔ grid)
 *   - "fade" → simple crossfade (non-semantic changes)
 */
export async function commit(
  update: () => void,
  transitionName: string,
  container?: HTMLElement,
): Promise<void> {
  const mount = container ?? document.getElementById("app");
  if (mount === null) {
    update();
    return;
  }

  // Capture the old element
  const oldEl = mount.firstElementChild as HTMLElement | null;

  // Apply the DOM mutation
  update();

  // Capture the new element
  const newEl = mount.firstElementChild as HTMLElement | null;

  // If there's no old/new element, or they're the same, we're done
  if (oldEl === null || newEl === null || oldEl === newEl) {
    return;
  }

  // If reduced motion, skip animations
  if (prefersReducedMotion()) {
    return;
  }

  // Route to the appropriate transition function
  switch (transitionName) {
    case "nav-vertical":
      // Direction is determined by the gesture handler, but we default to "up"
      // The gesture handler should pass the direction via a custom event or
      // by setting a data attribute. For now, we'll use "up" as default.
      await navVertical({
        oldEl,
        newEl,
        direction: "up", // TODO: get from gesture context
      });
      break;

    case "push-horizontal-in":
      await pushHorizontal({ oldEl, newEl, direction: "in" });
      break;

    case "push-horizontal-out":
      await pushHorizontal({ oldEl, newEl, direction: "out" });
      break;

    case "expand":
      await expand({ oldEl, newEl });
      break;

    case "collapse":
      await collapse({ oldEl, newEl });
      break;

    case "scale-morph":
      // Direction is determined by the gesture (pinch out = "out", pinch in = "in")
      // For now, default to "out" (opening the grid)
      await scaleMorph({ oldEl, newEl, direction: "out" }); // TODO: get from gesture context
      break;

    case "fade":
    default:
      await fade({ oldEl, newEl });
      break;
  }
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
 * FALLBACK ONLY: this function does not know the record's unit. For
 * unit-aware formatting (time → "1h 30m", weight → "78.2", distance
 * → "30" with no decimal), use `formatValueForUnit(n, unit)` which
 * is the preferred entry point for new code. The fallback here is
 * kept for code paths that don't have the unit handy (and for
 * `formatDelta` which builds on it).
 *
 * Examples:
 *   formatValue(25)      -> "25"
 *   formatValue(25.5)    -> "25.5"
 *   formatValue(25.05)   -> "25"
 *   formatValue(25.50)   -> "25.5"
 */
export function formatValue(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // 3+ digit values (>= 100 or <= -100): round to integer, no decimals.
  // A value like 225.7 becomes "226" — large enough that the decimal
  // isn't meaningful. 1–2 digit values keep their decimals (78.2
  // stays "78.2").
  if (Math.abs(n) >= 100) return String(Math.round(n));
  // Round to 1 decimal to drop floating-point dust, then strip trailing zeros.
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  // `toFixed(1)` is locale-independent (always "." as decimal) — we want
  // the hero to render `25.5` even in locales that would prefer `25,5`.
  return rounded.toFixed(1).replace(/\.0$/, "");

}

/* ---------------------------------------------------------------------------
 * Unit-aware formatting
 *
 * The format of a record's value depends on its unit:
 *   - Time (HRS, MIN, SEC): "1h 30m" / "45m" / "1m 30s" — the time
 *     format already conveys the unit.
 *   - Decimal (KG, LBS): "78.2" — keep precision (weight often has
 *     a meaningful decimal).
 *   - Integer (KM, MI, REPS, DAYS, STEPS, CAL, …): "30" — no decimal.
 *     "30.5 km" doesn't make sense; "30 km" does.
 *
 * `formatValueForUnit(n, unit)` is the preferred entry point for
 * rendering a value. `formatValue(n)` is kept as a fallback for code
 * paths that don't have the unit handy.
 * ------------------------------------------------------------------------- */

export function formatValueForUnit(n: number, unit: string): string {
  if (!Number.isFinite(n)) return String(n);
  const u = unit.toUpperCase().trim();

  // Time units — format as Xh Ym / Xm / Xs. The time format already
  // conveys the unit, so callers don't need to append the unit again.
  if (u === "HRS") return formatHours(n);
  if (u === "MIN") return formatMinutes(n);
  if (u === "SEC") return formatSeconds(n);

  // Everything else (KG, LBS, KM, MI, REPS, DAYS, STEPS, HRS, …):
  // NO DECIMALS. "78.2 kg" doesn't make sense — the user explicitly
  // said "kilogramos tambien tiene decimales y deberia ser solo el
  // entero". "7.5 hours" is meaningless; it should be "7h 30m" but
  // HRS is already handled above. For every non-time unit, round to
  // the nearest integer.
  return String(Math.round(n));
}

function formatHours(n: number): string {
  const hours = Math.floor(n);
  const minutes = Math.round((n - hours) * 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatMinutes(n: number): string {
  if (n >= 60) return formatHours(n / 60); // 90m -> "1h 30m"
  const minutes = Math.floor(n);
  const seconds = Math.round((n - minutes) * 60);
  if (seconds === 0) return `${minutes}m`;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatSeconds(n: number): string {
  if (n >= 60) return formatMinutes(n / 60); // 90s -> "1m 30s"
  return `${Math.round(n)}s`;
}

/**
 * Formats a signed delta between two values as `+X` / `−X` with the unit
 * appended. Uses the U+2212 MINUS SIGN, not a hyphen.
 *
 * The delta is `(newer - older)` — positive means the new value is larger.
 * For entries, the latest entry is the "newer" and the entry before it is
 * the "older".
 *
 * For time units (HRS/MIN/SEC), the formatted value already includes
 * the time unit ("1h 30m"), so we DON'T append the unit again. For
 * every other unit we append the unit string ("+5 KM", "−0.3 KG").
 *
 * Examples:
 *   formatDelta(5,  25, "DAYS") -> "+5 DAYS"
 *   formatDelta(-0.6, 0, "KG") -> "−0.3 KG"
 *   formatDelta(90, 0, "MIN")  -> "+1h 30m"
 *   formatDelta(0,  25, "DAYS") -> "+0 DAYS"   (display 0, not empty)
 *   formatDelta(0,  0,  "DAYS") -> "—"
 */
export function formatDelta(newer: number, older: number, unit: string): string {
  const raw = newer - older;
  if (raw === 0) return "—";
  const sign = raw > 0 ? "+" : "\u2212"; // U+2212 MINUS SIGN
  const value = formatValueForUnit(Math.abs(raw), unit);
  const u = unit.toUpperCase().trim();
  const isTime = u === "HRS" || u === "MIN" || u === "SEC";
  // Time values already include the unit ("1h 30m"). For everything
  // else, append the unit so the delta is self-describing.
  return isTime ? `${sign}${value}` : `${sign}${value} ${u}`;
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
    // -Infinity as the seed ensures any finite value replaces it on the
    // first iteration, so we never need to special-case `otherValues[0]`.
    let max = -Infinity;
    for (const v of otherValues) {
      if (v > max) max = v;
    }
    return newValue > max;
  }
  // direction === "down"
  let min = Infinity;
  for (const v of otherValues) {
    if (v < min) min = v;
  }
  return newValue < min;
}
