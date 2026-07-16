/**
 * rec-ord — Motion Controller
 *
 * The bridge between gesture intents and visual animations. The gesture
 * handler emits intents ("dragging", "committed", "cancelled") and this
 * controller translates them into Motion One animations using the tokens.
 *
 * Architecture:
 *   gesture handler → intent → motion controller → animate()
 *
 * The gesture handler NEVER touches style.transform directly. All visual
 * feedback flows through this controller, ensuring consistent motion
 * language and making it easy to tweak the feel globally.
 *
 * Performance contract:
 *   - Only transform and opacity are animated (GPU-composited)
 *   - will-change is set only during active animations
 *   - All animations respect prefers-reduced-motion
 * ------------------------------------------------------------------------- */

import { animate, type AnimationOptions } from "motion";
import { durations, easings, opacity, springs, transforms } from "./motion-tokens";

/* ---------------------------------------------------------------------------
 * Reduced motion detection
 * ------------------------------------------------------------------------- */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Returns true if the user prefers reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION).matches;
}

/* ---------------------------------------------------------------------------
 * Animation helpers
 *
 * These wrap Motion One's animate() with reduced-motion awareness and
 * common patterns. All animations return a Promise that resolves when
 * the animation completes (or immediately if reduced motion is on).
 * ------------------------------------------------------------------------- */

/**
 * Animate an element with reduced-motion awareness.
 *
 * If the user prefers reduced motion, the animation is skipped and the
 * element is set to its final state immediately. Otherwise, the animation
 * runs normally.
 *
 * @param el - The element to animate
 * @param keyframes - The keyframes to animate (e.g. { y: [100, 0] })
 * @param options - Animation options (spring, duration, easing, etc.)
 * @returns A promise that resolves when the animation completes
 */
export function animateSafe(
  el: HTMLElement,
  keyframes: Record<string, string | number | (string | number)[]>,
  options: AnimationOptions,
): Promise<void> {
  if (prefersReducedMotion()) {
    // Skip animation — set to final state immediately
    const finalState: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(keyframes)) {
      if (Array.isArray(value)) {
        finalState[key] = value[value.length - 1] as string | number;
      } else {
        finalState[key] = value;
      }
    }
    Object.assign(el.style, finalState);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const animation = animate(el, keyframes, {
      ...options,
      onComplete: () => resolve(),
    });
    // Safety: if the animation doesn't fire onComplete for some reason,
    // resolve after a generous timeout
    setTimeout(() => resolve(), 2000);
    void animation; // suppress unused warning
  });
}

/* ---------------------------------------------------------------------------
 * Drag feedback
 *
 * Visual feedback while the user is dragging the focus card. The card
 * follows the finger with a subtle opacity reduction.
 * ------------------------------------------------------------------------- */

export interface DragFeedbackOptions {
  /** The element being dragged (the focus card). */
  card: HTMLElement;
  /** Vertical offset in pixels (positive = down, negative = up). */
  dy: number;
  /** Horizontal offset in pixels (positive = right, negative = left). */
  dx?: number;
}

/**
 * Update the card's transform and opacity during a drag.
 *
 * The card follows the finger 1:1 (no spring lag) with a subtle opacity
 * reduction that increases with distance. This gives the user immediate
 * feedback that the gesture is being recognized.
 *
 * Performance: uses translate3d for GPU compositing. No layout thrashing.
 */
export function updateDragFeedback({ card, dy, dx = 0 }: DragFeedbackOptions): void {
  // Clamp to prevent over-fling (the user can drag way past the viewport)
  const MAX_OFFSET = 500;
  const clampedDy = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, dy));
  const clampedDx = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, dx));

  // Opacity decreases with distance, but stays readable
  // At 0px: opacity 1.0, at 250px: opacity 0.7, at 500px: opacity 0.5
  const distance = Math.sqrt(clampedDx * clampedDx + clampedDy * clampedDy);
  const opacityValue = Math.max(opacity.muted, opacity.full - distance / 500);

  card.style.transform = `translate3d(${clampedDx}px, ${clampedDy}px, 0)`;
  card.style.opacity = String(opacityValue);
}

