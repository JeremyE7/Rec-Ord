/**
 * rec-ord — Tiny reactive store
 *
 * Module-level state + a list of subscribers. setState shallow-merges the
 * patch into the current state and notifies all subscribers. ~30 LOC, no
 * Proxy magic, no library.
 *
 * Why not Proxy / signals? The state mutations are explicit and small,
 * and we want zero-deps. Subscribers re-render the whole #app — for an
 * app this size the work is negligible.
 */

import type { AppState } from "./types";

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

let state: AppState = {
  records: [],
  currentRecordId: null,
  view: "focus",
  expanded: false,
  addingEntry: false,
};

export function getState(): AppState {
  return state;
}

/**
 * Replace the whole state. Use this on boot to inject loaded records.
 * Notifies subscribers once.
 */
export function initState(next: AppState): void {
  state = next;
  notify();
}

/**
 * Shallow-merge a patch into the current state and notify subscribers.
 * Pass a function to derive a patch from the current state.
 */
export function setState(patch: Partial<AppState> | ((prev: AppState) => Partial<AppState>)): void {
  const resolved = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...resolved };
  notify();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error("[rec-ord] subscriber threw:", err);
    }
  }
}
