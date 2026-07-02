/**
 * rec-ord — Pointer gesture system
 *
 * Single source of truth for all gestural input. Wires Pointer Events
 * (single-finger swipes + multi-pointer pinch + long-press timer) to a
 * set of named handlers. Designed to be attached to a single root
 * element (the `<body>`) and route by the current view.
 *
 * Threshold constants:
 *   - axis lock:         12px (was 8px) — more stable, no premature lock
 *   - swipe commit:      |delta| > 60px  OR  |delta|/dt > 0.4 px/ms
 *   - long press:        500ms hold, with < 14px of movement
 *   - press signal:      scale to 0.97 added at 200ms (subtle "I'm registering")
 *   - pinch out:         currentDist / startDist >= 1.25
 *   - pinch in:          currentDist / startDist <= 0.75
 *
 * Live drag: while a vertical swipe is in progress, the focus card is
 * translated by `translateY(dy)` and its opacity is reduced. Updates are
 * coalesced through `requestAnimationFrame` so rapid `pointermove`
 * events (60+ Hz on some mobile devices) don't cause layout thrashing.
 * On commit, the transform is left in place so the browser captures the
 * dragged rect as the "old" snapshot — this is what makes the release
 * feel continuous. On cancel, a spring-physics `requestAnimationFrame`
 * loop lerps the card and hints back to translateY(0) (replaces the
 * previous `WAAPI` `card.animate(...)` for a smoother feel).
 *
 * Pinch: on the SECOND pointerdown, any in-progress single-pointer drag
 * is cancelled and pinch tracking takes over. A single flag prevents
 * the same pinch from triggering twice.
 *
 * Haptic: a short vibration fires on successful commit (swipe, long-
 * press). Uses `navigator.vibrate?.()` so iOS Safari (no-op) is safe.
 *
 * Cleanup: all listeners are attached to a single `AbortController`,
 * whose `abort()` is the cleanup function. This eliminates the manual
 * removeEventListener chain (and the class of bugs where a listener is
 * forgotten on teardown).
 *
 * Bug fix: gesture state (`dragLocked`, `dragging`, `pinchStartDist`,
 * `pinchFired`) is now reset UNCONDITIONALLY on every first-pointerdown,
 * not just when the previous gesture ended cleanly. This fixes the
 * "gestures stop working after closing the grid view" bug — stale
 * state from a previous (incomplete) gesture would leak into the next.
 */

import { prefersReducedMotion } from "./motion";

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

const SWIPE_DISTANCE = 60; // px
const SWIPE_VELOCITY = 0.4; // px/ms
const LONG_PRESS_MS = 500;
const PRESS_SIGNAL_MS = 200;
const LONG_PRESS_MOVE = 14; // px of movement allowed before long-press cancels
const PINCH_OUT = 1.25;
const PINCH_IN = 0.75;
const AXIS_LOCK_THRESHOLD = 12; // px
const DRAG_OPACITY_DIVISOR = 400; // |dy|/400, capped at 0.4
const DRAG_OPACITY_MAX = 0.4;
const HINT_FADE_START = 0.3; // fraction of threshold where hint starts fading in
const HINT_MAX_OPACITY = 0.55;
const SPRING_LERP = 0.18; // spring stiffness
const SPRING_VELOCITY_DECAY = 0.85;
const SPRING_SETTLE_THRESHOLD = 0.1; // px / (px/frame)
const HAPTIC_MS = 12;

/* ---------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */

export interface GestureHandlers {
  /** Vertical swipe upward on the focus card — go to next (older) record. */
  onSwipeUp?: () => boolean | void;
  /** Vertical swipe downward — go to previous (newer) record, or collapse. */
  onSwipeDown?: () => boolean | void;
  /** Horizontal swipe right on focus — open the new-record form. */
  onSwipeRight?: () => boolean | void;
  /** Horizontal swipe left inside the new-record form — go back to focus. */
  onSwipeLeft?: () => boolean | void;
  /** Long press on focus — expand to edit mode. */
  onLongPress?: () => boolean | void;
  /** Two-finger spread — open grid view. */
  onPinchOut?: (centroid: { x: number; y: number }) => boolean | void;
  /** Two-finger pinch — close grid view. */
  onPinchIn?: (centroid: { x: number; y: number }) => boolean | void;
}

/* ---------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------- */

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  /** Time the pointer went down, in ms (used for swipe velocity). */
  downTime: number;
}

