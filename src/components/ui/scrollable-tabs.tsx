// Scrollable tab-strip wrapper — polish-pass 2026-07-17.
//
// Solves three quiet failures of a plain `<TabsList className="overflow-x-auto">`:
//   1. Clipped tabs announce themselves: an edge fade appears on whichever
//      side has more tabs hiding off-screen (previously "ASC 842" simply
//      didn't exist at moderate widths — absent even from the a11y tree's
//      visible set, with no cue to scroll).
//   2. The ACTIVE tab is always scrolled into view (selecting a tab via URL
//      or code no longer leaves its label off-screen while its content shows).
//   3. Activation reads as an underline, not shadcn's white-pill-on-white
//      (use UNDERLINE_TAB_TRIGGER on each TabsTrigger alongside this wrapper).
//
// The wrapper owns horizontal overflow so it never leaks to the page —
// the page body must never scroll sideways.

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/** Apply to TabsTrigger when the strip uses the underline pattern. */
export const UNDERLINE_TAB_TRIGGER =
  'rounded-none border-b-2 border-transparent data-[state=active]:border-primary ' +
  'data-[state=active]:bg-transparent data-[state=active]:shadow-none';

interface ScrollableTabStripProps {
  /** The current Tabs value — changes trigger scroll-active-into-view. */
  activeValue?: string;
  className?: string;
  children: React.ReactNode;
}

export function ScrollableTabStrip({ activeValue, className, children }: ScrollableTabStripProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setCanScrollLeft(el.scrollLeft > 1);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    active?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeValue]);

  return (
    <div className={cn('relative min-w-0', className)}>
      <div
        ref={scrollRef}
        className="overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {canScrollLeft && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent"
        />
      )}
      {canScrollRight && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent"
        />
      )}
    </div>
  );
}
