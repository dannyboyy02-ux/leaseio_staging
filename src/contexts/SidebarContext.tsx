import {
  createContext,
  useCallback,
  useContext,
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
