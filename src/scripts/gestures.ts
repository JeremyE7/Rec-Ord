/**
 * Pointer gesture recognition.
 *
 * Gesture recognition is intentionally separate from visual motion. This
 * module emits navigation intents and delegates all transforms/tweens to the
 * GSAP motion controller. Native form interaction and scrolling always win.
 */

import {
  animateRowDelete,
  beginDirectManipulation,
  beginListSwipeIndicator,
  dismissListSwipeIndicator,
  prefersReducedMotion,
  pressSignal,
  releasePress,
  rubberBand,
  springBack,
  updateDragFeedback,
  updateListSwipeIndicator,
} from "./motion";
import { gestureMotion } from "./motion-tokens";

export interface GestureHandlers {
  onSwipeUp?: (velocity?: number) => boolean | void;
  onSwipeDown?: (velocity?: number) => boolean | void;
  onSwipeRight?: (velocity?: number) => boolean | void;
  onSwipeLeft?: (velocity?: number) => boolean | void;
  onLongPress?: () => boolean | void;
}

export interface AttachOptions {
  getView: () => "focus" | "new" | "grid";
  getExpanded: () => boolean;
  getHasRecords: () => boolean;
  canSwipeVertical: (direction: "up" | "down") => boolean;
  root: HTMLElement;
  handlers: GestureHandlers;
}

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startedAt: number;
}

interface GestureState {
  pointers: Map<number, ActivePointer>;
  primaryId: number | null;
  eligible: boolean;
  axis: "h" | "v" | null;
  feedback: "surface" | "list-indicator" | null;
  dragging: boolean;
  longPressFired: boolean;
  longPressCommitted: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  pressTimer: ReturnType<typeof setTimeout> | null;
  pressingElement: HTMLElement | null;
}

function createState(): GestureState {
  return {
    pointers: new Map(),
    primaryId: null,
    eligible: false,
    axis: null,
    feedback: null,
    dragging: false,
    longPressFired: false,
    longPressCommitted: false,
    longPressTimer: null,
    pressTimer: null,
    pressingElement: null,
  };
}

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, button, a, [contenteditable='true']") !== null;
}

function activeSurface(root: HTMLElement, view: "focus" | "new" | "grid"): HTMLElement | null {
  if (view === "new") return root.querySelector<HTMLElement>("[data-new-record]");
  if (view === "focus") return root.querySelector<HTMLElement>("[data-focus-card]");
  return null;
}

function activeListIndicator(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-record-list-indicator]");
}

function haptic(): void {
  try {
    navigator.vibrate?.(12);
  } catch {
    // Vibration is optional and unsupported by iOS Safari.
  }
}

