/** Pure helpers for weekday routines and the transient LOG TODAY queue. */

import { normalizeTags, parseLocalDate } from "./record-utils";
import type {
  CaptureSession,
  Record as TrackedRecord,
  RoutineConfig,
  RoutineOverride,
  RoutineProfile,
  Weekday,
} from "./types";

const MAX_PROFILES = 31;
const MAX_OVERRIDES = 366;

export function emptyRoutineConfig(): RoutineConfig {
  return { profiles: [], overrides: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function normalizedWeekdays(value: unknown): Weekday[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isWeekday))].sort((a, b) => a - b);
}

function normalizedRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeProfile(value: unknown): RoutineProfile | null {
  if (!isObject(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (id === "" || name === "") return null;

  return {
    id,
    name: name.slice(0, 80),
    weekdays: normalizedWeekdays(value.weekdays),
    tags: normalizeTags(value.tags) ?? [],
    recordIds: normalizedRecordIds(value.recordIds),
  };
}

function normalizeOverride(value: unknown): RoutineOverride | null {
  if (!isObject(value)) return null;
  const date = typeof value.date === "string" ? value.date : "";
  if (Number.isNaN(parseLocalDate(date).getTime())) return null;
  if (value.routineId !== null && typeof value.routineId !== "string") return null;
  return {
    date,
    routineId: value.routineId === null ? null : value.routineId.trim(),
  };
}

/** Coerces old or malformed persisted routine data to a safe runtime shape. */
export function normalizeRoutineConfig(value: unknown): RoutineConfig {
  if (!isObject(value)) return emptyRoutineConfig();

  const profiles: RoutineProfile[] = [];
  const profileIds = new Set<string>();
  if (Array.isArray(value.profiles)) {
    for (const raw of value.profiles) {
      const profile = normalizeProfile(raw);
      if (profile === null || profileIds.has(profile.id)) continue;
      profileIds.add(profile.id);
      profiles.push(profile);
      if (profiles.length >= MAX_PROFILES) break;
    }
  }

  const overrides: RoutineOverride[] = [];
  const overrideDates = new Set<string>();
  if (Array.isArray(value.overrides)) {
    for (const raw of value.overrides) {
      const override = normalizeOverride(raw);
      if (override === null || overrideDates.has(override.date)) continue;
      overrideDates.add(override.date);
      overrides.push(override);
      if (overrides.length >= MAX_OVERRIDES) break;
    }
  }

  return { profiles, overrides };
}

export function routineForDate(
  config: RoutineConfig,
  date: string,
): RoutineProfile | null {
  const override = config.overrides.find((item) => item.date === date);
  if (override !== undefined) {
    return override.routineId === null
      ? null
      : config.profiles.find((profile) => profile.id === override.routineId) ?? null;
  }

  const parsed = parseLocalDate(date);
  if (Number.isNaN(parsed.getTime())) return null;
  const weekday = parsed.getDay() as Weekday;
  return config.profiles.find((profile) => profile.weekdays.includes(weekday)) ?? null;
}

export function routineById(
  config: RoutineConfig,
  routineId: string | null,
): RoutineProfile | null {
  if (routineId === null) return null;
  return config.profiles.find((profile) => profile.id === routineId) ?? null;
}

export function routineMatchesRecord(
  profile: RoutineProfile,
  record: TrackedRecord,
): boolean {
  const explicitMatch = profile.recordIds.includes(record.id);
  const tagMatch = profile.tags.some((tag) => (record.tags ?? []).includes(tag));
  return explicitMatch || tagMatch;
}

/** Filters records and applies explicit routine order without mutating the source list. */
export function recordsForRoutine(
  records: readonly TrackedRecord[],
  profile: RoutineProfile,
): TrackedRecord[] {
  const order = new Map(profile.recordIds.map((id, index) => [id, index]));
  return records
    .map((record, sourceIndex) => ({ record, sourceIndex }))
    .filter(({ record }) => routineMatchesRecord(profile, record))
    .sort((left, right) => {
      const leftOrder = order.get(left.record.id);
      const rightOrder = order.get(right.record.id);
      if (leftOrder === undefined && rightOrder === undefined) {
        return left.sourceIndex - right.sourceIndex;
      }
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    })
    .map(({ record }) => record);
}

export function recordLoggedOnDate(record: TrackedRecord, date: string): boolean {
  return record.entries.some((entry) => entry.date === date);
}

export function createCaptureSession(
  records: readonly TrackedRecord[],
  profile: RoutineProfile,
  date: string,
): CaptureSession {
  const pendingRecordIds = recordsForRoutine(records, profile)
    .filter((record) => !recordLoggedOnDate(record, date))
    .map((record) => record.id);

  return {
    routineId: profile.id,
    date,
    recordIds: pendingRecordIds,
    currentIndex: 0,
  };
}

export function captureSessionRecordId(session: CaptureSession | null): string | null {
  if (session === null) return null;
  return session.recordIds[session.currentIndex] ?? null;
}

export function advanceCaptureSession(
  session: CaptureSession,
): CaptureSession | null {
  const nextIndex = session.currentIndex + 1;
  if (nextIndex >= session.recordIds.length) return null;
  return { ...session, currentIndex: nextIndex };
}
