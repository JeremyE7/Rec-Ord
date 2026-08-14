/** Persistent, local-only recovery storage for deleted records and entries. */

import type { Entry, Record as TrackedRecord } from "./types";
import { parseLocalDate } from "./record-utils";

const TRASH_KEY = "rec-ord:trash:v1";
const TRASH_VERSION = 1;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export const TRASH_CHANGED_EVENT = "rec-ord:trash-changed";
export const DELETION_CREATED_EVENT = "rec-ord:deletion-created";
export const DELETION_FAILED_EVENT = "rec-ord:deletion-failed";
export const RESTORE_DELETED_EVENT = "rec-ord:restore-deleted";
export const RESTORE_DELETED_RESULT_EVENT = "rec-ord:restore-deleted-result";

interface DeletedBase {
  id: string;
  deletedAt: string;
  expiresAt: string;
  originalIndex: number;
}

export interface DeletedRecordItem extends DeletedBase {
  kind: "record";
  record: TrackedRecord;
}

export interface DeletedEntryItem extends DeletedBase {
  kind: "entry";
  recordId: string;
  recordName: string;
  recordUnit: string;
  entry: Entry;
}

export type DeletedItem = DeletedRecordItem | DeletedEntryItem;

export interface DeletionCreatedDetail {
  itemId: string;
  kind: DeletedItem["kind"];
  message: string;
}

export interface DeletionFailedDetail {
  message: string;
}

export interface RestoreDeletedDetail {
  itemId: string;
  source: "immediate" | "trash";
}

export interface RestoreDeletedResultDetail extends RestoreDeletedDetail {
  success: boolean;
  message: string;
}

interface TrashEnvelopeV1 {
  version: typeof TRASH_VERSION;
  items: DeletedItem[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isEntry(value: unknown): value is Entry {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.value === "number" &&
    Number.isFinite(value.value) &&
    typeof value.date === "string" &&
    !Number.isNaN(parseLocalDate(value.date).getTime()) &&
    (value.note === undefined || typeof value.note === "string")
  );
}

function isTrackedRecord(value: unknown): value is TrackedRecord {
  if (!isObject(value) || !Array.isArray(value.entries)) return false;
  const direction = value.direction;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    typeof value.unit === "string" &&
    value.unit.trim() !== "" &&
    isTimestamp(value.createdAt) &&
    value.entries.length > 0 &&
    value.entries.every(isEntry) &&
    (direction === undefined ||
      direction === null ||
      direction === "up" ||
      direction === "down")
  );
}

function isDeletedBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    isTimestamp(value.deletedAt) &&
    isTimestamp(value.expiresAt) &&
    Date.parse(value.expiresAt as string) > Date.parse(value.deletedAt as string) &&
    Number.isInteger(value.originalIndex) &&
    (value.originalIndex as number) >= 0
  );
}

function isDeletedItem(value: unknown): value is DeletedItem {
  if (!isObject(value) || !isDeletedBase(value)) return false;
  if (value.kind === "record") return isTrackedRecord(value.record);
  if (value.kind !== "entry") return false;
  return (
    typeof value.recordId === "string" &&
    value.recordId !== "" &&
    typeof value.recordName === "string" &&
    typeof value.recordUnit === "string" &&
    isEntry(value.entry)
  );
}

function cloneEntry(entry: Entry): Entry {
  return entry.note === undefined
    ? { id: entry.id, value: entry.value, date: entry.date }
    : { id: entry.id, value: entry.value, date: entry.date, note: entry.note };
}

function cloneRecord(record: TrackedRecord): TrackedRecord {
  const cloned: TrackedRecord = {
    id: record.id,
    name: record.name,
    unit: record.unit,
    entries: record.entries.map(cloneEntry),
    createdAt: record.createdAt,
  };
  if (record.direction !== undefined) cloned.direction = record.direction;
  return cloned;
}

function emitTrashChanged(): void {
  document.dispatchEvent(new CustomEvent(TRASH_CHANGED_EVENT));
}

function writeTrash(items: DeletedItem[]): boolean {
  try {
    if (items.length === 0) {
      localStorage.removeItem(TRASH_KEY);
    } else {
      const envelope: TrashEnvelopeV1 = { version: TRASH_VERSION, items };
      localStorage.setItem(TRASH_KEY, JSON.stringify(envelope));
    }
    return true;
  } catch (err) {
    console.error("[rec-ord] failed to save recently deleted items:", err);
    return false;
  }
}

export function loadTrash(now = new Date()): DeletedItem[] {
  try {
    const raw = localStorage.getItem(TRASH_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (
      !isObject(parsed) ||
      parsed.version !== TRASH_VERSION ||
      !Array.isArray(parsed.items) ||
      !parsed.items.every(isDeletedItem)
    ) {
      console.error("[rec-ord] recently deleted data failed validation; ignoring");
      return [];
    }

    const nowTime = now.getTime();
    const active = parsed.items
      .filter((item) => Date.parse(item.expiresAt) > nowTime)
      .sort((left, right) => Date.parse(right.deletedAt) - Date.parse(left.deletedAt));
    if (active.length !== parsed.items.length && writeTrash(active)) {
      emitTrashChanged();
    }
    return active;
  } catch (err) {
    console.error("[rec-ord] failed to load recently deleted items:", err);
    return [];
  }
}

function appendDeletedItem(item: DeletedItem): DeletedItem | null {
  const items = [item, ...loadTrash()];
  if (!writeTrash(items)) return null;
  emitTrashChanged();
  return item;
}

function deletionWindow(now: Date): Pick<DeletedBase, "deletedAt" | "expiresAt"> {
  return {
    deletedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
  };
}

export function archiveDeletedRecord(
  record: TrackedRecord,
  originalIndex: number,
  now = new Date(),
): DeletedRecordItem | null {
  return appendDeletedItem({
    id: crypto.randomUUID(),
    kind: "record",
    ...deletionWindow(now),
    originalIndex,
    record: cloneRecord(record),
  }) as DeletedRecordItem | null;
}

export function archiveDeletedEntry(
  record: TrackedRecord,
  entry: Entry,
  originalIndex: number,
  now = new Date(),
): DeletedEntryItem | null {
  return appendDeletedItem({
    id: crypto.randomUUID(),
    kind: "entry",
    ...deletionWindow(now),
    originalIndex,
    recordId: record.id,
    recordName: record.name,
    recordUnit: record.unit,
    entry: cloneEntry(entry),
  }) as DeletedEntryItem | null;
}

export function getDeletedItem(itemId: string): DeletedItem | null {
  return loadTrash().find((item) => item.id === itemId) ?? null;
}

export function removeDeletedItem(itemId: string): boolean {
  const items = loadTrash();
  if (!items.some((item) => item.id === itemId)) return false;
  if (!writeTrash(items.filter((item) => item.id !== itemId))) return false;
  emitTrashChanged();
  return true;
}

export function daysUntilDeletion(item: DeletedItem, now = new Date()): number {
  const remaining = Date.parse(item.expiresAt) - now.getTime();
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1_000)));
}
