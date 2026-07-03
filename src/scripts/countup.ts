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
 * CountUp natively animates a plain number. We use its `formattingFn`
 * callback to convert the animated number to the unit-aware string at
 * every frame, so time units ("7.5" → "7h 30m") animate smoothly
 * alongside integer-only units.
 *
 * AESTHETIC FIX — text-wrap flicker prevention:
 * During the animation the formatted value changes length ("6m" →
 * "1h 30m"), and with `break-words` + `justify-end` the hero element
 * wraps at different positions, causing a visible "jump" up/down in
 * the layout. We pin the element to `white-space: nowrap` and
 * `overflow: hidden` for the duration of the animation, which keeps
 * the value on one stable line. After the animation completes we
 * restore the original `break-words` class.
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
  // Reduced motion: skip animation, set value directly.
  if (prefersReducedMotion()) {
    element.textContent = formatValueForUnit(targetValue, unit);
    return;
  }

  // Pin the element to a single, stable line during the animation so
  // the changing text length doesn't cause wrapping flicker.
  element.classList.remove("break-words");
  element.style.whiteSpace = "nowrap";
  element.style.overflow = "hidden";

  try {
    // Always start from 0 — the scoreboard effect. The caller is
    // responsible for setting element.textContent to "0" before calling
    // this function (done in app.ts updateDOM).
    //
    // For time units we keep decimalPlaces: 1 so the animated number
    // increments smoothly (e.g. 0.0 → 0.1 → 0.2 … → 7.5). For
    // integer-only units decimalPlaces: 0 is fine (0 → 1 → 2…).
    // The formattingFn converts the raw number to the unit-aware
    // string at every step.
    const isTime = ["HRS", "MIN", "SEC"].includes(unit.toUpperCase().trim());
    const counter = new CountUp(element, targetValue, {
      startVal: 0,
      duration: 1.5,
      useEasing: true,
      useGrouping: false,
      decimalPlaces: isTime ? 1 : 0,
      separator: "",
      formattingFn: (val: number) => formatValueForUnit(val, unit),
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
  } finally {
    // Restore the wrap behaviour that was temporarily disabled during
    // the animation. This lets the hero wrap naturally if the value
    // is too wide when the animation is not running.
    element.style.whiteSpace = "";
    element.style.overflow = "";
    element.classList.add("break-words");
  }
}
