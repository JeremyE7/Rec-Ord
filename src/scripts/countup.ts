/**
 * rec-ord — Hero value count-up animation
 *
 * Provides `animateHero(element, targetValue)` which uses countup.js to
 * roll the hero number from 0 up to the target value. The library is
 * statically imported so it's always available — the ~5kb gzipped cost
 * is acceptable for this app and avoids the dynamic-import resolution
 * failures that were causing the animation to be invisible.
 *
 * Design decisions:
 *   - Static import: `import { CountUp } from "countup.js"` ensures the
 *     module is always bundled and available. The previous dynamic import
 *     (`await import("countup.js")`) caused code-splitting issues in
 *     Astro/Vite production builds where the chunk URL could be incorrect.
 *   - Always starts from 0: the scoreboard effect of "rolling from zero"
 *     every time the record changes is more visually impactful than
 *     rolling from the current value. The caller sets textContent to "0"
 *     before calling this function.
 *   - Reduced-motion: when `prefers-reduced-motion` is active, we skip
 *     the animation entirely and set the value directly.
 *   - The function is async (returns `Promise<void>`) but callers use
 *     `void animateHero(...)` — they don't need to await the animation.
 *   - If CountUp reports an error after `.start()`, we fall back to
 *     setting `textContent` directly so the value is never blank.
 */

import { CountUp } from "countup.js";
import { formatValueForUnit, prefersReducedMotion } from "./motion";

/**
 * Animate the hero element's displayed value from 0 to `targetValue`
 * using a count-up effect.
 *
 * For time units (HRS, MIN, SEC) the formatted value is not a plain
 * number ("1h 30m") — CountUp can't animate that, so we skip the
 * animation and set the value directly.
 *
 * @param element - The `<h1>` element displaying the hero value.
 * @param targetValue - The numeric value to animate toward.
 * @param unit - The record's unit string, used for unit-aware
 *               formatting. Empty string falls back to the old
 *               `formatValue` path.
 */
export async function animateHero(
  element: HTMLElement,
  targetValue: number,
  unit: string,
): Promise<void> {
  const u = unit.toUpperCase().trim();
  const isTime = u === "HRS" || u === "MIN" || u === "SEC";

  // Reduced motion: skip animation, set value directly with unit-aware
  // formatting.
  if (prefersReducedMotion() || isTime) {
    element.textContent = formatValueForUnit(targetValue, unit);
    return;
  }

  try {
    // Always start from 0 — the scoreboard effect. The caller is
    // responsible for setting element.textContent to "0" before calling
    // this function (done in app.ts updateDOM).
    // `decimalPlaces: 0` — non-time units are always integers, so the
    // count-up should never show decimals.
    const counter = new CountUp(element, targetValue, {
      startVal: 0,
      duration: 1.5,
      useEasing: true,
      useGrouping: false,
      decimalPlaces: 0,
      separator: "",
    });

    counter.start();

    // If CountUp reported an error, fall back to direct text.
    if (counter.error) {
      element.textContent = formatValueForUnit(targetValue, unit);
    }
  } catch {
    // Graceful degradation: the element already has the correct value
    // set by render.ts, so nothing to do.
    element.textContent = formatValueForUnit(targetValue, unit);
  }
}
