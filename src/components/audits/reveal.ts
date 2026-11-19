/**
 * Scrolls an element into view with the least movement, in every scrolling
 * ancestor, and without animation when the viewer asks for reduced motion.
 * Used when a click opens something that can land off screen (the journal
 * record a citation points at). Call it from an effect or an event handler.
 */
export function reveal(el: HTMLElement | null): void {
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduce ? "auto" : "smooth" });
}