interface GestureState {
  pointers: Map<number, ActivePointer>;
  captured: HTMLElement | null;
  capturedPointerId: number | null;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  pressSignalTimer: ReturnType<typeof setTimeout> | null;
  pinchStartDist: number | null;
  pinchFired: boolean;
  dragLocked: "h" | "v" | null;
  dragging: boolean;
  pressingElement: HTMLElement | null;
  /** The element the swipe-progress bar was last applied to. Cached so
   *  the move handler can update it without re-querying the DOM. */
  swipeProgressEl: HTMLElement | null;
}

function newState(): GestureState {
  return {
    pointers: new Map(),
    captured: null,
    capturedPointerId: null,
    longPressTimer: null,
    pressSignalTimer: null,
    pinchStartDist: null,
    pinchFired: false,
    dragLocked: null,
    dragging: false,
    pressingElement: null,
    swipeProgressEl: null,
  };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function distance(a: ActivePointer, b: ActivePointer): number {
  const dx = a.currentX - b.currentX;
  const dy = a.currentY - b.currentY;
  return Math.sqrt(dx * dx + dy * dy);
}

function centroid(points: ActivePointer[]): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.currentX;
    y += p.currentY;
  }
  return { x: x / points.length, y: y / points.length };
}

/** Returns the element that should be the focus card for live drag. */
function findFocusCard(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-focus-card]");
}

/** Returns the swipe-progress indicator inside the current focus card, or null. */
function findSwipeProgress(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-swipe-progress]");
}