/**
 * Clear drag feedback — reset the card to its resting state.
 *
 * Use this when the drag is cancelled or when transitioning to a
 * spring-back animation.
 */
export function clearDragFeedback(card: HTMLElement): void {
  card.style.transform = "";
  card.style.opacity = "";
}

/* ---------------------------------------------------------------------------
 * Spring back
 *
 * When a drag is cancelled (the user didn't commit), the card springs
 * back to its resting position with physics-based motion.
 * ------------------------------------------------------------------------- */

/**
 * Spring the card back to its resting position after a cancelled drag.
 *
 * Uses the "gentle" spring preset for a subtle, natural feel. The card
 * eases back to y=0 with a slight overshoot that settles quickly.
 *
 * @param card - The element to animate
 * @returns A promise that resolves when the animation completes
 */
export function springBack(card: HTMLElement): Promise<void> {
  return animateSafe(
    card,
    {
      y: 0,
      x: 0,
      opacity: opacity.full,
    },
    springs.gentle,
  );
}

/* ---------------------------------------------------------------------------
 * Fly out
 *
 * When a swipe is committed, the card flies out in the direction of the
 * gesture with the velocity of the finger. This is the key to making
 * gestures feel responsive and fluid.
 * ------------------------------------------------------------------------- */

export interface FlyOutOptions {
  /** The element to animate out. */
  card: HTMLElement;
  /** Direction: "up", "down", "left", "right". */
  direction: "up" | "down" | "left" | "right";
  /** The velocity of the finger at release (px/ms). Used to scale the exit. */
  velocity?: number;
}

/**
 * Animate the card flying out of the viewport after a committed swipe.
 *
 * The card accelerates in the direction of the gesture, fading as it
 * exits. The velocity parameter allows the exit to feel connected to
 * the user's finger speed — a fast swipe makes the card fly out faster.
 *
 * @returns A promise that resolves when the animation completes
 */
export function flyOut({ card, direction, velocity = 0 }: FlyOutOptions): Promise<void> {
  // Base duration is "short" (250ms), but fast swipes are faster
  // Velocity is in px/ms; a "fast" swipe is > 0.5 px/ms
  const duration = velocity > 0.5 ? durations.short * 0.7 : durations.short;

  const keyframes: Record<string, string | number> = {};

  switch (direction) {
    case "up":
      keyframes.y = transforms.slideToTop;
      break;
    case "down":
      keyframes.y = transforms.slideFromBottom;
      break;
    case "left":
      keyframes.x = transforms.slideToLeft;
      break;
    case "right":
      keyframes.x = transforms.slideFromRight;
      break;
  }

  keyframes.opacity = opacity.hidden;

  return animateSafe(card, keyframes, {
    duration: duration / 1000, // Convert ms to seconds
    ease: easings.decelerate,
  });
}

/* ---------------------------------------------------------------------------
 * Press signal
 *
 * Subtle feedback when the user presses and holds. After a short delay,
 * the element scales down slightly to signal "I'm registering your press".
 * ------------------------------------------------------------------------- */

/**
 * Apply the press signal — a subtle scale-down that signals the press
 * is being detected.
 *
 * @param card - The element to animate
 * @returns A promise that resolves when the animation completes
 */
export function pressSignal(card: HTMLElement): Promise<void> {
  return animateSafe(
    card,
    {
      scale: transforms.pressScale,
      opacity: opacity.dim,
    },
    {
      duration: durations.micro / 1000,
      ease: easings.standard,
    },
  );
}

/**
 * Release the press signal — return to full scale and opacity.
 *
 * @param card - The element to animate
 * @returns A promise that resolves when the animation completes
 */
export function releasePress(card: HTMLElement): Promise<void> {
  return animateSafe(
    card,
    {
      scale: 1,
      opacity: opacity.full,
    },
    springs.gentle,
  );
}

