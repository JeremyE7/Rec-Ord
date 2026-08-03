/**
 * Record-domain helpers.
 *
 * This module intentionally contains no rendering or animation code. It is
 * the single source of truth for record creation, sorting, and display
 * formatting.
 */

import type { Entry, Record } from "./types";

const TIME_UNITS = new Set(["HRS", "MIN", "SEC"]);

export function formatValueForUnit(value: number, unit: string): string {
  if (!Number.isFinite(value)) return String(value);

  switch (unit.trim().toUpperCase()) {
    case "HRS":
      return formatDuration(Math.round(value * 3_600));
    case "MIN":
      return formatDuration(Math.round(value * 60));
    case "SEC":
      return formatDuration(Math.round(value));
    default:
      return String(Math.round(value));
  }
}

function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "−" : "";
  const absoluteSeconds = Math.abs(totalSeconds);
  const hours = Math.floor(absoluteSeconds / 3_600);
  const minutes = Math.floor((absoluteSeconds % 3_600) / 60);
  const seconds = absoluteSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return `${sign}${parts.join(" ")}`;
}

export function formatDelta(newer: number, older: number, unit: string): string {
  const delta = newer - older;
  const formatted = formatValueForUnit(Math.abs(delta), unit);
  const normalizedUnit = unit.trim().toUpperCase();
  if (delta === 0 || formatted === "0" || formatted === "0s") return "—";

  const sign = delta > 0 ? "+" : "−";

  return TIME_UNITS.has(normalizedUnit)
    ? `${sign}${formatted}`
    : `${sign}${formatted} ${normalizedUnit}`;
}

export function parseLocalDate(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) return new Date(Number.NaN);

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return new Date(Number.NaN);
  }

  return parsed;
}

export function todayISO(): string {
  return isoDate(new Date());
}

export function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function calendarDayNumber(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function formatRelativeDate(iso: string, now: Date = new Date()): string {
  const date = parseLocalDate(iso);
  if (Number.isNaN(date.getTime())) return iso.toUpperCase();

  const days = Math.round(calendarDayNumber(now) - calendarDayNumber(date));
  if (days === 0) return "TODAY";
  if (days === 1) return "YESTERDAY";
  if (days >= 2 && days <= 6) return `${days}D AGO`;
  if (days >= 7 && days <= 13) return "1W AGO";

  const month = new Intl.DateTimeFormat("en-US", { month: "short" })
    .format(date)
    .toUpperCase();
  return `${month} ${date.getDate()}`;
}

export function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
}

export function latestEntry(record: Record): Entry | null {
  return record.entries[0] ?? null;
}

export function previousEntry(record: Record): Entry | null {
  return record.entries[1] ?? null;
}

export function makeEntry(value: number, date: string, id?: string): Entry {
  return { id: id ?? crypto.randomUUID(), value, date };
}

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

  if (direction === "up" || direction === "down") {
    record.direction = direction;
  }

  return record;
}

export function isNewBest(
  record: Record,
  entryId: string,
  value: number,
): boolean {
  if (record.direction !== "up" && record.direction !== "down") return false;

  const otherValues = record.entries
    .filter((entry) => entry.id !== entryId)
    .map((entry) => entry.value);
  if (otherValues.length === 0) return false;

  return record.direction === "up"
    ? value > Math.max(...otherValues)
    : value < Math.min(...otherValues);
}
