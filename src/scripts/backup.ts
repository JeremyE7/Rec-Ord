/** Portable, versioned backup files for Rec-Ord's local-first data. */

import {
  normalizeQuickStep,
  normalizeTags,
  parseLocalDate,
} from "./record-utils";
import { emptyRoutineConfig, normalizeRoutineConfig } from "./routines";
import type {
  Entry,
  PersistedState,
  Record as TrackedRecord,
  RoutineConfig,
} from "./types";

const BACKUP_FORMAT = "rec-ord-backup";
const BACKUP_VERSION = 2;
const LEGACY_BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MAX_RECORDS = 1_000;
const MAX_TOTAL_ENTRIES = 100_000;
const MAX_ROUTINES = 31;
const MAX_ROUTINE_OVERRIDES = 366;

interface BackupEnvelope {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION | typeof LEGACY_BACKUP_VERSION;
  exportedAt: string;
  data: PersistedState;
}

export interface ParsedBackup {
  exportedAt: string;
  recordCount: number;
  entryCount: number;
  data: PersistedState;
}

export type BackupDelivery = "shared" | "downloaded" | "cancelled";

export class BackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") {
    throw new BackupValidationError(`${field} must be text.`);
  }
  const result = value.trim();
  if (!allowEmpty && result === "") {
    throw new BackupValidationError(`${field} cannot be empty.`);
  }
  if (result.length > maxLength) {
    throw new BackupValidationError(`${field} is too long.`);
  }
  return result;
}

function sanitizeEntry(value: unknown, recordIndex: number, entryIndex: number): Entry {
  const field = `Record ${recordIndex + 1}, entry ${entryIndex + 1}`;
  if (!isObject(value)) {
    throw new BackupValidationError(`${field} is invalid.`);
  }

  const id = readString(value.id, `${field} ID`, 128);
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throw new BackupValidationError(`${field} has an invalid value.`);
  }
  const date = readString(value.date, `${field} date`, 10);
  if (Number.isNaN(parseLocalDate(date).getTime())) {
    throw new BackupValidationError(`${field} has an invalid date.`);
  }

  const entry: Entry = { id, value: value.value, date };
  if (value.note !== undefined) {
    entry.note = readString(value.note, `${field} note`, 2_000, true);
  }
  return entry;
}

function sanitizeTags(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new BackupValidationError(`${field} tags are invalid.`);
  }
  if (value.length > 5) {
    throw new BackupValidationError(`${field} contains too many tags.`);
  }
  return normalizeTags(value);
}

function sanitizeRoutineConfig(value: unknown): RoutineConfig {
  if (value === undefined) return emptyRoutineConfig();
  if (!isObject(value) || !Array.isArray(value.profiles) || !Array.isArray(value.overrides)) {
    throw new BackupValidationError("The routine configuration is invalid.");
  }
  if (value.profiles.length > MAX_ROUTINES) {
    throw new BackupValidationError("The backup contains too many routines.");
  }
  if (value.overrides.length > MAX_ROUTINE_OVERRIDES) {
    throw new BackupValidationError("The backup contains too many routine overrides.");
  }

  const profileIds = new Set<string>();
  for (const [index, raw] of value.profiles.entries()) {
    const field = `Routine ${index + 1}`;
    if (!isObject(raw)) throw new BackupValidationError(`${field} is invalid.`);
    const id = readString(raw.id, `${field} ID`, 128);
    readString(raw.name, `${field} name`, 80);
    if (profileIds.has(id)) {
      throw new BackupValidationError("The backup contains duplicate routine IDs.");
    }
    profileIds.add(id);
    if (
      !Array.isArray(raw.weekdays) ||
      raw.weekdays.some(
        (day) =>
          typeof day !== "number" ||
          !Number.isInteger(day) ||
          day < 0 ||
          day > 6,
      )
    ) {
      throw new BackupValidationError(`${field} has invalid weekdays.`);
    }
    sanitizeTags(raw.tags, field);
    if (
      !Array.isArray(raw.recordIds) ||
      raw.recordIds.some((recordId) => typeof recordId !== "string")
    ) {
      throw new BackupValidationError(`${field} record selection is invalid.`);
    }
  }

  const overrideDates = new Set<string>();
  for (const [index, raw] of value.overrides.entries()) {
    const field = `Routine override ${index + 1}`;
    if (!isObject(raw)) throw new BackupValidationError(`${field} is invalid.`);
    const date = readString(raw.date, `${field} date`, 10);
    if (Number.isNaN(parseLocalDate(date).getTime())) {
      throw new BackupValidationError(`${field} has an invalid date.`);
    }
    if (overrideDates.has(date)) {
      throw new BackupValidationError("The backup contains duplicate routine override dates.");
    }
    overrideDates.add(date);
    if (raw.routineId !== null && typeof raw.routineId !== "string") {
      throw new BackupValidationError(`${field} routine ID is invalid.`);
    }
    if (typeof raw.routineId === "string" && !profileIds.has(raw.routineId)) {
      throw new BackupValidationError(`${field} references a missing routine.`);
    }
  }

  return normalizeRoutineConfig(value);
}

