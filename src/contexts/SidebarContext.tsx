import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_NAV_ORDER,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_NAV_ORDER_KEY,
  SIDEBAR_WIDTH_KEY,
  clampWidth,
  parseStoredNavOrder,
  parseStoredWidth,
  validateNavOrder,
} from '@/lib/sidebarPrefs';

// The viewport below which the sidebar stops being a fixed rail and becomes an
// off-canvas drawer (FS-1). Matches Tailwind's `md` breakpoint so viewport-keyed
// `md:` utilities and this logic agree. Module-local — only the query below uses it.
const SIDEBAR_MOBILE_MAX = 767;
const MOBILE_MEDIA_QUERY = `(max-width: ${SIDEBAR_MOBILE_MAX}px)`;

interface SidebarPrefs {
  /** Collapsed = icon-only rail (fixed width). */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Expanded width in px (ignored while collapsed). */
  width: number;
  /** Commit + persist a new expanded width (clamped). Use on resize end. */
  setWidth: (w: number) => void;
  /** Live, non-persisted width update (clamped). Use during a resize drag. */
  previewWidth: (w: number) => void;
  /** True while the user is actively dragging the resize handle. */
  resizing: boolean;
  setResizing: (v: boolean) => void;
  /** Persisted order of the standard nav items (stable keys). */
  navOrder: string[];
  setNavOrder: (order: string[]) => void;
  /** FS-1: true below the md breakpoint — the sidebar becomes an off-canvas drawer. */
  isMobile: boolean;
  /** FS-1: whether the mobile off-canvas drawer is open (no-op on desktop). */
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}

const SidebarContext = createContext<SidebarPrefs | null>(null);

// Synchronous reads so the very first paint matches persisted state.
function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}
function readWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
  try {
    return parseStoredWidth(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}
function readNavOrder(): string[] {
  if (typeof window === 'undefined') return [...DEFAULT_NAV_ORDER];
  try {
    return parseStoredNavOrder(window.localStorage.getItem(SIDEBAR_NAV_ORDER_KEY));
  } catch {
    return [...DEFAULT_NAV_ORDER];
  }
}
// Synchronous initial read so the very first paint already knows whether it's a
// mobile viewport (avoids a desktop-rail flash on a phone).
function readIsMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private-mode / quota — fall back to in-memory state only */
  }
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed);
  const [width, setWidthState] = useState<number>(readWidth);
  const [navOrder, setNavOrderState] = useState<string[]>(readNavOrder);
  const [resizing, setResizing] = useState(false);
  const [isMobile, setIsMobile] = useState<boolean>(readIsMobile);
  const [mobileOpen, setMobileOpen] = useState(false);

  // FS-1: track the md breakpoint. When we leave mobile, force the drawer shut
  // so it can't linger open behind the desktop rail.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
    const onChange = () => {
      setIsMobile(mql.matches);
      if (!mql.matches) setMobileOpen(false);
    };
    onChange();
    // addEventListener('change') is the modern API; Safari <14 used addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      persist(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  const setWidth = useCallback((w: number) => {
    const clamped = clampWidth(w);
    setWidthState(clamped);
    persist(SIDEBAR_WIDTH_KEY, String(clamped));
  }, []);

  const previewWidth = useCallback((w: number) => {
    setWidthState(clampWidth(w));
  }, []);

  const setNavOrder = useCallback((order: string[]) => {
    const valid = validateNavOrder(order);
    setNavOrderState(valid);
    persist(SIDEBAR_NAV_ORDER_KEY, JSON.stringify(valid));
  }, []);

  return (
    <SidebarContext.Provider
      value={{
        collapsed,
        toggleCollapsed,
        width,
        setWidth,
        previewWidth,
        resizing,
        setResizing,
        navOrder,
        setNavOrder,
        isMobile,
        mobileOpen,
        setMobileOpen,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarPrefs {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return ctx;
}