export function attachGestures(options: AttachOptions): () => void {
  const {
    root,
    getView,
    getExpanded,
    getHasRecords,
    canSwipeVertical,
    handlers,
  } = options;
  const state = createState();
  const controller = new AbortController();
  const listenerOptions = { signal: controller.signal };

  let frame: number | null = null;
  let latestX = 0;
  let latestY = 0;
  let suppressNextClick = false;
  let clickSuppressionTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (state.longPressTimer !== null) clearTimeout(state.longPressTimer);
    if (state.pressTimer !== null) clearTimeout(state.pressTimer);
    state.longPressTimer = null;
    state.pressTimer = null;
  };

  const releasePressFeedback = (): void => {
    if (state.pressingElement === null) return;
    releasePress(state.pressingElement);
    state.pressingElement = null;
  };

  const releaseCapture = (pointerId: number): void => {
    try {
      if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
    } catch {
      // The browser may already have released capture after pointercancel.
    }
  };

  const resetPrimary = (): void => {
    state.primaryId = null;
    state.eligible = false;
    state.axis = null;
    state.feedback = null;
    state.dragging = false;
    state.longPressFired = false;
    state.longPressCommitted = false;
    latestX = 0;
    latestY = 0;
  };

  const armClickSuppression = (): void => {
    suppressNextClick = true;
    if (clickSuppressionTimer !== null) clearTimeout(clickSuppressionTimer);
    clickSuppressionTimer = setTimeout(() => {
      suppressNextClick = false;
      clickSuppressionTimer = null;
    }, 500);
  };

  const applyFrame = (): void => {
    frame = null;
    if (!state.dragging || state.axis === null) return;

    if (state.axis === "h" && state.feedback === "list-indicator") {
      const indicator = activeListIndicator(root);
      if (indicator !== null) {
        updateListSwipeIndicator(
          indicator,
          Math.max(0, -latestX) / gestureMotion.swipeDistance,
        );
      }
      return;
    }

    const surface = activeSurface(root, getView());
    if (surface === null) return;

    if (state.axis === "h") {
      const x = getView() === "focus" ? Math.max(0, latestX) : latestX;
      updateDragFeedback(surface, x, 0);
      return;
    }

    const atEdge =
      (latestY < 0 && !canSwipeVertical("up")) ||
      (latestY > 0 && !canSwipeVertical("down"));
    const y = atEdge ? rubberBand(latestY) : latestY;
    updateDragFeedback(surface, 0, y);
  };

  const scheduleFrame = (): void => {
    if (frame === null) frame = requestAnimationFrame(applyFrame);
  };

  const cancelDragFeedback = (): void => {
    if (!state.dragging) return;
    if (state.feedback === "list-indicator") {
      const indicator = activeListIndicator(root);
      if (indicator !== null) dismissListSwipeIndicator(indicator);
      return;
    }

    const surface = activeSurface(root, getView());
    if (surface !== null) springBack(surface);
  };

  const startPrimary = (event: PointerEvent): void => {
    state.primaryId = event.pointerId;
    state.axis = null;
    state.dragging = false;
    state.longPressFired = false;
    state.longPressCommitted = false;

    const view = getView();
    const expanded = getExpanded();
    const scrollRegion = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>(".scroll-region")
      : null;
    const insideScroll = scrollRegion !== null;
    const canPullDown =
      view === "focus" &&
      expanded &&
      scrollRegion !== null &&
      scrollRegion.scrollTop <= 0;
    state.eligible =
      !isInteractive(event.target) &&
      view !== "grid" &&
      (!insideScroll || view === "new" || canPullDown);
    if (!state.eligible) return;

    if (!insideScroll) {
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an optimization; recognition still works without it.
      }
    }

    if (view !== "focus" || expanded || !getHasRecords()) return;

    const surface = activeSurface(root, view);
    if (surface === null) return;
    state.pressingElement = surface;

    if (!prefersReducedMotion()) {
      state.pressTimer = setTimeout(() => {
        if (state.pressingElement !== null && !state.dragging) {
          pressSignal(state.pressingElement);
        }
      }, gestureMotion.pressFeedbackDelay);
    }

    state.longPressTimer = setTimeout(() => {
      state.longPressTimer = null;
      if (state.dragging || getExpanded() || getView() !== "focus") return;
      state.longPressFired = true;
      state.pressingElement = null;
      state.longPressCommitted = handlers.onLongPress?.() === true;
      if (state.longPressCommitted) haptic();
    }, gestureMotion.longPressDelay);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const pointer: ActivePointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      startedAt: event.timeStamp,
    };
    state.pointers.set(event.pointerId, pointer);

    if (state.pointers.size === 1) {
      startPrimary(event);
      return;
    }

    clearTimers();
    releasePressFeedback();
    cancelDragFeedback();
    state.dragging = false;
    state.axis = null;
    state.feedback = null;
    state.eligible = false;
  };

  const lockAxis = (dx: number, dy: number): void => {
    if (state.axis !== null) return;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < gestureMotion.axisLockDistance) return;

    const view = getView();
    const horizontal = Math.abs(dx) > Math.abs(dy);

    if (getExpanded()) {
      if (!horizontal && dy > 0) state.axis = "v";
    } else if (view === "new") {
      if (horizontal && dx < 0) state.axis = "h";
    } else if (view === "focus") {
      if (horizontal) state.axis = "h";
      if (!horizontal) state.axis = "v";
    }

    if (state.axis === null) return;
    state.dragging = true;
    clearTimers();
    releasePressFeedback();
    if (state.primaryId !== null) {
      try {
        root.setPointerCapture(state.primaryId);
      } catch {
        // Capture is optional.
      }
    }
    const previewsList = view === "focus" && state.axis === "h" && dx < 0;
    state.feedback = previewsList ? "list-indicator" : "surface";
    if (previewsList) {
      const indicator = activeListIndicator(root);
      if (indicator !== null) beginListSwipeIndicator(indicator);
    } else {
      const surface = activeSurface(root, view);
      if (surface !== null) beginDirectManipulation(surface);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const pointer = state.pointers.get(event.pointerId);
    if (pointer === undefined) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (!state.eligible || event.pointerId !== state.primaryId) return;

    const dx = pointer.x - pointer.startX;
    const dy = pointer.y - pointer.startY;

    if (Math.max(Math.abs(dx), Math.abs(dy)) > gestureMotion.longPressMoveTolerance) {
      clearTimers();
      releasePressFeedback();
    }

    lockAxis(dx, dy);
    if (state.axis === null) return;

    event.preventDefault();
    latestX = gsapClamp(dx);
    latestY = gsapClamp(dy);
    scheduleFrame();
  };

  const commitPrimary = (pointer: ActivePointer, event: PointerEvent): boolean => {
    if (state.axis === null) return false;

    const dx = pointer.x - pointer.startX;
    const dy = pointer.y - pointer.startY;
    const elapsed = Math.max(1, event.timeStamp - pointer.startedAt);
    const distance = state.axis === "h" ? Math.abs(dx) : Math.abs(dy);
    const velocity = distance / elapsed;
    if (
      state.axis === "h" &&
      getView() === "focus" &&
      ((state.feedback === "list-indicator" && dx >= 0) ||
        (state.feedback === "surface" && dx <= 0))
    ) {
      return false;
    }
    const shouldCommit =
      distance >= gestureMotion.swipeDistance || velocity >= gestureMotion.swipeVelocity;
    if (!shouldCommit) return false;

    let result: boolean | void = false;
    if (state.axis === "h") {
      result = dx > 0
        ? handlers.onSwipeRight?.(velocity)
        : handlers.onSwipeLeft?.(velocity);
    } else {
      result = dy < 0
        ? handlers.onSwipeUp?.(velocity)
        : handlers.onSwipeDown?.(velocity);
    }

    if (result === true) haptic();
    return result === true;
  };

  const endPointer = (event: PointerEvent, allowCommit: boolean): void => {
    const pointer = state.pointers.get(event.pointerId);
    if (pointer === undefined) return;
    state.pointers.delete(event.pointerId);

    if (event.pointerId !== state.primaryId) return;

    clearTimers();
    if (!state.longPressFired) releasePressFeedback();
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
      applyFrame();
    }

    if (allowCommit && state.longPressCommitted) armClickSuppression();
    const committed = allowCommit && !state.longPressFired && commitPrimary(pointer, event);
    if (!committed) cancelDragFeedback();

    releaseCapture(event.pointerId);
    resetPrimary();
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    if (clickSuppressionTimer !== null) {
      clearTimeout(clickSuppressionTimer);
      clickSuppressionTimer = null;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  root.addEventListener("pointerdown", onPointerDown, listenerOptions);
  root.addEventListener("pointermove", onPointerMove, listenerOptions);
  root.addEventListener("pointerup", (event) => endPointer(event, true), listenerOptions);
  root.addEventListener("pointercancel", (event) => endPointer(event, false), listenerOptions);
  root.addEventListener("click", onClick, { ...listenerOptions, capture: true });

  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (clickSuppressionTimer !== null) clearTimeout(clickSuppressionTimer);
    clearTimers();
    releasePressFeedback();
    controller.abort();
  };
}

