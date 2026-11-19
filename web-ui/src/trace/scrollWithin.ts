/**
 * Centre `el` inside its nearest scrollable ancestor without moving the page.
 *
 * `Element.scrollIntoView` scrolls every scrollable ancestor, the window included, so
 * highlighting a code line in a side panel used to jump the whole page away from the
 * row the user had just clicked. Only an inner box whose content overflows is
 * scrolled here; when there is none, nothing moves.
 */
export function scrollWithinNearestBox(el: Element | null | undefined): void {
  if (!el) return;
  let box = el.parentElement;
  while (box && box !== document.body && box !== document.documentElement) {
    const overflowY = getComputedStyle(box).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight + 1) break;
    box = box.parentElement;
  }
  if (!box || box === document.body || box === document.documentElement) return;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const target = box.scrollTop + (r.top - b.top) - (b.height - r.height) / 2;
  const clamped = Math.max(0, Math.min(target, box.scrollHeight - box.clientHeight));
  if (Math.abs(box.scrollTop - clamped) > 1) box.scrollTop = clamped;
}
