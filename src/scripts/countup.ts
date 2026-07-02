/**
 * rec-ord — Hero value count-up animation
 *
 * Provides `animateHero(element, targetValue)` which uses countup.js to
 * roll the hero number from its current text content up (or down) to the
 * target value. The library is dynamically imported so it stays out of
 * the initial bundle — it's only needed when the hero value changes.
 *
 * Design decisions:
 *   - Lazy import: `await import("countup.js")` keeps the initial JS
 *     payload small. The animation is a progressive enhancement — if
 *     the import fails (offline, network error), the element's existing
 *     text content (set by render.ts) remains visible.
 *   - Reduced-motion: when `prefers-reduced-motion` is active, we skip
 *     the animation entirely and set the value directly. The user sees
 *     the number update instantly without any rolling effect.
 *   - The function is async (returns `Promise<void>`) but callers use
 *     `void animateHero(...)` — they don't need to await the animation.
 *   - If CountUp reports an error after `.start()`, we fall back to
 *     setting `textContent` directly so the value is never blank.
 */

import { formatValue, prefersReducedMotion } from "./motion";

/**
 * Animate the hero element's displayed value from its current content
 * to `targetValue` using a count-up effect.
 *
 * @param element - The `<h1>` element displaying the hero value.
 * @param targetValue - The numeric value to animate toward.
 */
export async function animateHero(
  element: HTMLElement,
  targetValue: number,
): Promise<void> {
  // Reduced motion: skip animation, set value directly.
  if (prefersReducedMotion()) {
    element.textContent = formatValue(targetValue);
    return;
  }

  try {
    const mod = await import("countup.js");
    const CountUp = mod.CountUp;

    // Parse the current text content as the start value. If it's not a
    // valid number (e.g. "—"), fall back to 0.
    const currentText = element.textContent ?? "";
    const startValue = Number.parseFloat(currentText);
    const start = Number.isFinite(startValue) ? startValue : 0;

    const counter = new CountUp(element, targetValue, {
      startVal: start,
      duration: 1.2,
      useEasing: true,
      useGrouping: false,
      decimalPlaces: 1,
      separator: "",
    });

    counter.start();

    // If CountUp reported an error, fall back to direct text.
    if (counter.error) {
      element.textContent = formatValue(targetValue);
    }
  } catch {
    // Dynamic import failed — graceful degradation: the element already
    // has the correct value set by render.ts, so nothing to do.
    element.textContent = formatValue(targetValue);
  }
}