function findFocusHint(
  root: HTMLElement,
  position: "prev" | "next",
): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-focus-hint="${position}"]`);
}

/** True if the event originated inside an interactive form element. */
function isFormElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** True if the target is a real button. */
function isButton(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === "BUTTON";
}

/** Short haptic pulse on commit. Safe on iOS (no-op). */
function haptic(): void {
  try {
    navigator.vibrate?.(HAPTIC_MS);
  } catch {
    // Some browsers throw if called in certain contexts; safe to ignore.
  }
}

/* ---------------------------------------------------------------------------
 * Spring-physics snap-back
 *
 * Replaces the previous WAAPI `card.animate(...)` with a manual
 * `requestAnimationFrame` loop that lerps the inline transform/opacity
 * back to 0 with a damped spring. Feels smoother and integrates with
 * the live-drag transform updates (no animation event racing).
 * ------------------------------------------------------------------------- */

function springBackElement(card: HTMLElement, axis: "x" | "y"): void {
  if (prefersReducedMotion()) {
    card.style.transform = "";
    card.style.opacity = "";
    return;
  }
  const axisProp = axis === "x" ? "translateX" : "translateY";
  // Read the current inline transform value. If no transform, current = 0.
  const m = card.style.transform.match(/-?\d+(\.\d+)?/);
  let current = m !== null ? parseFloat(m[0]) : 0;
  if (!Number.isFinite(current)) current = 0;
  let velocity = 0;

  function tick(): void {
    const force = (0 - current) * SPRING_LERP;
    velocity = (velocity + force) * SPRING_VELOCITY_DECAY;
    current += velocity;
    card.style.transform = `${axisProp}(${current}px)`;
    // Opacity mirrors the live-drag formula: 1 - min(|dy|/400, 0.4).
    const opacity = 1 - Math.min(Math.abs(current) / DRAG_OPACITY_DIVISOR, DRAG_OPACITY_MAX);
    card.style.opacity = String(opacity);
    if (Math.abs(current) > SPRING_SETTLE_THRESHOLD || Math.abs(velocity) > SPRING_SETTLE_THRESHOLD) {
      requestAnimationFrame(tick);
    } else {
      card.style.transform = "";
      card.style.opacity = "";
    }
  }
  requestAnimationFrame(tick);
}

function springBack(card: HTMLElement): void {
  springBackElement(card, "y");
}

function springBackHint(
  root: HTMLElement,
  position: "prev" | "next",
): void {
  const hint = findFocusHint(root, position);
  if (hint === null) return;
  if (prefersReducedMotion()) {
    hint.style.transform = "";
    hint.style.opacity = "";
    return;
  }
  const hintEl = hint; // alias for closure (TS narrowing)
  let current = parseFloat((hintEl.style.transform.match(/-?\d+(\.\d+)?/)?.[0]) ?? "0");
  if (!Number.isFinite(current)) current = 0;
  let velocity = 0;
  const startOpacity = Number.parseFloat(hintEl.style.opacity) || 0;

  function tick(): void {
    const force = (0 - current) * SPRING_LERP;
    velocity = (velocity + force) * SPRING_VELOCITY_DECAY;
    current += velocity;
    hintEl.style.transform = `translateY(${current}px)`;
    const progress = Math.min(Math.abs(current) / SWIPE_DISTANCE, 1);
    const hintOpacity = (Math.max(0, (progress - HINT_FADE_START) / (1 - HINT_FADE_START)) * HINT_MAX_OPACITY) * (startOpacity / HINT_MAX_OPACITY || 0);
    hintEl.style.opacity = String(hintOpacity);
    if (Math.abs(current) > SPRING_SETTLE_THRESHOLD || Math.abs(velocity) > SPRING_SETTLE_THRESHOLD) {
      requestAnimationFrame(tick);
    } else {
      hintEl.style.transform = "";
      hintEl.style.opacity = "";
    }
  }
  requestAnimationFrame(tick);
}

function springBackDrag(root: HTMLElement): void {
  const card = findFocusCard(root);
  if (card !== null) springBack(card);
  springBackHint(root, "next");
  springBackHint(root, "prev");
  // Also reset the swipe-progress bar to scaleX(0).
  const progress = findSwipeProgress(root);
  if (progress !== null) {
    const progressEl = progress; // alias for closure
    if (prefersReducedMotion()) {
      progressEl.style.transform = "";
      progressEl.style.opacity = "";
    } else {
      let current = parseFloat((progressEl.style.transform.match(/-?\d+(\.\d+)?/)?.[0]) ?? "0");
      if (!Number.isFinite(current)) current = 0;
      let velocity = 0;
      function tick(): void {
        const force = (0 - current) * SPRING_LERP;
        velocity = (velocity + force) * SPRING_VELOCITY_DECAY;
        current += velocity;
        progressEl.style.transform = `scaleX(${current})`;
        if (Math.abs(current) > 0.01 || Math.abs(velocity) > 0.01) {
          requestAnimationFrame(tick);
        } else {
          progressEl.style.transform = "scaleX(0)";
        }
      }
      requestAnimationFrame(tick);
    }
  }
}

/* ---------------------------------------------------------------------------
 * attachGestures
 * ------------------------------------------------------------------------- */

export interface AttachOptions {
  getView: () => "focus" | "new" | "grid";
  getExpanded: () => boolean;
  getHasRecords: () => boolean;
  root: HTMLElement;
  handlers: GestureHandlers;
}

/**
 * Attaches pointer-event listeners to the root element. Returns a cleanup
 * function that aborts every listener via a single AbortController — call
 * it before re-attaching after a re-render or page-load.
 */
export function attachGestures(opts: AttachOptions): () => void {
  const { root, getView, getExpanded, getHasRecords, handlers } = opts;
  const state = newState();
  const ac = new AbortController();
  const opts2 = { signal: ac.signal };

  // rAF coalescing for the live drag — apply the visual transform on the
  // next animation frame, not on every pointermove event.
  let dragFrame: number | null = null;
  let lastDy = 0;

  const clearTimers = (): void => {
    if (state.longPressTimer !== null) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
    if (state.pressSignalTimer !== null) {
      clearTimeout(state.pressSignalTimer);
      state.pressSignalTimer = null;
    }
  };

  const removePressingClass = (): void => {
    if (state.pressingElement !== null) {
      state.pressingElement.classList.remove("is-pressing");
      state.pressingElement = null;
    }
  };

  const releaseCapture = (): void => {
    if (state.captured !== null && state.capturedPointerId !== null) {
      try {
        state.captured.releasePointerCapture(state.capturedPointerId);
      } catch {
        // Some browsers throw if capture is already released; safe to ignore.
      }
      state.captured = null;
      state.capturedPointerId = null;
    }
  };

  const cancelDrag = (): void => {
    if (state.dragging) {
      springBackDrag(root);
      state.dragging = false;
    }
  };

  const applyDragFrame = (): void => {
    dragFrame = null;
    if (state.dragLocked !== "v") return;
    const card = findFocusCard(root);
    if (card === null) return;
    state.dragging = true;
    const absDy = Math.abs(lastDy);
    const opacity = 1 - Math.min(absDy / DRAG_OPACITY_DIVISOR, DRAG_OPACITY_MAX);
    card.style.transform = `translateY(${lastDy}px)`;
    card.style.opacity = String(opacity);
    // Hint opacity: ramps in starting at HINT_FADE_START (0.3) of the threshold.
    const hintProgress = Math.max(
      0,
      (Math.min(absDy / SWIPE_DISTANCE, 1) - HINT_FADE_START) / (1 - HINT_FADE_START),
    );
    const hintOpacity = hintProgress * HINT_MAX_OPACITY;
    const nextHint = findFocusHint(root, "next");
    if (nextHint !== null) {
      nextHint.style.transform = `translateY(${lastDy}px)`;
      nextHint.style.opacity = String(hintOpacity);
    }
    const prevHint = findFocusHint(root, "prev");
    if (prevHint !== null) {
      prevHint.style.transform = `translateY(${lastDy}px)`;
      prevHint.style.opacity = String(hintOpacity);
    }
    // Swipe progress bar: scaleX from 0 to 1 as the user crosses the threshold.
    if (state.swipeProgressEl === null) {
      state.swipeProgressEl = findSwipeProgress(root);
    }
    if (state.swipeProgressEl !== null) {
      const progress = Math.min(absDy / SWIPE_DISTANCE, 1);
      state.swipeProgressEl.style.transform = `scaleX(${progress})`;
      state.swipeProgressEl.style.opacity = String(0.6 + 0.4 * progress);
    }
  };

  const scheduleDragFrame = (): void => {
    if (dragFrame !== null) return;
    dragFrame = requestAnimationFrame(applyDragFrame);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // Reset state UNCONDITIONALLY on every first-pointerdown. This is the
    // fix for the "gestures stop working after closing the grid" bug —
    // stale state from a previous incomplete gesture would otherwise leak
    // into the next one and bail the handlers out early.
    if (state.pointers.size === 0) {
      state.dragLocked = null;
      state.dragging = false;
      state.pinchStartDist = null;
      state.pinchFired = false;
      state.swipeProgressEl = null;
    }

    // Second pointer down: cancel any single-pointer drag and start pinch.
    if (state.pointers.size >= 1) {
      cancelDrag();
      removePressingClass();
      clearTimers();
      const p: ActivePointer = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        downTime: e.timeStamp,
      };
      state.pointers.set(e.pointerId, p);
      const points = Array.from(state.pointers.values());
      if (points.length === 2) {
        state.pinchStartDist = distance(points[0]!, points[1]!);
        state.pinchFired = false;
      }
      return;
    }

    // First pointer down.
    const p: ActivePointer = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      downTime: e.timeStamp,
    };
    state.pointers.set(e.pointerId, p);

    if (isFormElement(e.target) || isButton(e.target)) {
      // Don't capture — let the form/button handle its own events. The
      // pointer is still recorded in `state.pointers` so a second pointer
      // arriving can start a pinch, but no capture, no long-press, no drag.
      return;
    }

    try {
      root.setPointerCapture(e.pointerId);
      state.captured = root;
      state.capturedPointerId = e.pointerId;
    } catch {
      // Some browsers may refuse capture in certain contexts.
    }

    const view = getView();
    if (view === "new" || view === "grid") {
      // New-record view: only horizontal swipe left. Grid view: pinches +
      // cell-taps only. Don't start a long-press timer.
      return;
    }

    if (view === "focus") {
      if (!getHasRecords()) return;

      if (!prefersReducedMotion()) {
        const card = findFocusCard(root);
        if (card !== null) {
          state.pressingElement = card;
          state.pressSignalTimer = setTimeout(() => {
            if (state.pressingElement !== null) {
              state.pressingElement.classList.add("is-pressing");
            }
          }, PRESS_SIGNAL_MS);
        }
      }

      state.longPressTimer = setTimeout(() => {
        state.longPressTimer = null;
        removePressingClass();
        if (getView() === "focus" && !getExpanded() && getHasRecords()) {
          const result = handlers.onLongPress?.();
          if (result === true) haptic();
        }
      }, LONG_PRESS_MS);
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const p = state.pointers.get(e.pointerId);
    if (p === undefined) return;
    p.currentX = e.clientX;
    p.currentY = e.clientY;

    // Pinch path: two pointers down, no long-press/tap competing.
    if (state.pointers.size === 2 && state.pinchStartDist !== null && !state.pinchFired) {
      const points = Array.from(state.pointers.values());
      const d = distance(points[0]!, points[1]!);
      const ratio = d / state.pinchStartDist;
      const c = centroid(points);
      if (ratio >= PINCH_OUT) {
        state.pinchFired = true;
        if (getView() === "focus" && getHasRecords()) {
          const result = handlers.onPinchOut?.(c);
          if (result === true) haptic();
        }
      } else if (ratio <= PINCH_IN) {
        state.pinchFired = true;
        if (getView() === "grid") {
          const result = handlers.onPinchIn?.(c);
          if (result === true) haptic();
        }
      }
      return;
    }

    if (state.pointers.size !== 1) return;
    if (e.pointerId !== state.capturedPointerId) return;
    if (getView() !== "focus") return;

    const dx = p.currentX - p.startX;
    const dy = p.currentY - p.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    const moved = Math.max(absDx, absDy);
    if (moved > LONG_PRESS_MOVE) {
      if (state.longPressTimer !== null) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      removePressingClass();
    }

    // Axis lock — only lock once we're past the threshold; never re-lock.
    if (state.dragLocked === null && (absDx > AXIS_LOCK_THRESHOLD || absDy > AXIS_LOCK_THRESHOLD)) {
      state.dragLocked = absDx > absDy ? "h" : "v";
    }

    if (state.dragLocked === "v") {
      lastDy = dy;
      scheduleDragFrame();
    }
    // Horizontal drag: no live visual (the push transition handles it).
  };

  const commitVertical = (dy: number, dt: number): boolean => {
    const absDy = Math.abs(dy);
    const passesDistance = absDy > SWIPE_DISTANCE;
    const passesVelocity = dt > 0 && absDy / dt > SWIPE_VELOCITY;
    if (!passesDistance && !passesVelocity) return false;
    if (dy < 0) {
      const result = handlers.onSwipeUp?.();
      if (result === true) haptic();
      return result === true;
    }
    const result = handlers.onSwipeDown?.();
    if (result === true) haptic();
    return result === true;
  };

  const commitHorizontal = (dx: number, dt: number): boolean => {
    const absDx = Math.abs(dx);
    const passesDistance = absDx > SWIPE_DISTANCE;
    const passesVelocity = dt > 0 && absDx / dt > SWIPE_VELOCITY;
    if (!passesDistance && !passesVelocity) return false;
    if (dx > 0) {
      if (getView() === "focus") {
        const result = handlers.onSwipeRight?.();
        if (result === true) haptic();
        return result === true;
      }
      return false;
    }
    if (getView() === "new") {
      const result = handlers.onSwipeLeft?.();
      if (result === true) haptic();
      return result === true;
    }
    return false;
  };

  const endPointer = (e: PointerEvent, commit: boolean): void => {
    const p = state.pointers.get(e.pointerId);
    if (p === undefined) return;
    const wasFirstPointer = state.capturedPointerId === e.pointerId;

    const startX = p.startX;
    const startY = p.startY;
    const endX = p.currentX;
    const endY = p.currentY;
    const pointerDownTime = p.downTime;

    state.pointers.delete(e.pointerId);
    clearTimers();
    removePressingClass();

    if (state.pointers.size < 2) {
      state.pinchStartDist = null;
      state.pinchFired = false;
    }

    if (!wasFirstPointer) {
      releaseCapture();
      return;
    }

    if (!commit) {
      if (state.dragging || state.dragLocked !== null) {
        springBackDrag(root);
        state.dragging = false;
      }
      releaseCapture();
      return;
    }

    if (state.pointers.size > 0) {
      releaseCapture();
      return;
    }

    const dx = endX - startX;
    const dy = endY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const dt = Math.max(1, e.timeStamp - pointerDownTime);

    let didCommit = false;
    if (state.dragLocked === "v" || (state.dragLocked === null && absDy > absDx)) {
      didCommit = commitVertical(dy, dt);
    } else if (state.dragLocked === "h" || (state.dragLocked === null && absDx > absDy)) {
      didCommit = commitHorizontal(dx, dt);
    } else {
      didCommit = commitVertical(dy, dt) || commitHorizontal(dx, dt);
    }

    if (state.dragging) {
      const card = findFocusCard(root);
      if (card !== null) {
        if (didCommit) {
          // Leave the transform in place — the view-transition snapshots
          // the dragged rect as the "old" focus card. Clear opacity so
          // the crossfade isn't dimmed.
          card.style.opacity = "";
          const nextHint = findFocusHint(root, "next");
          if (nextHint !== null) {
            nextHint.style.transform = "";
            nextHint.style.opacity = "";
          }
          const prevHint = findFocusHint(root, "prev");
          if (prevHint !== null) {
            prevHint.style.transform = "";
            prevHint.style.opacity = "";
          }
          // The swipe-progress bar: hide it on commit (the re-render
          // will create a fresh focus card with a new one).
          if (state.swipeProgressEl !== null) {
            state.swipeProgressEl.style.transform = "scaleX(0)";
            state.swipeProgressEl.style.opacity = "";
          }
        } else {
          springBackDrag(root);
        }
      }
      state.dragging = false;
    }

    releaseCapture();
  };

  const onPointerUp = (e: PointerEvent): void => endPointer(e, true);
  const onPointerCancel = (e: PointerEvent): void => endPointer(e, false);

  root.addEventListener("pointerdown", onPointerDown, opts2);
  root.addEventListener("pointermove", onPointerMove, opts2);
  root.addEventListener("pointerup", onPointerUp, opts2);
  root.addEventListener("pointercancel", onPointerCancel, opts2);
  root.addEventListener(
    "lostpointercapture",
    (e: Event) => {
      if (e instanceof PointerEvent) endPointer(e, false);
    },
    opts2,
  );

  // Capture-phase: some browsers fire scroll/pinch-zoom on the document
  // before we get the chance. This is a no-op on iOS Safari and a safety
  // net on Android.
  const onTouchMovePrevent = (e: TouchEvent): void => {
    if (state.pointers.size > 0) e.preventDefault();
  };
  root.addEventListener("touchmove", onTouchMovePrevent, { ...opts2, passive: false });

  return () => {
    if (dragFrame !== null) {
      cancelAnimationFrame(dragFrame);
      dragFrame = null;
    }
    clearTimers();
    removePressingClass();
    releaseCapture();
    ac.abort();
  };
}

/* ---------------------------------------------------------------------------
 * Per-row swipe-to-delete
 *
 * Used by entry rows inside the expanded focus. Each row gets its own
 * pointer handler. On a leftward swipe past 50px, the row is removed
 * from the record's entries via the callback.
 * ------------------------------------------------------------------------- */

export interface RowSwipeHandlers {
  /** Called when the row should be deleted. */
  onDelete: () => void;
}

export function attachRowSwipe(row: HTMLElement, handlers: RowSwipeHandlers): () => void {
  const ROW_THRESHOLD = 50;
  const ROW_OPACITY_DIVISOR = 100;
  const ac = new AbortController();
  const opts2 = { signal: ac.signal };

  let startX = 0;
  let startY = 0;
  let currentX = 0;
  let currentY = 0;
  let active = false;
  let axis: "h" | "v" | null = null;

  const onDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    startX = e.clientX;
    startY = e.clientY;
    currentX = e.clientX;
    currentY = e.clientY;
    active = true;
    axis = null;
    try {
      row.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onMove = (e: PointerEvent): void => {
    if (!active) return;
    currentX = e.clientX;
    currentY = e.clientY;
    const dx = currentX - startX;
    const dy = currentY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (axis === null && (absDx > 6 || absDy > 6)) {
      axis = absDx > absDy ? "h" : "v";
    }
    if (axis === "h") {
      const tx = Math.min(0, dx);
      row.style.transform = `translateX(${tx}px)`;
      const opacity = 1 - Math.min(absDx / ROW_OPACITY_DIVISOR, 0.6);
      row.style.opacity = String(opacity);
    }
  };

  const onUp = (e: PointerEvent): void => {
    if (!active) return;
    active = false;
    const dx = currentX - startX;
    try {
      row.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (axis === "h" && dx < -ROW_THRESHOLD) {
      row.style.transform = "";
      row.style.opacity = "";
      handlers.onDelete();
    } else {
      // Spring back via rAF.
      if (prefersReducedMotion()) {
        row.style.transform = "";
        row.style.opacity = "";
        return;
      }
      let current = parseFloat((row.style.transform.match(/-?\d+(\.\d+)?/)?.[0]) ?? "0");
      if (!Number.isFinite(current)) current = 0;
      let velocity = 0;
      function tick(): void {
        const force = (0 - current) * SPRING_LERP;
        velocity = (velocity + force) * SPRING_VELOCITY_DECAY;
        current += velocity;
        row.style.transform = `translateX(${current}px)`;
        if (Math.abs(current) > 0.1 || Math.abs(velocity) > 0.1) {
          requestAnimationFrame(tick);
        } else {
          row.style.transform = "";
          row.style.opacity = "";
        }
      }
      requestAnimationFrame(tick);
    }
  };

  row.addEventListener("pointerdown", onDown, opts2);
  row.addEventListener("pointermove", onMove, opts2);
  row.addEventListener("pointerup", onUp, opts2);
  row.addEventListener("pointercancel", onUp, opts2);

  return () => {
    ac.abort();
  };
}
