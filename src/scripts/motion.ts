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
  | { type: "modal"; direction: "in" | "out"; velocity?: number }
  | { type: "expand"; direction: "in" | "out" }
  | { type: "grid"; direction: "in" | "out" }
  | { type: "fade" };

interface ActiveTransition {
  animation: gsap.core.Animation;
  cleanup: () => void;
}

interface ActiveCelebration {
  animation: gsap.core.Animation;
  cleanup: () => void;
}

type CapturedFlipState = ReturnType<typeof Flip.getState>;

interface ModalTitleStyle {
  color: string;
  boxSizing: string;
  fontFamily: string;
  fontSize: string;
  fontStyle: string;
  fontWeight: string;
  letterSpacing: string;
  lineHeight: string;
  textAlign: string;
  textTransform: string;
  whiteSpace: string;
}

interface ModalTitleSnapshot {
  element: HTMLElement;
  id: string;
  rect: DOMRect;
  style: ModalTitleStyle;
}

interface ModalTitleHandoff {
  element: HTMLElement;
  destination: HTMLElement;
  from: DOMRect;
  to: DOMRect;
  destinationColor: string;
}

interface ModalExitSnapshot {
  element: HTMLElement;
  rect: DOMRect;
  title: ModalTitleSnapshot | null;
}

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

const MODAL_FLIP_PROPS = "";
const MODAL_TITLE_STYLE_START = 0.5;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const PERSONAL_BEST_CONFETTI = [
  { x: -76, y: -58, rotation: -110 },
  { x: -54, y: -88, rotation: -72 },
  { x: -28, y: -70, rotation: -38 },
  { x: -8, y: -96, rotation: -12 },
  { x: 18, y: -82, rotation: 24 },
  { x: 46, y: -94, rotation: 58 },
  { x: 72, y: -66, rotation: 96 },
  { x: 84, y: -30, rotation: 126 },
  { x: 62, y: -18, rotation: 148 },
  { x: -68, y: -20, rotation: -142 },
  { x: -42, y: -46, rotation: -86 },
  { x: 38, y: -48, rotation: 74 },
] as const;
let activeTransition: ActiveTransition | null = null;
let activeCelebration: ActiveCelebration | null = null;

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
    clearProps: "transform,opacity,visibility,willChange,zIndex,position,top,left,width,height,margin,pointerEvents,backgroundColor,borderRadius,borderTopLeftRadius,borderTopRightRadius,borderBottomRightRadius,borderBottomLeftRadius,boxShadow,overflow,filter,transformOrigin",
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

