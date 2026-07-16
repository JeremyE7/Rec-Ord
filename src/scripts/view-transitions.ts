/**
 * rec-ord — View Transitions
 *
 * Replacements for the View Transitions API. Each transition is a function
 * that orchestrates the old and new elements using Motion One animations
 * with the motion tokens.
 *
 * Architecture:
 *   1. Capture the old element (the current view)
 *   2. Update the DOM (the render module swaps in the new view)
 *   3. Capture the new element
 *   4. Animate old out + new in simultaneously
 *
 * Performance contract:
 *   - Only transform and opacity are animated
 *   - Old element is position: absolute during animation (no layout shift)
 *   - All animations respect prefers-reduced-motion via animateSafe()
 * ------------------------------------------------------------------------- */

import { animateSafe } from "./motion-controller";
import { durations, easings, opacity, springs, transforms } from "./motion-tokens";

/* ---------------------------------------------------------------------------
 * Transition helpers
 * ------------------------------------------------------------------------- */

/**
 * Prepare the old element for exit animation.
 *
 * Sets position: absolute so it doesn't affect layout when the new
 * element is inserted. The element is positioned at its current location
 * via explicit top/left/width/height.
 */
function prepareExit(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  el.style.position = "absolute";
  el.style.top = `${rect.top}px`;
  el.style.left = `${rect.left}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.margin = "0";
  el.style.zIndex = "10";
}

/**
 * Clean up the old element after exit animation completes.
 */
function cleanupExit(el: HTMLElement): void {
  el.remove();
}

/**
 * Prepare the new element for entrance animation.
 *
 * Sets initial state (transform, opacity) so the animation can interpolate
 * from the starting keyframe.
 */
function prepareEntrance(el: HTMLElement, initialTransform: string): void {
  el.style.transform = initialTransform;
  el.style.opacity = String(opacity.ghost);
}

/**
 * Clean up the new element after entrance animation completes.
 */
function cleanupEntrance(el: HTMLElement): void {
  el.style.transform = "";
  el.style.opacity = "";
}

/* ---------------------------------------------------------------------------
 * nav-vertical
 *
 * Swipe up/down to navigate between records. The old card slides out
 * in the direction of the swipe, the new card slides in from the opposite
 * direction.
 *
 * Direction is determined by the gesture (up or down), not hardcoded.
 * ------------------------------------------------------------------------- */

export interface NavVerticalOptions {
  /** The old element (current card). */
  oldEl: HTMLElement;
  /** The new element (next/previous card). */
  newEl: HTMLElement;
  /** Direction of the swipe: "up" means swiping up (going to next/older). */
  direction: "up" | "down";
  /** Swipe velocity in px/ms. Fast swipes (> 0.5) use shorter duration. */
  velocity?: number;
}

/**
 * Animate a vertical navigation transition.
 *
 * Fast swipes (velocity > 0.5 px/ms) use a shorter exit duration
 * to match the user's finger speed. Slow swipes use the default
 * medium duration for a more deliberate feel.
 *
 * @returns A promise that resolves when both animations complete
 */
export async function navVertical({
  oldEl,
  newEl,
  direction,
  velocity = 0,
}: NavVerticalOptions): Promise<void> {
  prepareExit(oldEl);

  const oldExit = direction === "up" ? transforms.slideToTop : transforms.slideFromBottom;
  const newEntrance = direction === "up" ? transforms.slideFromBottom : transforms.slideToTop;

  prepareEntrance(newEl, `translateY(${newEntrance})`);

  // Scale duration by velocity: fast swipes are 60% of default duration.
  const exitDuration = velocity > 0.5
    ? (durations.medium * 0.6) / 1000
    : durations.medium / 1000;

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        y: oldExit,
        opacity: opacity.ghost,
      },
      {
        duration: exitDuration,
        ease: easings.exit,
      },
    ),
    animateSafe(
      newEl,
      {
        y: 0,
        opacity: opacity.full,
      },
      springs.default,
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}

/* ---------------------------------------------------------------------------
 * push-horizontal
 *
 * Swipe right to open the new-record form, swipe left to close it.
 * The old view slides out to the left, the new view slides in from the
 * right (or vice versa).
 * ------------------------------------------------------------------------- */

export interface PushHorizontalOptions {
  /** The old element (current view). */
  oldEl: HTMLElement;
  /** The new element (new view). */
  newEl: HTMLElement;
  /** Direction: "in" means opening the form (focus → new), "out" means closing. */
  direction: "in" | "out";
  /** Swipe velocity in px/ms. Fast swipes (> 0.5) use shorter duration. */
  velocity?: number;
}

/**
 * Animate a horizontal push transition.
 *
 * @returns A promise that resolves when both animations complete
 */
export async function pushHorizontal({
  oldEl,
  newEl,
  direction,
  velocity = 0,
}: PushHorizontalOptions): Promise<void> {
  prepareExit(oldEl);

  // For the old element, also scale down slightly to create a "pushing back" effect
  const oldExitTransform = direction === "in" ? -0.3 : 1;
  const newEntranceTransform = direction === "in" ? 1 : -0.3;

  prepareEntrance(
    newEl,
    `translateX(${newEntranceTransform * 100}%)`,
  );

  // Scale duration by velocity: fast swipes are 60% of default duration.
  const exitDuration = velocity > 0.5
    ? (durations.medium * 0.6) / 1000
    : durations.medium / 1000;

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        x: `${oldExitTransform * 100}%`,
        opacity: opacity.muted,
      },
      {
        duration: exitDuration,
        ease: easings.exit,
      },
    ),
    animateSafe(
      newEl,
      {
        x: 0,
        opacity: opacity.full,
      },
      springs.default,
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}

/* ---------------------------------------------------------------------------
 * expand / collapse
 *
 * Long-press to expand the focus card into edit mode, swipe down to
 * collapse. The card grows in place (no slide), with the content
 * crossfading.
 * ------------------------------------------------------------------------- */

export interface ExpandCollapseOptions {
  /** The old element (current card). */
  oldEl: HTMLElement;
  /** The new element (expanded/collapsed card). */
  newEl: HTMLElement;
}

/**
 * Animate an expand transition (focus → expanded).
 *
 * The old card fades out while the new card fades in. The height change
 * is handled by the layout (the new element has a different height),
 * so we don't animate height explicitly (that would require FLIP).
 *
 * @returns A promise that resolves when both animations complete
 */
export async function expand({ oldEl, newEl }: ExpandCollapseOptions): Promise<void> {
  prepareExit(oldEl);
  prepareEntrance(newEl, "translateY(20px)");

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        opacity: opacity.hidden,
      },
      {
        duration: durations.short / 1000,
        ease: easings.exit,
      },
    ),
    animateSafe(
      newEl,
      {
        y: 0,
        opacity: opacity.full,
      },
      springs.default,
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}

/**
 * Animate a collapse transition (expanded → focus).
 *
 * Same as expand but with a different easing (the card "settles" back
 * to its collapsed state).
 *
 * @returns A promise that resolves when both animations complete
 */
export async function collapse({ oldEl, newEl }: ExpandCollapseOptions): Promise<void> {
  prepareExit(oldEl);
  prepareEntrance(newEl, "translateY(-20px)");

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        opacity: opacity.hidden,
      },
      {
        duration: durations.short / 1000,
        ease: easings.exit,
      },
    ),
    animateSafe(
      newEl,
      {
        y: 0,
        opacity: opacity.full,
      },
      springs.default,
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}

/* ---------------------------------------------------------------------------
 * scale-morph
 *
 * Pinch out to open the grid, pinch in to close it. The hero value
 * scales down/up to create a "morphing" effect between the big focus
 * card and the small grid cells.
 * ------------------------------------------------------------------------- */

export interface ScaleMorphOptions {
  /** The old element (current view). */
  oldEl: HTMLElement;
  /** The new element (new view). */
  newEl: HTMLElement;
  /** Direction: "out" means opening the grid (focus → grid), "in" means closing. */
  direction: "out" | "in";
}

/**
 * Animate a scale-morph transition.
 *
 * The old element scales down and fades out, the new element scales up
 * from a smaller size and fades in. This creates a "zooming" effect
 * that connects the two views.
 *
 * @returns A promise that resolves when both animations complete
 */
export async function scaleMorph({
  oldEl,
  newEl,
  direction,
}: ScaleMorphOptions): Promise<void> {
  prepareExit(oldEl);

  const oldScale = direction === "out" ? transforms.scaleDown : transforms.scaleUp;
  const newScale = direction === "out" ? transforms.scaleUp : transforms.scaleDown;

  prepareEntrance(newEl, `scale(${newScale})`);

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        scale: oldScale,
        opacity: opacity.hidden,
      },
      {
        duration: durations.medium / 1000,
        ease: easings.exit,
      },
    ),
    animateSafe(
      newEl,
      {
        scale: 1,
        opacity: opacity.full,
      },
      springs.default,
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}

/* ---------------------------------------------------------------------------
 * fade
 *
 * A simple crossfade for non-semantic transitions (e.g., toggling the
 * inline add-entry form, the delete-confirm label flip).
 * ------------------------------------------------------------------------- */

export interface FadeOptions {
  /** The old element. */
  oldEl: HTMLElement;
  /** The new element. */
  newEl: HTMLElement;
}

/**
 * Animate a simple crossfade.
 *
 * @returns A promise that resolves when both animations complete
 */
export async function fade({ oldEl, newEl }: FadeOptions): Promise<void> {
  prepareExit(oldEl);
  prepareEntrance(newEl, "translateY(0)");

  const [oldAnim, newAnim] = await Promise.all([
    animateSafe(
      oldEl,
      {
        opacity: opacity.hidden,
      },
      {
        duration: durations.short / 1000,
        ease: easings.standard,
      },
    ),
    animateSafe(
      newEl,
      {
        opacity: opacity.full,
      },
      {
        duration: durations.short / 1000,
        ease: easings.standard,
      },
    ),
  ]);

  cleanupExit(oldEl);
  cleanupEntrance(newEl);

  void oldAnim;
  void newAnim;
}
