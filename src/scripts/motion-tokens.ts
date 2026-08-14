/** Shared motion values for GSAP timelines and gesture feedback. */

export const motionDurations = {
  feedback: 0.08,
  micro: 0.12,
  local: 0.22,
  settle: 0.3,
  gestureCommit: 0.34,
  sharedLayout: 0.42,
  celebration: 0.46,
} as const;

export const motionEases = {
  direct: "power4.out",
  shared: "power3.inOut",
  settle: "expo.out",
  state: "power2.out",
  press: "power3.out",
  celebration: "back.out(1.2)",
} as const;

export const gestureMotion = {
  swipeDistance: 64,
  swipeVelocity: 0.5,
  axisLockDistance: 12,
  longPressDelay: 430,
  pressFeedbackDelay: 180,
  longPressMoveTolerance: 12,
  maxDragDistance: 520,
  rowDeleteDistance: 72,
} as const;

export const transitionMotion = {
  layerOffset: 18,
  edgeLimit: 112,
  pressScale: 0.992,
} as const;
