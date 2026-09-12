import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSave, loadState, normalize, saveState } from "./persistence";
import type { RoutineConfig } from "./types";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const routineConfig: RoutineConfig = {
  profiles: [
    {
      id: "pull-day",
      name: "Pull day",
      weekdays: [1],
      tags: ["BACK"],
      recordIds: [],
    },
  ],
  overrides: [],
};

describe("routine selection persistence", () => {
  beforeEach(() => {
    flushSave();
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("restores the last selected routine", () => {
    saveState([], null, routineConfig, "pull-day");
    expect(flushSave()).toBe(true);

    expect(normalize(loadState()).activeRoutineId).toBe("pull-day");
  });

  it("falls back to all records when the saved routine no longer exists", () => {
    localStorage.setItem(
      "rec-ord:state:v2",
      JSON.stringify({
        records: [],
        currentRecordId: null,
        routineConfig,
        activeRoutineId: "missing",
      }),
    );

    expect(normalize(loadState()).activeRoutineId).toBeNull();
  });
});
