/**
 * Gesture-led GSAP motion controller.
 *
 * Most navigation begins as direct manipulation: the active surface follows
 * the pointer exactly, then continues from that visual position on release.
 * List navigation keeps the record geometry stable and previews the action
 * with a dedicated edge indicator instead.
 * Layout changes use shared-element FLIP animation. Local form changes only
 * animate the element that appeared; the application root never crossfades.
 */

import { gsap } from "gsap";
import { Flip } from "gsap/Flip";
import {
  motionDurations,
  motionEases,
  transitionMotion,
} from "./motion-tokens";

gsap.registerPlugin(Flip);

export type MotionTransition =
  | { type: "record"; direction: "up" | "down"; velocity?: number }
  | { type: "panel"; direction: "in" | "out"; velocity?: number }
  | { type: "expand"; direction: "in" | "out" }
  | { type: "grid"; direction: "in" | "out" }
  | { type: "fade" };

interface ActiveTransition {
  animation: gsap.core.Animation;
  cleanup: () => void;
}

type CapturedFlipState = ReturnType<typeof Flip.getState>;

const SHARED_FLIP_PROPS = [
  "backgroundColor",
  "borderRadius",
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "lineHeight",
].join(",");

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let activeTransition: ActiveTransition | null = null;

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia(REDUCED_MOTION_QUERY).matches;
}

function transitionDuration(velocity = 0): number {
  if (velocity <= 0) return motionDurations.gestureCommit;
  return gsap.utils.clamp(
    0.18,
    motionDurations.gestureCommit,
    motionDurations.gestureCommit - Math.max(0, velocity - 0.35) * 0.14,
  );
}

function clearInlineMotion(element: HTMLElement): void {
  gsap.set(element, {
    clearProps: "transform,opacity,visibility,willChange,zIndex,position,top,left,width,height,margin,pointerEvents,backgroundColor,overflow,transformOrigin",
  });
}

function clearListSwipeIndicator(element: HTMLElement): void {
  gsap.set(element, {
    clearProps: "transform,opacity,visibility,willChange,transformOrigin",
  });
}

function clearMany(elements: Iterable<HTMLElement>): void {
  for (const element of elements) clearInlineMotion(element);
}

function interruptActiveTransition(): void {
  if (activeTransition === null) return;
  const previous = activeTransition;
  activeTransition = null;
  previous.animation.kill();
  previous.cleanup();
}

function trackTransition(
  animation: gsap.core.Animation,
  mount: HTMLElement,
  cleanupWork: () => void,
): Promise<void> {
  mount.setAttribute("aria-busy", "true");

  return new Promise((resolve) => {
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      cleanupWork();
      mount.removeAttribute("aria-busy");
      resolve();
    };

    animation.eventCallback("onComplete", () => {
      if (activeTransition?.animation === animation) activeTransition = null;
      cleanup();
    });
    activeTransition = { animation, cleanup };
  });
}

function removeDuplicateIds(root: HTMLElement): void {
  if (root.id !== "") root.removeAttribute("id");
  root.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
    element.removeAttribute("id");
  });
}

function motionLayers(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-motion-layer]")];
}

function sharedElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-flip-id]")];
}

function sharedElementIds(elements: Iterable<HTMLElement>): Set<string> {
  const ids = new Set<string>();
  for (const element of elements) {
    const id = element.dataset.flipId;
    if (id !== undefined && id !== "") ids.add(id);
  }
  return ids;
}

function createRevealShield(mount: HTMLElement): HTMLElement {
  const shield = document.createElement("div");
  shield.dataset.motionReveal = "true";
  shield.setAttribute("aria-hidden", "true");
  mount.append(shield);
  gsap.set(shield, {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "var(--surface-page)",
    pointerEvents: "none",
    zIndex: 2,
  });
  return shield;
}