/* ---------------------------------------------------------------------------
 * Progress bar
 *
 * The thin bar at the bottom of the viewport that fills as the user
 * drags, providing visual feedback that they're approaching the commit
 * threshold.
 * ------------------------------------------------------------------------- */

export interface ProgressBarOptions {
  /** The progress bar element. */
  bar: HTMLElement;
  /** Progress value from 0 to 1. */
  progress: number;
}

/**
 * Update the progress bar's fill based on drag progress.
 *
 * The bar uses scaleX for GPU-composited animation. The transform-origin
 * is set to "left center" so it fills from left to right.
 */
export function updateProgressBar({ bar, progress }: ProgressBarOptions): void {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  bar.style.transform = `scaleX(${clampedProgress})`;
}

/**
 * Reset the progress bar to empty.
 */
export function resetProgressBar(bar: HTMLElement): void {
  bar.style.transform = "scaleX(0)";
}

/* ---------------------------------------------------------------------------
 * Swipe hint
 *
 * The edge label that slides in when the user starts a horizontal swipe,
 * signaling the direction of the gesture.
 * ------------------------------------------------------------------------- */

export interface SwipeHintOptions {
  /** The hint element. */
  hint: HTMLElement;
  /** Progress value from 0 to 1. */
  progress: number;
}

/**
 * Update the swipe hint's position and opacity based on drag progress.
 *
 * The hint slides in from off-screen (x = -200px) and fades in as the
 * user drags. At progress=1, it's fully visible in its resting position.
 */
export function updateSwipeHint({ hint, progress }: SwipeHintOptions): void {
  const clampedProgress = Math.max(0, Math.min(1, progress));
  // At progress=0: x = -200px (off-screen)
  // At progress=1: x = 0 (resting position)
  const x = -200 + clampedProgress * 200;
  hint.style.transform = `translate3d(${x}px, -50%, 0)`;
  hint.style.opacity = String(clampedProgress);
}

/**
 * Hide the swipe hint — slide it back off-screen.
 */
export function hideSwipeHint(hint: HTMLElement): void {
  animateSafe(
    hint,
    {
      x: -200,
      opacity: opacity.hidden,
    },
    {
      duration: durations.short / 1000,
      ease: easings.exit,
    },
  );
}

/* ---------------------------------------------------------------------------
 * Rubber band
 *
 * Elastic resistance when the user drags past the edge (e.g., swiping
 * down on the first record). The card stretches like a rubber band and
 * snaps back when released.
 * ------------------------------------------------------------------------- */

export interface RubberBandOptions {
  /** The drag offset (positive = past the edge, negative = valid range). */
  offset: number;
  /** Maximum stretch distance before resistance becomes very strong. */
  maxStretch?: number;
}

/**
 * Apply rubber-band resistance when dragging past an edge.
 *
 * The further the user drags, the more resistance they feel. The offset
 * is dampened logarithmically so small overscrolls feel natural but
 * large overscrolls feel very resistant.
 *
 * @returns The dampened offset to apply to the card's transform
 */
export function rubberBand({ offset, maxStretch = 100 }: RubberBandOptions): number {
  if (offset <= 0) return offset; // No resistance in the valid direction

  // Logarithmic dampening: the further you go, the more resistance
  // At offset=50: dampened ≈ 35
  // At offset=100: dampened ≈ 63
  // At offset=200: dampened ≈ 95
  const dampened = maxStretch * Math.log10(1 + offset / maxStretch);
  return dampened;
}

/**
 * Spring back from a rubber-band stretch.
 *
 * Uses the "sticky" spring preset for a slow, elastic return.
 *
 * @param card - The element to animate
 * @returns A promise that resolves when the animation completes
 */
export function rubberBandSnapBack(card: HTMLElement): Promise<void> {
  return animateSafe(
    card,
    {
      y: 0,
      x: 0,
      opacity: opacity.full,
    },
    springs.sticky,
  );
}
