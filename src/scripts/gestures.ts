/**
 * rec-ord — Pointer gesture system
 *
 * Single source of truth for all gestural input. Wires Pointer Events
 * (single-finger swipes + multi-pointer pinch + long-press timer) to a
 * set of named handlers. Designed to be attached to a single root
 * element (`#app`) and route by the current view.
 *
 * Threshold constants (locked per spec):
 *   - swipe commit:   |delta| > 60px  OR  |delta|/dt > 0.4 px/ms
 *   - long press:     400ms hold, with < 10px of movement
 *   - press signal:   scale to 0.97 added at 250ms (subtle "I'm registering")
 *   - pinch out:      currentDist / startDist >= 1.3
 *   - pinch in:       currentDist / startDist <= 0.7
 *
 * Live drag: while a vertical swipe is in progress, the focus card is
 * translated by `translateY(dy)` and its opacity is reduced (1 - min(|dy|/400, 0.4))
 * so the user feels they're pulling the card. On commit, the transform is
 * left in place so the browser captures the dragged rect as the "old"
 * snapshot — this is what makes the release feel continuous. On cancel,
 * the card springs back to translateY(0) with the standard cubic-bezier
 * overshoot.
 *
 * Pinch: on the SECOND pointerdown, any in-progress single-pointer drag
 * is cancelled and pinch tracking takes over. A single flag prevents
 * the same pinch from triggering twice.
 */

import { prefersReducedMotion } from "./motion";

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

const SWIPE_DISTANCE = 60; // px
const SWIPE_VELOCITY = 0.4; // px/ms
const LONG_PRESS_MS = 400;
const PRESS_SIGNAL_MS = 250; // when to start showing the press is registering
const LONG_PRESS_MOVE = 10; // px of movement allowed before long-press cancels
const PINCH_OUT = 1.3;
const PINCH_IN = 0.7;
const DRAG_OPACITY_DIVISOR = 400; // |dy|/400, capped at 0.4
const DRAG_OPACITY_MAX = 0.4;
// The hint is invisible for the first half of the commit distance
// (|dy| <= 30px), then fades in linearly to max 0.55 opacity AT the
// commit threshold (|dy| = 60px). Beyond the threshold it stays at
// max — the user is about to release, and the hint should be at its
// strongest "this is what's coming" state. The divisor is
// SWIPE_DISTANCE itself so progress hits 1 exactly at the threshold.
const HINT_MAX_OPACITY = 0.55;
const SPRING_DURATION_MS = 420;
const SPRING_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/* ---------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------- */

export interface GestureHandlers {
  /**
   * Vertical swipe upward on the focus card — go to next (older) record.
   * Return `true` if a commit happened (a view transition was scheduled),
   * `false` or `undefined` otherwise (gesture should spring back).
   */
  onSwipeUp?: () => boolean | void;
  /**
   * Vertical swipe downward — go to previous (newer) record, or collapse
   * if expanded. Return `true` if a commit happened.
   */
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
  /** The element captured by setPointerCapture for the active gesture. */
  captured: HTMLElement | null;
  capturedPointerId: number | null;
  /** Long-press timer for the first pointer. */
  longPressTimer: ReturnType<typeof setTimeout> | null;
  /** Press-signal timer (250ms — adds the .is-pressing class). */
  pressSignalTimer: ReturnType<typeof setTimeout> | null;
  /** Pinch start distance (only valid while two pointers are down). */
  pinchStartDist: number | null;
  /** True once a pinch has already fired in the current gesture. */
  pinchFired: boolean;
  /** Axis the current single-pointer drag has been "locked in" to. */
  dragLocked: "h" | "v" | null;
  /** Whether the focus card currently has a live drag transform applied. */
  dragging: boolean;
  /** The element the long-press `is-pressing` class was added to. */
  pressingElement: HTMLElement | null;
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
  // The focus card is the section flagged with data-focus-card in render.ts.
  // The grid view, new-record view, and empty state also have sections but
  // with different data attributes, so this selector is unambiguous.
  return root.querySelector<HTMLElement>("[data-focus-card]");
}