function exposeSharedOverflow(
  targets: Iterable<HTMLElement>,
  boundary: HTMLElement,
): () => void {
  const candidates = new Set<HTMLElement>();
  for (const target of targets) {
    let ancestor = target.parentElement;
    while (ancestor !== null && ancestor !== boundary) {
      candidates.add(ancestor);
      ancestor = ancestor.parentElement;
    }
  }

  const clipped = [...candidates]
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.overflowX !== "visible" || style.overflowY !== "visible";
    })
    .map((element) => ({
      element,
      overflow: element.style.overflow,
      overflowX: element.style.overflowX,
      overflowY: element.style.overflowY,
    }));

  for (const { element } of clipped) {
    element.style.overflow = "visible";
    element.style.overflowX = "visible";
    element.style.overflowY = "visible";
  }

  return () => {
    for (const snapshot of clipped) {
      snapshot.element.style.overflow = snapshot.overflow;
      snapshot.element.style.overflowX = snapshot.overflowX;
      snapshot.element.style.overflowY = snapshot.overflowY;
    }
  };
}

function animateLocalChange(mount: HTMLElement, newElement: HTMLElement): Promise<void> {
  const localTargets = [
    ...newElement.querySelectorAll<HTMLElement>('[data-motion-layer="local"]'),
  ];
  if (localTargets.length === 0) return Promise.resolve();

  const animation = gsap.fromTo(
    localTargets,
    { y: 10, scale: 0.992, transformOrigin: "50% 0%" },
    {
      y: 0,
      scale: 1,
      duration: motionDurations.local,
      ease: motionEases.settle,
      stagger: 0.025,
      paused: true,
    },
  );
  animation.play();

  return trackTransition(animation, mount, () => clearMany(localTargets));
}

function animateSharedLayout(
  mount: HTMLElement,
  newElement: HTMLElement,
  state: CapturedFlipState,
  previousSharedIds: ReadonlySet<string>,
  absoluteTargets: boolean,
): Promise<void> {
  const sharedTargets = sharedElements(newElement).filter((element) => {
    const id = element.dataset.flipId;
    return id !== undefined && previousSharedIds.has(id);
  });
  if (sharedTargets.length === 0) return animateLocalChange(mount, newElement);

  // Keep the destination mounted in its final layout from the first frame. A
  // temporary shield hides every non-shared element while matching semantic
  // text nodes animate above it without clone scaling or a final DOM swap.
  const wasInert = newElement.inert;
  const shield = createRevealShield(mount);
  const restoreOverflow = exposeSharedOverflow(sharedTargets, newElement);
  newElement.inert = true;
  gsap.set(sharedTargets, {
    position: "relative",
    zIndex: 3,
    willChange: "transform,font-size,line-height,letter-spacing,color",
  });

  const timeline = Flip.from(state, {
    targets: sharedTargets,
    // Grid transitions swap differently styled text nodes. Keeping those
    // targets in flow lets source typography reflow the destination row before
    // Flip's first frame. Absolute targets preserve the captured source
    // geometry; the reveal shield keeps the settled grid layout hidden until
    // Flip restores the targets. Expand transitions keep their existing flow.
    absolute: absoluteTargets,
    nested: true,
    scale: false,
    fade: false,
    props: SHARED_FLIP_PROPS,
    duration: motionDurations.sharedLayout,
    ease: motionEases.shared,
    paused: true,
  });

  timeline.to(
    shield,
    {
      autoAlpha: 0,
      duration: motionDurations.local,
      ease: motionEases.state,
    },
    ">",
  );

  timeline.play();
  return trackTransition(timeline, mount, () => {
    shield.remove();
    restoreOverflow();
    newElement.inert = wasInert;
    clearMany(sharedTargets);
  });
}

