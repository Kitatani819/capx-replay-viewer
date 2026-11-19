/**
 * Windowed list with variable row heights, for timelines with thousands of
 * events (docs/trace-format.md 9.3, left pane). Short lists use the rows' own
 * heights. In long lists, two spacers stand in for offscreen rows using
 * measured heights where known and estimates elsewhere. One ResizeObserver
 * measures rows. Native scroll anchoring keeps the view steady when rows
 * above the viewport change height.
 *
 * Related: Timeline.tsx.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

interface VirtualListProps<T> {
  items: T[];
  itemKey: (item: T) => string;
  estimateHeight: (item: T) => number;
  /** Changes when disclosure/content invalidates a row's cached height. */
  measurementKey?: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Row for the next scroll request. A key change alone cancels any pending request. */
  scrollToKey: string | null;
  /** Change to request a scroll, including when selecting a different row. */
  scrollToken: number;
  overscanPx?: number;
  className?: string;
  empty?: ReactNode;
}

/** How long a scroll-to-row request keeps correcting for rows that change height. */
const SCROLL_SETTLE_MS = 1500;
const MAX_STATIC_ROWS = 64;

function lowerBound(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function VirtualList<T>({
  items,
  itemKey,
  estimateHeight,
  measurementKey,
  renderItem,
  scrollToKey,
  scrollToken,
  overscanPx = 600,
  className = '',
  empty,
}: VirtualListProps<T>) {
  const windowed = items.length > MAX_STATIC_ROWS;
  const containerRef = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, { height: number; measurement: string | undefined }>());
  const [version, setVersion] = useState(0);
  const [view, setView] = useState({ top: 0, height: 800, scrollable: false });
  const rafRef = useRef<number | null>(null);
  const bumpRef = useRef<number | null>(null);

  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const measurements = useMemo(() => items.map(item => measurementKey?.(item)), [items, measurementKey]);
  const offsets = useMemo(() => {
    const arr = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i += 1) {
      const cached = heights.current.get(keys[i]);
      arr[i + 1] = arr[i] + (cached && cached.measurement === measurements[i] ? cached.height : estimateHeight(items[i]));
    }
    return arr;
    // `version` changes when measured heights change.
  }, [items, keys, measurements, estimateHeight, version]);

  const observer = useMemo(() => {
    if (typeof ResizeObserver === 'undefined') return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const key = (e.target as HTMLElement).dataset.vkey;
        if (!key) continue;
        const h = Math.round((e.target as HTMLElement).getBoundingClientRect().height);
        const measurement = (e.target as HTMLElement).dataset.vmeasurement;
        const cached = heights.current.get(key);
        if (h > 0 && (cached?.height !== h || cached.measurement !== measurement)) {
          heights.current.set(key, { height: h, measurement });
          changed = true;
        }
      }
      if (changed && bumpRef.current === null) {
        bumpRef.current = window.requestAnimationFrame(() => {
          bumpRef.current = null;
          setVersion((v) => v + 1);
        });
      }
    });
  }, []);

  useEffect(
    () => () => {
      observer?.disconnect();
      if (bumpRef.current !== null) window.cancelAnimationFrame(bumpRef.current);
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      bumpRef.current = null;
      rafRef.current = null;
    },
    [observer],
  );

  const readView = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const height = el.clientHeight;
    const scrollable = el.scrollHeight > height;
    setView((v) => v.top === top && v.height === height && v.scrollable === scrollable ? v : { top, height, scrollable });
  }, []);

  useLayoutEffect(() => {
    readView();
  }, [readView, offsets]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => readView());
    ro.observe(el);
    return () => ro.disconnect();
  }, [readView]);

  const onScroll = () => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      readView();
    });
  };

  // Bring the requested row into view. Row heights settle after mount (the
  // ResizeObserver measures rows, thumbnails load and grow the cards), so the
  // request is checked against the row's real position after layout settles for
  // a frame, and dropped as soon as the user scrolls by hand. Never correct and
  // setView synchronously in every layout effect: mounting different virtual
  // rows/scroll anchoring can alternate positions and exhaust React's nested
  // update limit before ResizeObserver gets a chance to measure the new rows.
  // Declared before the effect below so both run in the same commit.
  const pending = useRef<{ key: string; until: number } | null>(null);
  const requestedToken = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    // A list click updates selection without requesting a scroll. In particular,
    // its newly expanded height must not prolong or restart an earlier request.
    if (requestedToken.current !== scrollToken) {
      pending.current = scrollToKey ? { key: scrollToKey, until: performance.now() + SCROLL_SETTLE_MS } : null;
    } else if (pending.current?.key !== scrollToKey) {
      pending.current = null;
    }
    requestedToken.current = scrollToken;
  }, [scrollToKey, scrollToken]);
  useLayoutEffect(() => {
    if (!pending.current) return;
    const frame = window.requestAnimationFrame(() => {
      const p = pending.current;
      const el = containerRef.current;
      if (!p || !el || el.clientHeight <= 0) return;
      const idx = keys.indexOf(p.key);
      if (idx < 0 || performance.now() > p.until) {
        pending.current = null;
        return;
      }
      const margin = Math.min(el.clientHeight * 0.3, 160);
      const row = el.querySelector<HTMLElement>(`[data-vkey="${CSS.escape(p.key)}"]`);
      let target: number;
      if (!row) {
        target = Math.max(0, offsets[idx] - margin);
      } else {
        const r = row.getBoundingClientRect();
        const c = el.getBoundingClientRect();
        // A short viewport must still be able to show the start of a tall card.
        const head = Math.min(48, c.height * 0.7);
        const visible = r.height <= c.height
          ? r.top >= c.top - 1 && r.bottom <= c.bottom + 1
          : r.top >= c.top - 1 && r.top <= c.bottom - head + 1;
        if (visible) return;
        target = Math.max(0, el.scrollTop + (r.top - c.top) - margin);
      }
      // Ignore subpixel rounding/scrollbar quantization instead of oscillating.
      if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
      readView();
    });
    return () => window.cancelAnimationFrame(frame);
  });
  const cancelPending = () => {
    pending.current = null;
  };

  const n = items.length;
  const total = offsets[n];
  const start = windowed ? Math.max(0, lowerBound(offsets, view.top - overscanPx) - 1) : 0;
  const end = windowed ? Math.min(n, lowerBound(offsets, view.top + view.height + overscanPx) + 1) : n;

  return (
    <div
      ref={containerRef}
      onScroll={windowed ? onScroll : undefined}
      onWheel={cancelPending}
      onTouchStart={cancelPending}
      onPointerDown={cancelPending}
      onKeyDown={cancelPending}
      role="region"
      aria-label="タイムラインのイベント"
      tabIndex={0}
      className={`overflow-y-auto ${className}`}
      style={{ overflowAnchor: 'auto', overscrollBehaviorY: view.scrollable ? 'contain' : 'auto' }}
    >
      {n === 0 && empty}
      {/* Spacers can span the viewport, but their fixed top is not a useful
          scroll anchor. Anchor on a real row as measured offsets change. */}
      {windowed && <div style={{ height: offsets[start], overflowAnchor: 'none' }} />}
      {items.slice(start, end).map((item, i) => {
        const key = keys[start + i];
        return (
          <MeasuredRow key={key} vkey={key} measurement={measurements[start + i]} observer={observer}>
            {renderItem(item)}
          </MeasuredRow>
        );
      })}
      {windowed && <div style={{ height: Math.max(0, total - offsets[end]), overflowAnchor: 'none' }} />}
    </div>
  );
}

function MeasuredRow({ vkey, measurement, observer, children }: { vkey: string; measurement: string | undefined; observer: ResizeObserver | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !observer) return;
    observer.observe(el);
    return () => observer.unobserve(el);
  }, [observer, measurement]);
  return (
    <div ref={ref} data-vkey={vkey} data-vmeasurement={measurement}>
      {children}
    </div>
  );
}
