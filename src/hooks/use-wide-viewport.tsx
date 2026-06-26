import * as React from "react";

// The lease workbench shows the side-by-side PDF / form split only when the
// viewport is wide enough for two readable columns. Below this it collapses to
// a single full-width column (the source PDF stays reachable via the Documents
// tab). 1024px == Tailwind's `lg`. Initialized synchronously from the current
// width so the first paint already matches the viewport — no split→stack flash.
const WIDE_VIEWPORT_MIN = 1024;

export function useIsWideViewport() {
  const [isWide, setIsWide] = React.useState<boolean>(() =>
    typeof window === "undefined" ? true : window.innerWidth >= WIDE_VIEWPORT_MIN
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${WIDE_VIEWPORT_MIN}px)`);
    const onChange = () => setIsWide(window.innerWidth >= WIDE_VIEWPORT_MIN);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isWide;
}