function prepareExitOverlay(
  mount: HTMLElement,
  oldElement: HTMLElement,
  oldRect: DOMRect,
  mountRect: DOMRect,
): void {
  removeDuplicateIds(oldElement);
  oldElement.inert = true;
  oldElement.setAttribute("aria-hidden", "true");
  oldElement.dataset.motionExit = "true";
  mount.append(oldElement);

  gsap.set(oldElement, {
    position: "absolute",
    top: oldRect.top - mountRect.top,
    left: oldRect.left - mountRect.left,
    width: oldRect.width,
    height: oldRect.height,
    margin: 0,
    x: 0,
    y: 0,
    scale: 1,
    backgroundColor: "var(--surface-page)",
    overflow: "hidden",
    transformOrigin: "50% 50%",
    pointerEvents: "none",
    willChange: "transform",
    zIndex: 3,
  });
}

function animateGestureCommit(
  mount: HTMLElement,
  oldElement: HTMLElement,
  newElement: HTMLElement,
  oldRect: DOMRect,
  mountRect: DOMRect,
  spec: Extract<MotionTransition, { type: "record" | "panel" }>,
): Promise<void> {
  prepareExitOverlay(mount, oldElement, oldRect, mountRect);

  const layers = motionLayers(newElement);
  const vertical = spec.type === "record";
  const direction = vertical
    ? spec.direction === "up" ? -1 : 1
    : spec.direction === "in" ? 1 : -1;
  const exitDistance = vertical
    ? direction * (mountRect.height + 48)
    : direction * (mountRect.width + 48);
  const layerOffset = -direction * transitionMotion.layerOffset;
  const duration = transitionDuration(spec.velocity);

  gsap.set(newElement, { position: "relative", zIndex: 1 });
  if (layers.length > 0) {
    gsap.set(layers, {
      x: vertical ? 0 : layerOffset * 0.5,
      y: vertical ? layerOffset : 0,
      scale: 0.995,
      transformOrigin: "50% 50%",
      willChange: "transform",
    });
  }

  const timeline = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });
  timeline.to(
    oldElement,
    {
      x: vertical ? 0 : exitDistance,
      y: vertical ? exitDistance : 0,
      scale: 0.99,
      duration,
      ease: motionEases.direct,
    },
    0,
  );

  if (layers.length > 0) {
    timeline.to(
      layers,
      {
        x: 0,
        y: 0,
        scale: 1,
        duration: motionDurations.settle,
        ease: motionEases.settle,
        stagger: 0.025,
      },
      Math.min(0.08, duration * 0.2),
    );
  }

  timeline.play();
  return trackTransition(timeline, mount, () => {
    oldElement.remove();
    clearInlineMotion(newElement);
    clearMany(layers);
  });
}

/** Apply a state mutation synchronously and animate only its semantic change. */
export function commit(
  update: () => void,
  spec: MotionTransition,
  container?: HTMLElement,
): Promise<void> {
  interruptActiveTransition();

  const mount = container ?? document.getElementById("app");
  if (mount === null) {
    update();
    return Promise.resolve();
  }

  const oldElement = mount.firstElementChild as HTMLElement | null;
  const oldRect = oldElement?.getBoundingClientRect();
  const mountRect = mount.getBoundingClientRect();
  const shouldFlip = spec.type === "expand" || spec.type === "grid";
  const oldShared = oldElement === null ? [] : sharedElements(oldElement);
  const oldSharedIds = sharedElementIds(oldShared);

  if (oldElement !== null) gsap.killTweensOf(oldElement);
  const flipState = shouldFlip && oldShared.length > 0
    ? Flip.getState(oldShared, { props: SHARED_FLIP_PROPS })
    : null;

  update();

  const newElement = mount.firstElementChild as HTMLElement | null;
  if (prefersReducedMotion() || newElement === null || oldElement === newElement) {
    return Promise.resolve();
  }

  if (spec.type === "expand" || spec.type === "grid") {
    return flipState === null
      ? animateLocalChange(mount, newElement)
      : animateSharedLayout(
          mount,
          newElement,
          flipState,
          oldSharedIds,
          spec.type === "grid",
        );
  }

  if (spec.type === "fade") {
    return animateLocalChange(mount, newElement);
  }

  if (oldElement === null || oldRect === undefined) return Promise.resolve();
  return animateGestureCommit(
    mount,
    oldElement,
    newElement,
    oldRect,
    mountRect,
    spec,
  );
}

