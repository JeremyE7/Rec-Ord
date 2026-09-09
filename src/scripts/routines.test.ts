import { describe, expect, it } from "vitest";
import {
  advanceCaptureSession,
  captureSessionRecordId,
  createCaptureSession,
  normalizeRoutineConfig,
  recordLoggedOnDate,
  recordsForRoutine,
  routineForDate,
} from "./routines";
import type { Record as TrackedRecord, RoutineProfile } from "./types";

const TEST_DATE = "2026-09-09";

function record(
  id: string,
  tags: string[] = [],
  entries = [{ id: `${id}-entry`, value: 1, date: "2026-09-01" }],
): TrackedRecord {
  return {
    id,
    name: id.toUpperCase(),
    unit: "REPS",
    entries,
    createdAt: "2026-09-01T00:00:00.000Z",
    tags,
  };
}

function routine(overrides: Partial<RoutineProfile> = {}): RoutineProfile {
  return {
    id: "pull-day",
    name: "Pull day",
    weekdays: [3],
    tags: ["BACK", "BICEPS"],
    recordIds: [],
    ...overrides,
  };
}

describe("routine configuration", () => {
  it("normalizes profiles, weekdays, tags, ids, and duplicate dates", () => {
    const normalized = normalizeRoutineConfig({
      profiles: [
        {
          id: " pull-day ",
          name: " Pull day ",
          weekdays: [3, 3, 9, "2"],
          tags: ["back", " BACK ", "biceps", "legs", "push", "extra"],
          recordIds: ["r2", " r2 ", "r1", 4],
        },
        { id: "pull-day", name: "Duplicate", weekdays: [], tags: [], recordIds: [] },
        { id: "", name: "Invalid", weekdays: [], tags: [], recordIds: [] },
      ],
      overrides: [
        { date: TEST_DATE, routineId: "pull-day" },
        { date: TEST_DATE, routineId: null },
        { date: "not-a-date", routineId: null },
      ],
    });

    expect(normalized).toEqual({
      profiles: [
        {
          id: "pull-day",
          name: "Pull day",
          weekdays: [3],
          tags: ["BACK", "BICEPS", "LEGS", "PUSH", "EXTRA"],
          recordIds: ["r2", "r1"],
        },
      ],
      overrides: [{ date: TEST_DATE, routineId: "pull-day" }],
    });
  });

  it("selects the first matching weekly routine and honors date overrides", () => {
    const push = routine({ id: "push-day", name: "Push day", tags: ["CHEST"] });
    const pull = routine();
    const config = { profiles: [push, pull], overrides: [] };

    expect(routineForDate(config, TEST_DATE)?.id).toBe("push-day");
    expect(
      routineForDate(
        { ...config, overrides: [{ date: TEST_DATE, routineId: "pull-day" }] },
        TEST_DATE,
      )?.id,
    ).toBe("pull-day");
    expect(
      routineForDate(
        { ...config, overrides: [{ date: TEST_DATE, routineId: null }] },
        TEST_DATE,
      ),
    ).toBeNull();
  });
});

describe("routine capture", () => {
  it("matches any configured tag, keeps explicit records, and applies explicit order", () => {
    const records = [record("r1", ["BACK"]), record("r2", ["CHEST"]), record("r3")];
    const profile = routine({ recordIds: ["r3", "missing"] });

    expect(recordsForRoutine(records, profile).map((item) => item.id)).toEqual(["r3", "r1"]);
    expect(records.map((item) => item.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("creates a pending queue, skips logged records, and advances to completion", () => {
    const records = [
      record("r1", ["BACK"], [{ id: "r1-today", value: 2, date: TEST_DATE }]),
      record("r2", ["BICEPS"]),
      record("r3", ["LEGS"]),
    ];
    const profile = routine({ recordIds: ["r2"] });

    const loggedRecord = records[0];
    expect(loggedRecord).toBeDefined();
    if (loggedRecord === undefined) return;
    expect(recordLoggedOnDate(loggedRecord, TEST_DATE)).toBe(true);
    const session = createCaptureSession(records, profile, TEST_DATE);
    expect(session.recordIds).toEqual(["r2"]);
    expect(captureSessionRecordId(session)).toBe("r2");
    expect(advanceCaptureSession(session)).toBeNull();
  });
});