function sanitizeRecord(value: unknown, index: number): TrackedRecord {
  const field = `Record ${index + 1}`;
  if (!isObject(value)) {
    throw new BackupValidationError(`${field} is invalid.`);
  }

  const id = readString(value.id, `${field} ID`, 128);
  const name = readString(value.name, `${field} name`, 200);
  const unit = readString(value.unit, `${field} unit`, 32);
  const createdAt = readString(value.createdAt, `${field} creation date`, 64);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new BackupValidationError(`${field} has an invalid creation date.`);
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new BackupValidationError(`${field} must contain at least one entry.`);
  }

  const entryIds = new Set<string>();
  const entries = value.entries.map((entry, entryIndex) => {
    const sanitized = sanitizeEntry(entry, index, entryIndex);
    if (entryIds.has(sanitized.id)) {
      throw new BackupValidationError(`${field} contains duplicate entry IDs.`);
    }
    entryIds.add(sanitized.id);
    return sanitized;
  });

  const direction = value.direction;
  if (
    direction !== undefined &&
    direction !== null &&
    direction !== "up" &&
    direction !== "down"
  ) {
    throw new BackupValidationError(`${field} has an invalid direction.`);
  }

  const record: TrackedRecord = { id, name, unit, entries, createdAt };
  if (direction === "up" || direction === "down" || direction === null) {
    record.direction = direction;
  }
  const tags = sanitizeTags(value.tags, field);
  if (tags !== undefined) record.tags = tags;
  if (value.quickStep !== undefined) {
    const quickStep = normalizeQuickStep(value.quickStep);
    if (quickStep === undefined) {
      throw new BackupValidationError(`${field} has an invalid quick step.`);
    }
    record.quickStep = quickStep;
  }
  return record;
}

function sanitizePersistedState(value: unknown): PersistedState {
  if (!isObject(value) || !Array.isArray(value.records)) {
    throw new BackupValidationError("The backup data is invalid.");
  }
  if (value.records.length > MAX_RECORDS) {
    throw new BackupValidationError("The backup contains too many records.");
  }

  const recordIds = new Set<string>();
  let entryCount = 0;
  const records = value.records.map((record, index) => {
    const sanitized = sanitizeRecord(record, index);
    if (recordIds.has(sanitized.id)) {
      throw new BackupValidationError("The backup contains duplicate record IDs.");
    }
    recordIds.add(sanitized.id);
    entryCount += sanitized.entries.length;
    return sanitized;
  });
  if (entryCount > MAX_TOTAL_ENTRIES) {
    throw new BackupValidationError("The backup contains too many entries.");
  }

  const currentRecordId = value.currentRecordId;
  if (currentRecordId !== null && typeof currentRecordId !== "string") {
    throw new BackupValidationError("The focused record ID is invalid.");
  }
  if (records.length === 0 && currentRecordId !== null) {
    throw new BackupValidationError("An empty backup cannot have a focused record.");
  }
  if (currentRecordId !== null && !recordIds.has(currentRecordId)) {
    throw new BackupValidationError("The focused record does not exist in the backup.");
  }

  const routineConfig = sanitizeRoutineConfig(value.routineConfig);
  const activeRoutineId = value.activeRoutineId ?? null;
  if (activeRoutineId !== null && typeof activeRoutineId !== "string") {
    throw new BackupValidationError("The active routine ID is invalid.");
  }
  if (
    typeof activeRoutineId === "string" &&
    !routineConfig.profiles.some((profile) => profile.id === activeRoutineId)
  ) {
    throw new BackupValidationError("The active routine does not exist in the backup.");
  }

  return {
    records,
    currentRecordId,
    routineConfig,
    activeRoutineId,
  };
}

function parseEnvelope(value: unknown): BackupEnvelope {
  if (!isObject(value)) {
    throw new BackupValidationError("This is not a Rec-Ord backup.");
  }
  if (value.format !== BACKUP_FORMAT) {
    throw new BackupValidationError("This is not a Rec-Ord backup.");
  }
  if (value.version !== BACKUP_VERSION && value.version !== LEGACY_BACKUP_VERSION) {
    throw new BackupValidationError("This backup version is not supported.");
  }
  const exportedAt = readString(value.exportedAt, "Export date", 64);
  if (!Number.isFinite(Date.parse(exportedAt))) {
    throw new BackupValidationError("The backup has an invalid export date.");
  }

  return {
    format: BACKUP_FORMAT,
    version: value.version,
    exportedAt,
    data: sanitizePersistedState(value.data),
  };
}

export function createBackupFile(
  state: PersistedState,
  exportedAt = new Date(),
): File {
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    data: sanitizePersistedState(state),
  };
  const contents = JSON.stringify(envelope, null, 2);
  const date = envelope.exportedAt.slice(0, 10);
  return new File([contents], `rec-ord-backup-${date}.json`, {
    type: "application/json",
  });
}

export async function parseBackupFile(file: File): Promise<ParsedBackup> {
  if (file.size > MAX_BACKUP_BYTES) {
    throw new BackupValidationError("The selected backup is larger than 5 MB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new BackupValidationError("The selected file is not valid JSON.");
  }

  const envelope = parseEnvelope(parsed);
  return {
    exportedAt: envelope.exportedAt,
    recordCount: envelope.data.records.length,
    entryCount: envelope.data.records.reduce(
      (count, record) => count + record.entries.length,
      0,
    ),
    data: envelope.data,
  };
}

function downloadBackup(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function canShareBackup(file: File): boolean {
  if (
    typeof navigator.share !== "function" ||
    typeof navigator.canShare !== "function"
  ) {
    return false;
  }
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export async function deliverBackup(file: File): Promise<BackupDelivery> {
  const shareData: ShareData = {
    files: [file],
    title: "REC—ORD backup",
    text: "A portable copy of your Rec-Ord data.",
  };

  if (canShareBackup(file)) {
    try {
      await navigator.share(shareData);
      return "shared";
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return "cancelled";
      }
      console.warn("[rec-ord] native backup sharing failed; downloading instead", err);
    }
  }

  downloadBackup(file);
  return "downloaded";
}
