/**
 * A page's bar: its name on the left, its filters on the right. In the
 * sidebar shell it is drawn in the shell's own bar, above the page; in the
 * top-nav shell, where there is no such bar, it heads the page.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface BarSlot {
  /** Where a page's bar is drawn. Null until the shell has mounted it. */
  readonly element: HTMLElement | null;
  /** Says a page draws the bar itself, until the returned function is called. */
  readonly claim: () => () => void;
}

const BarContext = createContext<BarSlot | null>(null);

/** For the shell: the slot's context, where to mount it, and whether a page has taken it. */
export function useBarSlot(): {
  readonly provider: (children: ReactNode) => ReactNode;
  readonly mount: (element: HTMLElement | null) => void;
  readonly claimed: boolean;
} {
  const [element, mount] = useState<HTMLElement | null>(null);
  const [claims, setClaims] = useState(0);
  const slot = useMemo<BarSlot>(
    () => ({
      element,
      claim: () => {
        setClaims((count) => count + 1);
        return () => setClaims((count) => count - 1);
      },
    }),
    [element],
  );
  return {
    provider: (children) => <BarContext.Provider value={slot}>{children}</BarContext.Provider>,
    mount,
    claimed: claims > 0,
  };
}

export function BarTitle({ children }: { children: ReactNode }) {
  return <h1 className="min-w-0 truncate text-sm font-medium text-on-surface">{children}</h1>;
}

/**
 * Draws a page's own bar in the shell's, whatever it holds. Nothing outside
 * the sidebar shell: a page that wants a heading there uses `TopBar`.
 */
export function BarPortal({ children }: { children: ReactNode }) {
  const slot = useContext(BarContext);
  const claim = slot?.claim;
  useEffect(() => claim?.(), [claim]);
  if (slot === null || slot.element === null) return null;
  return createPortal(children, slot.element);
}

export function TopBar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  const slot = useContext(BarContext);
  const bar = (
    <>
      <BarTitle>{title}</BarTitle>
      <div className="flex-1" />
      {actions !== undefined ? <div className="flex items-center gap-3">{actions}</div> : null}
    </>
  );
  if (slot === null) {
    return <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 pt-5">{bar}</div>;
  }
  return <BarPortal>{bar}</BarPortal>;
}
