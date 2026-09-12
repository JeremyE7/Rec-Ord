import { describe, expect, it } from "vitest";
import { createBackupFile, parseBackupFile } from "./backup";
import type { PersistedState } from "./types";

const state: PersistedState = {
  records: [
    {
      id: "record-1",
      name: "Bench press",
      unit: "REPS",
      entries: [{ id: "entry-1", value: 10, date: "2026-09-09" }],
      createdAt: "2026-09-09T08:00:00.000Z",
      tags: ["CHEST", "PUSH"],
      quickStep: 2,
    },
  ],
  currentRecordId: "record-1",
  routineConfig: {
    profiles: [
      {
        id: "push-day",
        name: "Push day",
        weekdays: [1, 3, 5],
        tags: ["CHEST", "PUSH"],
        recordIds: ["record-1"],
      },
    ],
    overrides: [{ date: "2026-09-10", routineId: null }],
  },
  activeRoutineId: "push-day",
};

function backupFile(value: unknown): File {
  return new File([JSON.stringify(value)], "backup.json", { type: "application/json" });
}

describe("backup format", () => {
  it("round-trips tags, quick values, and routines in version 2", async () => {
    const file = createBackupFile(state, new Date("2026-09-09T12:00:00.000Z"));
    const parsed = await parseBackupFile(file);

    expect(JSON.parse(await file.text()).version).toBe(2);
    expect(parsed.recordCount).toBe(1);
    expect(parsed.entryCount).toBe(1);
    expect(parsed.data).toEqual(state);
  });

  it("accepts a legacy version 1 backup and upgrades missing routines", async () => {
    const parsed = await parseBackupFile(
      backupFile({
        format: "rec-ord-backup",
        version: 1,
        exportedAt: "2026-09-09T12:00:00.000Z",
        data: {
          records: state.records,
          currentRecordId: state.currentRecordId,
        },
      }),
    );

    expect(parsed.data.records[0]?.tags).toEqual(["CHEST", "PUSH"]);
    expect(parsed.data.routineConfig).toEqual({ profiles: [], overrides: [] });
    expect(parsed.data.activeRoutineId).toBeNull();
  });

  it("rejects an active routine that references a missing profile", async () => {
    await expect(
      parseBackupFile(
        backupFile({
          format: "rec-ord-backup",
          version: 2,
          exportedAt: "2026-09-09T12:00:00.000Z",
          data: { ...state, activeRoutineId: "missing" },
        }),
      ),
    ).rejects.toThrow("active routine does not exist");
  });

  it("rejects routine overrides that reference a missing profile", async () => {
    await expect(
      parseBackupFile(
        backupFile({
          format: "rec-ord-backup",
          version: 2,
          exportedAt: "2026-09-09T12:00:00.000Z",
          data: {
            ...state,
            routineConfig: {
              profiles: state.routineConfig.profiles,
              overrides: [{ date: "2026-09-10", routineId: "missing" }],
            },
          },
        }),
      ),
    ).rejects.toThrow("missing routine");
  });
});