export function animateInitialView(element: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const layers = motionLayers(element);
  if (layers.length === 0) return;

  gsap.fromTo(
    layers,
    { y: 10, scale: 0.996 },
    {
      y: 0,
      scale: 1,
      duration: motionDurations.settle,
      ease: motionEases.settle,
      stagger: 0.035,
      clearProps: "transform",
    },
  );
}

export function beginDirectManipulation(element: HTMLElement): void {
  gsap.killTweensOf(element);
  gsap.set(element, { willChange: "transform", transformOrigin: "50% 50%" });
}

export function updateDragFeedback(
  element: HTMLElement,
  x: number,
  y: number,
): void {
  gsap.set(element, { x, y, scale: 1, force3D: true });
}

export function beginListSwipeIndicator(element: HTMLElement): void {
  const reducedMotion = prefersReducedMotion();
  gsap.killTweensOf(element);
  gsap.set(element, {
    autoAlpha: 0,
    x: reducedMotion ? 0 : 28,
    scale: reducedMotion ? 1 : 0.96,
    transformOrigin: "100% 50%",
    willChange: "transform,opacity",
  });
}

export function updateListSwipeIndicator(
  element: HTMLElement,
  rawProgress: number,
): void {
  const progress = gsap.utils.clamp(0, 1, rawProgress);
  const reducedMotion = prefersReducedMotion();
  gsap.set(element, {
    autoAlpha: progress,
    x: reducedMotion ? 0 : 28 * (1 - progress),
    scale: reducedMotion ? 1 : 0.96 + progress * 0.04,
    force3D: !reducedMotion,
  });
}

export function dismissListSwipeIndicator(element: HTMLElement): void {
  const reducedMotion = prefersReducedMotion();
  gsap.to(element, {
    autoAlpha: 0,
    x: reducedMotion ? 0 : 28,
    scale: reducedMotion ? 1 : 0.96,
    duration: reducedMotion ? 0 : motionDurations.micro,
    ease: motionEases.state,
    overwrite: true,
    onComplete: () => clearListSwipeIndicator(element),
  });
}

export function springBack(element: HTMLElement): void {
  gsap.to(element, {
    x: 0,
    y: 0,
    scale: 1,
    duration: motionDurations.settle,
    ease: motionEases.settle,
    overwrite: true,
    onComplete: () => clearInlineMotion(element),
  });
}

export function pressSignal(element: HTMLElement): void {
  gsap.to(element, {
    scale: transitionMotion.pressScale,
    duration: motionDurations.micro,
    ease: motionEases.press,
    overwrite: "auto",
  });
}

export function releasePress(element: HTMLElement): void {
  gsap.to(element, {
    scale: 1,
    duration: motionDurations.local,
    ease: motionEases.settle,
    overwrite: "auto",
    onComplete: () => element.style.removeProperty("will-change"),
  });
}

export function rubberBand(offset: number, limit = transitionMotion.edgeLimit): number {
  const direction = Math.sign(offset);
  const magnitude = Math.abs(offset);
  return direction * limit * (1 - Math.exp(-magnitude / limit));
}

export function animateRowDelete(element: HTMLElement, onComplete: () => void): void {
  gsap.to(element, {
    xPercent: -115,
    autoAlpha: 0,
    duration: motionDurations.local,
    ease: motionEases.direct,
    overwrite: true,
    onComplete,
  });
}

export function celebrate(element: HTMLElement): void {
  if (prefersReducedMotion()) return;
  gsap.killTweensOf(element);
  gsap.fromTo(
    element,
    { scale: 0.97, transformOrigin: "left bottom" },
    {
      scale: 1,
      duration: motionDurations.celebration,
      ease: motionEases.celebration,
      clearProps: "transform",
    },
  );
}

export function disposeMotion(): void {
  interruptActiveTransition();
}