/** Returns the prev or next edge hint (a small text whisper of the
 *  adjacent record's hero, positioned just above/below the focus card),
 *  or null if the hint doesn't exist (e.g. on the first/last record). */
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

/* ---------------------------------------------------------------------------
 * Spring-back animation
 * ------------------------------------------------------------------------- */

/** Springs a single element's inline `transform` back to the given target
 *  string. Reads the current computed transform so the animation starts
 *  from where the user left off. */
function springBackElement(card: HTMLElement, target: string): void {
  const reduce = prefersReducedMotion();
  const current = getComputedStyle(card).transform;
  const duration = reduce ? 10 : SPRING_DURATION_MS;
  const easing = reduce ? "linear" : SPRING_EASING;
  const anim = card.animate(
    [{ transform: current }, { transform: target }],
    { duration, easing, fill: "forwards" },
  );
  anim.onfinish = () => {
    card.style.transform = "";
  };
  anim.oncancel = () => {
    card.style.transform = "";
  };
}

/** Spring the current focus card back to `translateY(0)`. */
function springBack(card: HTMLElement): void {
  springBackElement(card, "translateY(0)");
}

/** Spring the focus card + both hint elements back to their CSS defaults.
 *  Used on cancel/spring-back of a vertical drag so the card and the
 *  hint whispers snap back to their rest position. */
function springBackDrag(root: HTMLElement): void {
  const card = findFocusCard(root);
  if (card !== null) springBack(card);
  springBackHint(root, "next");
  springBackHint(root, "prev");
}

/** Spring a single edge hint back to translateY(0) and opacity 0. The
 *  hint is invisible at rest — the swipe gesture is the only thing that
 *  makes it appear, so on cancel we animate both the transform and the
 *  opacity back to their CSS defaults. */
function springBackHint(
  root: HTMLElement,
  position: "prev" | "next",
): void {
  const hint = findFocusHint(root, position);
  if (hint === null) return;
  const reduce = prefersReducedMotion();
  const currentTransform = getComputedStyle(hint).transform;
  const currentOpacity = Number(getComputedStyle(hint).opacity) || 0;
  const duration = reduce ? 10 : SPRING_DURATION_MS;
  const easing = reduce ? "linear" : SPRING_EASING;
  const anim = hint.animate(
    [
      { transform: currentTransform, opacity: currentOpacity },
      { transform: "translateY(0)", opacity: 0 },
    ],
    { duration, easing, fill: "forwards" },
  );
  anim.onfinish = () => {
    hint.style.transform = "";
    hint.style.opacity = "";
  };
  anim.oncancel = () => {
    hint.style.transform = "";
    hint.style.opacity = "";
  };
}

/* ---------------------------------------------------------------------------
 * attachGestures
 * ------------------------------------------------------------------------- */

export interface AttachOptions {
  /** Function returning the current view, used to gate which gestures fire. */
  getView: () => "focus" | "new" | "grid";
  /** Function returning whether the current focus card is expanded (edit mode). */
  getExpanded: () => boolean;
  /** Function returning whether there is at least one record. */
  getHasRecords: () => boolean;
  /** Container the gestures are attached to (e.g. `#app`). */
  root: HTMLElement;
  /** The handlers to invoke. */
  handlers: GestureHandlers;
}

/**
 * Attaches pointer-event listeners to the root element. Returns a cleanup
 * function that removes all listeners and cancels any in-flight animations
 * — call it before re-attaching after a re-render.
 */