function interruptCelebration(): void {
  if (activeCelebration === null) return;
  const previous = activeCelebration;
  activeCelebration = null;
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

function editorModal(root: HTMLElement): HTMLElement | null {
  return root.matches(".editor-modal")
    ? root
    : root.querySelector<HTMLElement>(".editor-modal");
}

function modalTitleStyle(element: HTMLElement): ModalTitleStyle {
  const style = getComputedStyle(element);
  return {
    color: style.color,
    boxSizing: style.boxSizing,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    textAlign: style.textAlign,
    textTransform: style.textTransform,
    whiteSpace: style.whiteSpace,
  };
}

function captureModalTitleSnapshots(root: HTMLElement): Map<string, ModalTitleSnapshot> {
  const snapshots = new Map<string, ModalTitleSnapshot>();
  for (const element of root.querySelectorAll<HTMLElement>("[data-modal-title-id]")) {
    const id = element.dataset.modalTitleId;
    const rect = element.getBoundingClientRect();
    if (id === undefined || id === "" || rect.width <= 0 || rect.height <= 0) continue;

    snapshots.set(id, {
      element,
      id,
      rect,
      style: modalTitleStyle(element),
    });
  }
  return snapshots;
}

function captureModalTitleSnapshot(root: HTMLElement): ModalTitleSnapshot | null {
  for (const snapshot of captureModalTitleSnapshots(root).values()) return snapshot;
  return null;
}

function captureModalExitSnapshot(root: HTMLElement): ModalExitSnapshot | null {
  const element = editorModal(root);
  if (element === null) return null;
  return {
    element,
    rect: element.getBoundingClientRect(),
    title: captureModalTitleSnapshot(element),
  };
}

function prepareModalTitleHandoff(
  mount: HTMLElement,
  root: HTMLElement,
  snapshot: ModalTitleSnapshot,
  mountRect: DOMRect,
): ModalTitleHandoff | null {
  const destination = [...root.querySelectorAll<HTMLElement>("[data-modal-title-id]")]
    .find((element) => element.dataset.modalTitleId === snapshot.id);
  const destinationRect = destination?.getBoundingClientRect();
  if (
    destination === undefined ||
    destinationRect === undefined ||
    destinationRect.width <= 0 ||
    destinationRect.height <= 0
  ) {
    return null;
  }

  const destinationColor = getComputedStyle(destination).color;
  snapshot.element.remove();
  snapshot.element.setAttribute("aria-hidden", "true");
  snapshot.element.inert = true;
  mount.append(snapshot.element);
  gsap.set(snapshot.element, {
    position: "absolute",
    top: snapshot.rect.top - mountRect.top,
    left: snapshot.rect.left - mountRect.left,
    width: snapshot.rect.width,
    height: snapshot.rect.height,
    maxWidth: "none",
    maxHeight: "none",
    margin: 0,
    padding: 0,
    display: "block",
    boxSizing: snapshot.style.boxSizing,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    transformOrigin: "50% 50%",
    color: snapshot.style.color,
    fontFamily: snapshot.style.fontFamily,
    fontSize: snapshot.style.fontSize,
    fontStyle: snapshot.style.fontStyle,
    fontWeight: snapshot.style.fontWeight,
    letterSpacing: snapshot.style.letterSpacing,
    lineHeight: snapshot.style.lineHeight,
    textAlign: snapshot.style.textAlign,
    textTransform: snapshot.style.textTransform,
    whiteSpace: "nowrap",
    pointerEvents: "none",
    willChange: "transform,opacity",
    zIndex: 4,
  });
  gsap.set(destination, {
    autoAlpha: 0,
    position: "relative",
    willChange: "opacity",
    zIndex: 4,
  });

  return {
    element: snapshot.element,
    destination,
    from: snapshot.rect,
    to: destinationRect,
    destinationColor,
  };
}

function prepareModalTitleHandoffFromSnapshots(
  mount: HTMLElement,
  root: HTMLElement,
  snapshots: ReadonlyMap<string, ModalTitleSnapshot>,
  mountRect: DOMRect,
): ModalTitleHandoff | null {
  for (const destination of root.querySelectorAll<HTMLElement>("[data-modal-title-id]")) {
    const id = destination.dataset.modalTitleId;
    if (id === undefined) continue;
    const snapshot = snapshots.get(id);
    if (snapshot !== undefined) {
      return prepareModalTitleHandoff(mount, root, snapshot, mountRect);
    }
  }
  return null;
}

function animateModalTitleHandoff(
  timeline: gsap.core.Timeline,
  handoff: ModalTitleHandoff,
  mountRect: DOMRect,
): void {
  const fromLeft = handoff.from.left - mountRect.left;
  const fromTop = handoff.from.top - mountRect.top;
  const fromCenterX = fromLeft + handoff.from.width / 2;
  const fromCenterY = fromTop + handoff.from.height / 2;
  const toLeft = handoff.to.left - mountRect.left;
  const toTop = handoff.to.top - mountRect.top;
  const toCenterX = toLeft + handoff.to.width / 2;
  const toCenterY = toTop + handoff.to.height / 2;

  timeline.to(
    handoff.element,
    {
      x: toCenterX - fromCenterX,
      y: toCenterY - fromCenterY,
      scaleX: handoff.to.width / handoff.from.width,
      scaleY: handoff.to.height / handoff.from.height,
      duration: motionDurations.sharedLayout,
      ease: motionEases.shared,
    },
    0,
  );
}

function animateModalTitleStyleHandoff(
  timeline: gsap.core.Timeline,
  handoff: ModalTitleHandoff,
): void {
  const start = motionDurations.sharedLayout * MODAL_TITLE_STYLE_START;
  const duration = motionDurations.local;
  timeline.to(
    handoff.element,
    {
      autoAlpha: 0,
      color: handoff.destinationColor,
      duration,
      ease: motionEases.state,
    },
    start,
  );
  timeline.to(
    handoff.destination,
    {
      autoAlpha: 1,
      duration,
      ease: motionEases.state,
    },
    start,
  );
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

function animateModalExit(
  mount: HTMLElement,
  newElement: HTMLElement,
  snapshot: ModalExitSnapshot,
  destinationTarget: HTMLElement,
  mountRect: DOMRect,
): Promise<void> {
  const oldModal = snapshot.element;
  const oldRect = snapshot.rect;
  const targetRect = destinationTarget.getBoundingClientRect();
  if (oldRect.width <= 0 || oldRect.height <= 0 || targetRect.width <= 0 || targetRect.height <= 0) {
    return animateLocalChange(mount, newElement);
  }

  const oldLeft = oldRect.left - mountRect.left;
  const oldTop = oldRect.top - mountRect.top;
  const oldCenterX = oldLeft + oldRect.width / 2;
  const oldCenterY = oldTop + oldRect.height / 2;
  const targetLeft = targetRect.left - mountRect.left;
  const targetTop = targetRect.top - mountRect.top;
  const targetCenterX = targetLeft + targetRect.width / 2;
  const targetCenterY = targetTop + targetRect.height / 2;
  const contentTargets = [...oldModal.querySelectorAll<HTMLElement>("[data-modal-reveal]")];
  const wasInert = newElement.inert;
  const shield = createRevealShield(mount);

  removeDuplicateIds(oldModal);
  oldModal.inert = true;
  oldModal.setAttribute("aria-hidden", "true");
  oldModal.dataset.motionExit = "true";
  newElement.inert = true;
  mount.append(oldModal);

  gsap.set(oldModal, {
    position: "absolute",
    top: oldTop,
    left: oldLeft,
    width: oldRect.width,
    height: oldRect.height,
    maxWidth: "none",
    maxHeight: "none",
    margin: 0,
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    transformOrigin: "50% 50%",
    overflow: "hidden",
    pointerEvents: "none",
    willChange: "transform,opacity",
    zIndex: 3,
  });

  const titleHandoff = snapshot.title === null
    ? null
    : prepareModalTitleHandoff(mount, newElement, snapshot.title, mountRect);

  if (contentTargets.length > 0) {
    gsap.set(contentTargets, {
      willChange: "opacity",
    });
  }

  const timeline = gsap.timeline({ paused: true, defaults: { overwrite: "auto" } });
  if (contentTargets.length > 0) {
    timeline.to(
      contentTargets,
      {
        autoAlpha: 0,
        duration: motionDurations.local,
        ease: motionEases.state,
        stagger: 0.025,
      },
      0,
    );
  }

  timeline.to(
    oldModal,
    {
      x: targetCenterX - oldCenterX,
      y: targetCenterY - oldCenterY,
      scaleX: targetRect.width / oldRect.width,
      scaleY: targetRect.height / oldRect.height,
      duration: motionDurations.sharedLayout,
      ease: motionEases.shared,
    },
    0,
  );

  if (titleHandoff !== null) {
    animateModalTitleHandoff(timeline, titleHandoff, mountRect);
    animateModalTitleStyleHandoff(timeline, titleHandoff);
  }

  const handoffTargets = titleHandoff === null
    ? [oldModal, shield]
    : [oldModal, titleHandoff.element, shield];
  timeline.to(
    handoffTargets,
    {
      autoAlpha: 0,
      duration: motionDurations.micro,
      ease: motionEases.state,
    },
    ">",
  );
  if (titleHandoff !== null) {
    timeline.set(titleHandoff.destination, { autoAlpha: 1 }, ">");
  }

  timeline.play();
  return trackTransition(timeline, mount, () => {
    oldModal.remove();
    titleHandoff?.element.remove();
    shield.remove();
    newElement.inert = wasInert;
    clearInlineMotion(oldModal);
    if (titleHandoff !== null) {
      clearInlineMotion(titleHandoff.element);
      clearInlineMotion(titleHandoff.destination);
    }
    clearMany(contentTargets);
  });
}

function animateSharedLayout(
  mount: HTMLElement,
  newElement: HTMLElement,
  state: CapturedFlipState,
  previousSharedIds: ReadonlySet<string>,
  absoluteTargets: boolean,
  flipProps: string,
  scaleTargets: boolean,
  mountRect: DOMRect,
  modalTitleSnapshots: ReadonlyMap<string, ModalTitleSnapshot> | null,
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
  const titleHandoff = modalTitleSnapshots === null
    ? null
    : prepareModalTitleHandoffFromSnapshots(
        mount,
        newElement,
        modalTitleSnapshots,
        mountRect,
      );
  const restoreOverflow = exposeSharedOverflow(sharedTargets, newElement);
  const revealTargets = scaleTargets
    ? [...newElement.querySelectorAll<HTMLElement>("[data-modal-reveal]")]
    : [];
  newElement.inert = true;
  gsap.set(sharedTargets, {
    position: "relative",
    zIndex: 3,
    willChange: "transform",
  });
  if (revealTargets.length > 0) {
    gsap.set(revealTargets, {
      autoAlpha: 0,
      y: 8,
      willChange: "transform,opacity",
    });
  }

  const timeline = Flip.from(state, {
    targets: sharedTargets,
    // Grid transitions swap differently styled text nodes. Keeping those
    // targets in flow lets source typography reflow the destination row before
    // Flip's first frame. Modal surfaces use absolute positioning so the
    // surface can grow from its trigger without disturbing the destination
    // layout; their secondary content reveals after the shared surface settles.
    absolute: absoluteTargets,
    nested: true,
    scale: scaleTargets,
    fade: false,
    props: flipProps,
    duration: motionDurations.sharedLayout,
    ease: motionEases.shared,
    paused: true,
  });

  if (titleHandoff !== null) {
    animateModalTitleHandoff(timeline, titleHandoff, mountRect);
    animateModalTitleStyleHandoff(timeline, titleHandoff);
  }

  if (revealTargets.length > 0) {
    timeline.to(
      revealTargets,
      {
        autoAlpha: 1,
        y: 0,
        duration: motionDurations.local,
        ease: motionEases.settle,
        stagger: 0.025,
      },
      Math.max(0, motionDurations.sharedLayout - motionDurations.local * 0.65),
    );
  }

  const handoffTargets = titleHandoff === null
    ? [shield]
    : [shield, titleHandoff.element];
  timeline.to(
    handoffTargets,
    {
      autoAlpha: 0,
      duration: motionDurations.local,
      ease: motionEases.state,
    },
    ">",
  );
  if (titleHandoff !== null) {
    timeline.set(titleHandoff.destination, { autoAlpha: 1 }, ">");
  }

  timeline.play();
  return trackTransition(timeline, mount, () => {
    shield.remove();
    restoreOverflow();
    newElement.inert = wasInert;
    clearMany(sharedTargets);
    clearMany(revealTargets);
    if (titleHandoff !== null) {
      titleHandoff.element.remove();
      clearInlineMotion(titleHandoff.element);
      clearInlineMotion(titleHandoff.destination);
    }
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
  interruptCelebration();

  const mount = container ?? document.getElementById("app");
  if (mount === null) {
    update();
    return Promise.resolve();
  }

  const oldElement = mount.firstElementChild as HTMLElement | null;
  const oldRect = oldElement?.getBoundingClientRect();
  const mountRect = mount.getBoundingClientRect();
  const shouldFlip = spec.type === "expand" || spec.type === "grid" || spec.type === "modal";
  const flipProps = spec.type === "modal" ? MODAL_FLIP_PROPS : SHARED_FLIP_PROPS;
  const oldShared = oldElement === null ? [] : sharedElements(oldElement);
  const oldSharedIds = sharedElementIds(oldShared);
  const modalExitSnapshot = spec.type === "modal" && spec.direction === "out" && oldElement !== null
    ? captureModalExitSnapshot(oldElement)
    : null;
  const modalEntryTitleSnapshots = spec.type === "modal" && spec.direction === "in" && oldElement !== null
    ? captureModalTitleSnapshots(oldElement)
    : null;

  if (oldElement !== null) gsap.killTweensOf(oldElement);
  const flipState = shouldFlip && oldShared.length > 0
    ? Flip.getState(oldShared, { props: flipProps })
    : null;

  update();

  const newElement = mount.firstElementChild as HTMLElement | null;
  if (prefersReducedMotion() || newElement === null || oldElement === newElement) {
    return Promise.resolve();
  }

  if (spec.type === "expand" || spec.type === "grid" || spec.type === "modal") {
    if (flipState === null) return animateLocalChange(mount, newElement);

    if (spec.type === "modal" && spec.direction === "out" && modalExitSnapshot !== null) {
      const destinationTarget = sharedElements(newElement).find((element) => {
        const id = element.dataset.flipId;
        return id !== undefined && oldSharedIds.has(id);
      });
      if (destinationTarget !== undefined) {
        return animateModalExit(
          mount,
          newElement,
          modalExitSnapshot,
          destinationTarget,
          mountRect,
        );
      }
    }

    return animateSharedLayout(
      mount,
      newElement,
      flipState,
      oldSharedIds,
      spec.type === "grid" || spec.type === "modal",
      flipProps,
      spec.type === "modal",
      mountRect,
      modalEntryTitleSnapshots,
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

export function resetDirectManipulation(element: HTMLElement): void {
  gsap.killTweensOf(element);
  clearInlineMotion(element);
}

export function transitionUtilityStep(
  outgoing: HTMLElement,
  incoming: HTMLElement,
  direction: "left" | "right",
): Promise<void> {
  gsap.killTweensOf([outgoing, incoming]);
  const offset = direction === "left" ? 20 : -20;
  outgoing.inert = true;
  incoming.inert = true;
  incoming.hidden = false;

  if (prefersReducedMotion()) {
    outgoing.hidden = true;
    outgoing.inert = false;
    incoming.inert = false;
    clearInlineMotion(outgoing);
    clearInlineMotion(incoming);
    return Promise.resolve();
  }

  gsap.set(incoming, { autoAlpha: 0, x: offset, force3D: true });
  return new Promise((resolve) => {
    const timeline = gsap.timeline({
      defaults: { duration: motionDurations.local, ease: motionEases.state },
      onComplete: () => {
        outgoing.hidden = true;
        outgoing.inert = false;
        incoming.inert = false;
        clearInlineMotion(outgoing);
        clearInlineMotion(incoming);
        resolve();
      },
    });
    timeline
      .to(outgoing, { autoAlpha: 0, x: -offset }, 0)
      .to(incoming, { autoAlpha: 1, x: 0 }, 0.06);
  });
}

export function showTransientAction(element: HTMLElement): void {
  gsap.killTweensOf(element);
  element.hidden = false;
  if (prefersReducedMotion()) {
    clearInlineMotion(element);
    return;
  }
  gsap.fromTo(
    element,
    { autoAlpha: 0, y: 8 },
    {
      autoAlpha: 1,
      y: 0,
      duration: motionDurations.local,
      ease: motionEases.settle,
      overwrite: true,
      onComplete: () => clearInlineMotion(element),
    },
  );
}

export function hideTransientAction(element: HTMLElement): void {
  gsap.killTweensOf(element);
  if (element.hidden) return;
  const finish = (): void => {
    element.hidden = true;
    clearInlineMotion(element);
  };
  if (prefersReducedMotion()) {
    finish();
    return;
  }
  gsap.to(element, {
    autoAlpha: 0,
    y: 8,
    duration: motionDurations.micro,
    ease: "power2.in",
    overwrite: true,
    onComplete: finish,
  });
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
  interruptCelebration();

  const host = element.closest<HTMLElement>("[data-focus-card]");
  if (host === null) return;
  const hostRect = host.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const elementX = elementRect.left - hostRect.left;
  const elementY = elementRect.top - hostRect.top;

  const celebration = document.createElement("span");
  celebration.className = "personal-best-celebration";
  celebration.dataset.personalBestCelebration = "true";
  celebration.style.setProperty(
    "--personal-best-label-x",
    `${Math.max(0, Math.min(elementX, hostRect.width - 84))}px`,
  );
  celebration.style.setProperty(
    "--personal-best-label-y",
    `${Math.max(0, elementY - 22)}px`,
  );
  celebration.style.setProperty(
    "--personal-best-origin-x",
    `${Math.max(16, Math.min(elementX + elementRect.width / 2, hostRect.width - 16))}px`,
  );
  celebration.style.setProperty(
    "--personal-best-origin-y",
    `${Math.max(16, Math.min(elementY + elementRect.height * 0.36, hostRect.height - 16))}px`,
  );

  const announcement = document.createElement("span");
  announcement.className = "personal-best-celebration__announcement";
  announcement.setAttribute("role", "status");
  announcement.setAttribute("aria-live", "polite");
  announcement.setAttribute("aria-atomic", "true");
  announcement.textContent = "New personal best";

  const label = document.createElement("span");
  label.className = "personal-best-celebration__label";
  label.setAttribute("aria-hidden", "true");
  label.textContent = "NEW BEST";

  const reducedMotion = prefersReducedMotion();
  const confetti = document.createElement("span");
  confetti.className = "personal-best-celebration__confetti";
  confetti.setAttribute("aria-hidden", "true");
  const pieces = (reducedMotion ? [] : PERSONAL_BEST_CONFETTI).map(() => {
    const piece = document.createElement("span");
    piece.className = "personal-best-celebration__piece";
    confetti.append(piece);
    return piece;
  });

  celebration.append(announcement, label);
  if (!reducedMotion) celebration.append(confetti);
  gsap.set(label, {
    autoAlpha: reducedMotion ? 1 : 0,
    y: reducedMotion ? 0 : 6,
  });
  if (pieces.length > 0) {
    gsap.set(pieces, {
      autoAlpha: 1,
      x: 0,
      y: 0,
      rotation: 0,
      scale: 0.82,
      transformOrigin: "50% 50%",
      force3D: true,
    });
  }
  host.append(celebration);

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInlineMotion(element);
    celebration.remove();
  };
  const timeline = gsap.timeline({
    paused: true,
    onComplete: () => {
      if (activeCelebration?.animation === timeline) activeCelebration = null;
      cleanup();
    },
  });

  if (reducedMotion) {
    timeline.set(label, { autoAlpha: 0 }, 1.5);
  } else {
    timeline
      .addLabel("burst", 0)
      .fromTo(
        element,
        { scale: 0.97, transformOrigin: "left bottom" },
        {
          scale: 1,
          duration: motionDurations.celebration,
          ease: motionEases.celebration,
          clearProps: "transform",
        },
        "burst",
      )
      .to(
        label,
        {
          autoAlpha: 1,
          y: 0,
          duration: motionDurations.local,
          ease: motionEases.state,
        },
        "burst",
      )
      .to(
        pieces,
        {
          x: (index) => PERSONAL_BEST_CONFETTI[index]?.x ?? 0,
          y: (index) => PERSONAL_BEST_CONFETTI[index]?.y ?? 0,
          rotation: (index) => PERSONAL_BEST_CONFETTI[index]?.rotation ?? 0,
          scale: 1,
          duration: 0.32,
          ease: "power3.out",
        },
        "burst",
      )
      .to(
        pieces,
        {
          x: (index) => (PERSONAL_BEST_CONFETTI[index]?.x ?? 0) * 1.08,
          y: (index) => (PERSONAL_BEST_CONFETTI[index]?.y ?? 0) + 22,
          rotation: (index) => {
            const vector = PERSONAL_BEST_CONFETTI[index];
            if (vector === undefined) return 0;
            return vector.rotation + Math.sign(vector.x) * 28;
          },
          autoAlpha: 0,
          duration: 0.28,
          ease: "power1.in",
        },
        "burst+=0.32",
      )
      .to(
        label,
        {
          autoAlpha: 0,
          y: -4,
          duration: motionDurations.micro,
          ease: "power2.in",
        },
        1.38,
      );
  }

  activeCelebration = { animation: timeline, cleanup };
  timeline.play();
}

export function disposeMotion(): void {
  interruptActiveTransition();
  interruptCelebration();
}
