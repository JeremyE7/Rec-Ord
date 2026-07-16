/**
 * rec-ord — Motion Tokens
 *
 * Single source of truth for all motion values. Like design tokens for
 * animation. Every spring, duration, and easing lives here so the entire
 * app has a consistent motion language.
 *
 * Philosophy:
 *   - Springs are physics-based (stiffness + damping) for natural feel
 *   - Durations are semantic (micro, short, medium, long) not arbitrary ms
 *   - Easings are named by their visual character, not their math
 *
 * Usage:
 *   import { springs, durations } from "./motion-tokens"
 *   animate(el, { y: 0 }, { type: "spring", ...springs.default })
 */

/* ---------------------------------------------------------------------------
 * Spring presets
 *
 * Physics-based springs using Motion One's spring animation.
 *   - stiffness: how strong the spring pulls toward the target
 *   - damping: how quickly the spring loses energy (friction)
 *   - mass: how heavy the object feels (default 1)
 *
 * Tweak guide:
 *   - More stiffness = snappier, more overshoot
 *   - More damping = less bounce, settles faster
 *   - Critical damping (no overshoot) ≈ damping = 2 * sqrt(stiffness)
 * ------------------------------------------------------------------------- */

export interface SpringConfig {
  type: "spring";
  stiffness: number;
  damping: number;
  mass?: number;
}

export const springs = {
  /**
   * Gentle spring for subtle feedback (press signals, hover states).
   * Low stiffness, moderate damping — barely noticeable overshoot.
   */
  gentle: {
    type: "spring" as const,
    stiffness: 200,
    damping: 25,
  },

  /**
   * Default spring for view transitions and gesture commits.
   * Balanced stiffness and damping — one subtle overshoot, settles quickly.
   * This is the "signature" motion of the app.
   */
  default: {
    type: "spring" as const,
    stiffness: 300,
    damping: 28,
  },

  /**
   * Snappy spring for fast commits (swipe to navigate, quick actions).
   * High stiffness, high damping — minimal overshoot, fast settle.
   */
  snappy: {
    type: "spring" as const,
    stiffness: 400,
    damping: 32,
  },

  /**
   * Sticky spring for rubber-band effects (edge resistance, drag limits).
   * Low stiffness, low damping — stretches and bounces back slowly.
   */
  sticky: {
    type: "spring" as const,
    stiffness: 150,
    damping: 20,
  },

  /**
   * Bouncy spring for celebratory moments (new record, achievement).
   * Medium stiffness, low damping — visible overshoot, playful feel.
   */
  bouncy: {
    type: "spring" as const,
    stiffness: 280,
    damping: 18,
  },
} as const;

/* ---------------------------------------------------------------------------
 * Duration presets
 *
 * Semantic durations for non-spring animations (crossfades, simple transforms).
 * Named by their perceived speed, not their millisecond value.
 *
 * Tweak guide:
 *   - micro: instant feedback (button press, hover)
 *   - short: gesture feedback (drag start, swipe hint)
 *   - medium: view transitions (navigate, expand, collapse)
 *   - long: complex choreography (multi-element sequences)
 * ------------------------------------------------------------------------- */

export const durations = {
  /** Instant feedback — press signal, hover state change. */
  micro: 150,

  /** Gesture feedback — drag start, swipe hint appearance. */
  short: 250,

  /** View transitions — navigate between records, expand/collapse. */
  medium: 350,

  /** Complex choreography — multi-element sequences, celebrations. */
  long: 500,
} as const;

/* ---------------------------------------------------------------------------
 * Easing presets
 *
 * Cubic bezier curves for non-spring animations. Named by their visual
 * character. Use these for simple transform/opacity animations where
 * spring physics would be overkill.
 *
 * Format: [x1, y1, x2, y2] for cubic-bezier()
 * ------------------------------------------------------------------------- */

export const easings = {
  /**
   * Smooth entrance — starts slow, accelerates gently.
   * Use for elements entering the viewport (slide in, fade in).
   */
  enter: [0.0, 0.0, 0.2, 1] as const,

  /**
   * Smooth exit — starts fast, decelerates gently.
   * Use for elements leaving the viewport (slide out, fade out).
   */
  exit: [0.4, 0.0, 1, 1] as const,

  /**
   * Standard ease — balanced acceleration and deceleration.
   * Use for most transitions (crossfades, simple transforms).
   */
  standard: [0.4, 0.0, 0.2, 1] as const,

  /**
   * Decelerate — starts fast, slows to a stop.
   * Use for elements that need to feel like they're "landing" (fly-out).
   */
  decelerate: [0.0, 0.0, 0.2, 1] as const,

  /**
   * Accelerate — starts slow, speeds up.
   * Use for elements that need to feel like they're "taking off".
   */
  accelerate: [0.4, 0.0, 1, 1] as const,
} as const;

/* ---------------------------------------------------------------------------
 * Opacity presets
 *
 * Standard opacity values for fade animations. Using consistent values
 * ensures visual coherence across the app.
 * ------------------------------------------------------------------------- */

export const opacity = {
  /** Fully transparent — element is invisible. */
  hidden: 0,

  /** Subtle fade — element is barely visible (ghost state). */
  ghost: 0.3,

  /** Muted — element is visible but de-emphasized (during drag). */
  muted: 0.6,

  /** Semi-transparent — element is present but not dominant. */
  dim: 0.8,

  /** Fully opaque — element is at full visibility. */
  full: 1,
} as const;

/* ---------------------------------------------------------------------------
 * Transform presets
 *
 * Common transform values for slide/scale animations. Using consistent
 * values ensures visual coherence and makes the motion language predictable.
 * ------------------------------------------------------------------------- */

export const transforms = {
  /** Slide in from below the viewport (100% of parent height). */
  slideFromBottom: "100%",

  /** Slide out above the viewport (-100% of parent height). */
  slideToTop: "-100%",

  /** Slide in from the right (100% of parent width). */
  slideFromRight: "100%",

  /** Slide out to the left (-100% of parent width). */
  slideToLeft: "-100%",

  /** Scale down to 25% (for hero morph, grid cell shrink). */
  scaleDown: 0.25,

  /** Scale up from 4x (for hero morph, grid cell expand). */
  scaleUp: 4,

  /** Subtle press scale (for press signal, hover). */
  pressScale: 0.97,
} as const;