export function attachGestures(opts: AttachOptions): () => void {
  const { root, getView, getExpanded, getHasRecords, handlers } = opts;
  const state = newState();

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
        // Some browsers throw if the capture is already released; safe to ignore.
      }
      state.captured = null;
      state.capturedPointerId = null;
    }
  };

  /** Cancel any in-progress drag, snapping the card and hints back if needed. */
  const cancelDrag = (): void => {
    if (state.dragging) {
      springBackDrag(root);
      state.dragging = false;
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    // Ignore non-primary buttons (right-click etc.).
    if (e.button !== 0 && e.pointerType === "mouse") return;

    // If a second pointer arrives while a single-pointer drag is in
    // progress, cancel the drag and start pinch tracking.
    if (state.pointers.size >= 1) {
      cancelDrag();
      removePressingClass();
      clearTimers();
      // Add the second pointer.
      const p: ActivePointer = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        downTime: e.timeStamp,
      };
      state.pointers.set(e.pointerId, p);
      // Initialize pinch distance now that we have two pointers.
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
    state.dragLocked = null;
    state.dragging = false;

    // Don't capture the pointer when the press started on a form field
    // or a button. Those elements must receive their own pointer events
    // — capturing the pointer on the gesture root would redirect the
    // subsequent `pointerup` to the root, and the browser would never
    // synthesize a `click` on the button. We still record the pointer
    // in `state.pointers` so a subsequent second pointer can start a
    // pinch, but no capture, no long-press timer, no live drag.
    if (isFormElement(e.target) || isButton(e.target)) {
      return;
    }

    // Capture subsequent move events on the root.
    try {
      root.setPointerCapture(e.pointerId);
      state.captured = root;
      state.capturedPointerId = e.pointerId;
    } catch {
      // Some browsers may refuse capture in certain contexts; the document
      // listeners below will still receive the events.
    }

    const view = getView();
    if (view === "new" || view === "grid") {
      // New-record view: only horizontal swipe left is meaningful.
      // Grid view: pinches and cell-taps are handled separately.
      // Both: don't start a long-press timer.
      return;
    }

    if (view === "focus") {
      // Only schedule a long press if there's something to expand.
      if (!getHasRecords()) return;

      // 250ms press-signal: scale the focus card slightly to signal
      // the press is being detected. Helps the long-press feel deliberate
      // rather than ambiguous. Suppress under reduced motion.
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

      // 400ms long press → expand.
      state.longPressTimer = setTimeout(() => {
        state.longPressTimer = null;
        removePressingClass();
        // Only fire if the finger hasn't moved much and we're still on focus.
        if (getView() === "focus" && !getExpanded() && getHasRecords()) {
          handlers.onLongPress?.();
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
          handlers.onPinchOut?.(c);
        }
      } else if (ratio <= PINCH_IN) {
        state.pinchFired = true;
        if (getView() === "grid") {
          handlers.onPinchIn?.(c);
        }
      }
      // While pinching, don't process single-pointer drag logic.
      return;
    }

    // Single-pointer path: only meaningful on focus, and only for the
    // very first pointer (the one that started the gesture).
    if (state.pointers.size !== 1) return;
    if (e.pointerId !== state.capturedPointerId) return;
    if (getView() !== "focus") return;

    const dx = p.currentX - p.startX;
    const dy = p.currentY - p.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // If the user moves more than the long-press tolerance, kill the
    // long-press timer and the press-signal class. (Don't kill it for
    // tiny jitter — that would make long-press feel unstable.)
    const moved = Math.max(absDx, absDy);
    if (moved > LONG_PRESS_MOVE) {
      if (state.longPressTimer !== null) {
        clearTimeout(state.longPressTimer);
        state.longPressTimer = null;
      }
      // Once we've moved past tolerance, the press-signal class also
      // has to come off (it would otherwise stick around even when the
      // user has decided to swipe).
      removePressingClass();
    }

    // Lock to an axis as soon as the movement is unambiguous.
    if (state.dragLocked === null && (absDx > 8 || absDy > 8)) {
      state.dragLocked = absDx > absDy ? "h" : "v";
    }

    if (state.dragLocked === "v") {
      // Vertical drag — translate the current card with the finger. The
      // edge hints (next/prev) follow the card vertically and fade in
      // past 50% of the swipe commit distance so the user gets a subtle
      // preview of what's coming without an always-visible card stack.
      // The hint is invisible at rest, peaks at HINT_MAX_OPACITY when
      // |dy| reaches the commit threshold, and is `aria-hidden` +
      // `pointer-events: none` so it never affects layout or interaction.
      const card = findFocusCard(root);
      if (card === null) return;
      state.dragging = true;
      const opacity = 1 - Math.min(absDy / DRAG_OPACITY_DIVISOR, DRAG_OPACITY_MAX);
      card.style.transform = `translateY(${dy}px)`;
      card.style.opacity = String(opacity);
      // Hint opacity: 0 for |dy| <= 30px, ramps linearly from 0 to
      // HINT_MAX_OPACITY between 30px and 60px, then stays at max.
      // At |dy| = 60 (the commit threshold) the hint is at 0.55 — the
      // strongest "this is what's coming" state, just before release.
      const hintProgress = Math.max(0, (Math.min(absDy / SWIPE_DISTANCE, 1) - 0.5) * 2);
      const hintOpacity = hintProgress * HINT_MAX_OPACITY;
      // Both hints follow the current card vertically so they stay
      // visually anchored to it ("just below" / "just above"). Only the
      // one that exists (prev or next) actually has a DOM node to update.
      const nextHint = findFocusHint(root, "next");
      if (nextHint !== null) {
        nextHint.style.transform = `translateY(${dy}px)`;
        nextHint.style.opacity = String(hintOpacity);
      }
      const prevHint = findFocusHint(root, "prev");
      if (prevHint !== null) {
        prevHint.style.transform = `translateY(${dy}px)`;
        prevHint.style.opacity = String(hintOpacity);
      }
    } else if (state.dragLocked === "h") {
      // No live horizontal drag — the spec keeps the horizontal push
      // transition clean (the form slides in/out as a unit). But we
      // still want some feedback that the gesture is recognized.
      // Cheap approach: leave the card alone; on release the
      // `commit` will play the push transition.
    }
  };

  const commitVertical = (dy: number, dt: number): boolean => {
    const absDy = Math.abs(dy);
    const passesDistance = absDy > SWIPE_DISTANCE;
    const passesVelocity = dt > 0 && absDy / dt > SWIPE_VELOCITY;
    if (!passesDistance && !passesVelocity) return false;

    if (dy < 0) {
      // Swipe up — next (older) record.
      return handlers.onSwipeUp?.() === true;
    }
    // Swipe down — previous record or collapse edit.
    return handlers.onSwipeDown?.() === true;
  };

  const commitHorizontal = (dx: number, dt: number): boolean => {
    const absDx = Math.abs(dx);
    const passesDistance = absDx > SWIPE_DISTANCE;
    const passesVelocity = dt > 0 && absDx / dt > SWIPE_VELOCITY;
    if (!passesDistance && !passesVelocity) return false;
    if (dx > 0) {
      // Swipe right on focus → open new-record form.
      if (getView() === "focus") return handlers.onSwipeRight?.() === true;
      return false;
    }
    // Swipe left on new-record → go back to focus.
    if (getView() === "new") return handlers.onSwipeLeft?.() === true;
    return false;
  };

  const endPointer = (e: PointerEvent, commit: boolean): void => {
    const p = state.pointers.get(e.pointerId);
    if (p === undefined) return;
    const wasFirstPointer = state.capturedPointerId === e.pointerId;

    // Capture the values we need BEFORE we delete the pointer.
    const startX = p.startX;
    const startY = p.startY;
    const endX = p.currentX;
    const endY = p.currentY;
    const pointerDownTime = p.downTime;

    state.pointers.delete(e.pointerId);
    clearTimers();
    removePressingClass();

    // If we drop below 2 pointers, reset pinch state.
    if (state.pointers.size < 2) {
      state.pinchStartDist = null;
      state.pinchFired = false;
    }

    if (!wasFirstPointer) {
      // A non-primary pointer (the second finger) lifted. If a pinch
      // is in progress, end it; the next gesture starts fresh.
      releaseCapture();
      return;
    }

    if (!commit) {
      // pointercancel or no-commit release.
      if (state.dragging) {
        springBackDrag(root);
        state.dragging = false;
      }
      releaseCapture();
      return;
    }

    if (state.pointers.size > 0) {
      // The first pointer lifted but there's still a pointer down
      // (rare; usually the user lifted the first finger mid-pinch).
      // End the gesture cleanly.
      releaseCapture();
      return;
    }

    const dx = endX - startX;
    const dy = endY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const dt = Math.max(1, e.timeStamp - pointerDownTime);

    // Axis-decided commit: prefer vertical if we locked vertical.
    let didCommit = false;
    if (state.dragLocked === "v" || (state.dragLocked === null && absDy > absDx)) {
      didCommit = commitVertical(dy, dt);
    } else if (state.dragLocked === "h" || (state.dragLocked === null && absDx > absDy)) {
      didCommit = commitHorizontal(dx, dt);
    } else {
      // No dominant axis: try both, prefer vertical.
      didCommit = commitVertical(dy, dt) || commitHorizontal(dx, dt);
    }

    if (state.dragging) {
      const card = findFocusCard(root);
      if (card !== null) {
        if (didCommit) {
          // Leave the transform in place. The view transition snapshots
          // the dragged rect as the "old" focus card, and the new
          // focus card (no transform) is the "new" snapshot. The named
          // `record-card` group crossfades the two, producing the
          // "premium" continuous release feel: the card animates from
          // the finger's release point into the new record.
          // We DO clear the inline opacity (the new state has full
          // opacity, and leaving 0.7-ish on the pseudo-element would
          // dim the crossfade).
          card.style.opacity = "";
          // Reset the hints back to their invisible CSS defaults. The
          // new record may or may not have adjacent records; we leave
          // the re-render to set fresh hint nodes (or none at all).
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
        } else {
          // No commit — spring the card and hints back to their rest
          // position. The hints animate both transform and opacity to
          // their invisible CSS default.
          springBackDrag(root);
        }
      }
      state.dragging = false;
    }

    releaseCapture();
  };

  const onPointerUp = (e: PointerEvent): void => endPointer(e, true);
  const onPointerCancel = (e: PointerEvent): void => endPointer(e, false);

  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerCancel);
  // `lostpointercapture` fires when the browser revokes capture (e.g. on
  // contextmenu or alt-tab). Treat it as a cancel.
  root.addEventListener("lostpointercapture", (e: Event) => {
    if (e instanceof PointerEvent) endPointer(e, false);
  });

  return () => {
    clearTimers();
    removePressingClass();
    releaseCapture();
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerCancel);
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
  const ROW_THRESHOLD = 50; // px
  const ROW_OPACITY_DIVISOR = 100; // |dx|/100, capped at 0.6

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
      // Only translate on leftward swipes (negative dx).
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
      // Delete: clear inline styles and call the handler. The handler
      // will re-render, which removes the row from the DOM.
      row.style.transform = "";
      row.style.opacity = "";
      handlers.onDelete();
    } else {
      // Spring back.
      const reduce = prefersReducedMotion();
      const anim = row.animate(
        [{ transform: getComputedStyle(row).transform }, { transform: "translateX(0)" }],
        {
          duration: reduce ? 10 : 320,
          easing: reduce ? "linear" : "cubic-bezier(0.34, 1.56, 0.64, 1)",
          fill: "forwards",
        },
      );
      anim.onfinish = () => {
        row.style.transform = "";
        row.style.opacity = "";
      };
    }
  };

  row.addEventListener("pointerdown", onDown);
  row.addEventListener("pointermove", onMove);
  row.addEventListener("pointerup", onUp);
  row.addEventListener("pointercancel", onUp);

  return () => {
    row.removeEventListener("pointerdown", onDown);
    row.removeEventListener("pointermove", onMove);
    row.removeEventListener("pointerup", onUp);
    row.removeEventListener("pointercancel", onUp);
  };
}