function gsapClamp(value: number): number {
  return Math.max(
    -gestureMotion.maxDragDistance,
    Math.min(gestureMotion.maxDragDistance, value),
  );
}

export interface RowSwipeHandlers {
  onDelete: () => void;
}

export function attachRowSwipe(row: HTMLElement, handlers: RowSwipeHandlers): () => void {
  const controller = new AbortController();
  const listenerOptions = { signal: controller.signal };
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let x = 0;
  let y = 0;
  let axis: "h" | "v" | null = null;
  let suppressClick = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (isInteractive(event.target)) return;
    pointerId = event.pointerId;
    startX = x = event.clientX;
    startY = y = event.clientY;
    axis = null;
    suppressClick = false;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    x = event.clientX;
    y = event.clientY;
    const dx = x - startX;
    const dy = y - startY;

    if (axis === null && Math.max(Math.abs(dx), Math.abs(dy)) >= gestureMotion.axisLockDistance) {
      axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      if (axis === "h" && dx < 0) {
        beginDirectManipulation(row);
        try {
          row.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is optional.
        }
      }
    }

    if (axis !== "h") return;
    event.preventDefault();
    suppressClick = Math.abs(dx) > gestureMotion.axisLockDistance;
    updateDragFeedback(row, Math.min(0, dx), 0);
  };

  const finish = (event: PointerEvent, allowDelete: boolean): void => {
    if (pointerId !== event.pointerId) return;
    const dx = x - startX;
    pointerId = null;

    try {
      if (row.hasPointerCapture(event.pointerId)) row.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may have released it already.
    }

    if (allowDelete && axis === "h" && dx <= -gestureMotion.rowDeleteDistance) {
      suppressClick = true;
      animateRowDelete(row, handlers.onDelete);
    } else if (axis === "h") {
      springBack(row);
    }

    axis = null;
  };

  const onClick = (event: MouseEvent): void => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    queueMicrotask(() => {
      suppressClick = false;
    });
  };

  row.addEventListener("pointerdown", onPointerDown, listenerOptions);
  row.addEventListener("pointermove", onPointerMove, listenerOptions);
  row.addEventListener("pointerup", (event) => finish(event, true), listenerOptions);
  row.addEventListener("pointercancel", (event) => finish(event, false), listenerOptions);
  row.addEventListener("click", onClick, { ...listenerOptions, capture: true });

  return () => controller.abort();
}
