import { useCallback, useRef } from "react";
import { useGT } from "gt-react";

type GTFunction = ReturnType<typeof useGT>;

/**
 * `useGT()` with a referentially stable identity.
 *
 * gt-react's `useGT()` returns a **new function on every render**: its
 * `useCallback` depends on the tracked translation resolver, which in turn
 * depends on `useHandleMissingTranslation()`, and outside production builds
 * that hook allocates a fresh closure (over a fresh `Map`) each render. So the
 * whole chain re-creates itself every time, and `gt` is never `Object.is`-equal
 * to the previous render's `gt`.
 *
 * That is harmless in JSX, but corrosive in a dependency array. A `useMemo`
 * keyed on `[gt]` rebuilds every render; anything derived from it rebuilds too;
 * and once such a value reaches a `useEffect` that fetches and sets state, the
 * effect re-fires on its own output. That is what turned one custom-graph card
 * into ~270 render requests a second (#122).
 *
 * This wrapper keeps the latest `gt` in a ref and hands out one permanent
 * delegate, so `[stableGt]` is inert as a dependency while every call still
 * runs through the current locale's resolver.
 *
 * **Use it where `gt()` is called lazily** — inside async closures, event
 * handlers, `catch` blocks, transport clients — i.e. anywhere the dependency
 * array is about the *closure*, not about the translated text.
 *
 * **Keep plain `useGT()` where `gt()` is called eagerly** to produce a value
 * the memo returns (a label, an option list). Those memos are meant to
 * recompute when the translation changes, and a stable identity would pin them
 * to whatever the catalog said on first render.
 */
export function useStableGT(): GTFunction {
  const gt = useGT();
  // Written during render, like every "latest value" ref: the delegate below is
  // only ever invoked later (in an effect, a handler, or an awaited callback),
  // by which point the current render's `gt` is the right one to use.
  const latest = useRef(gt);
  latest.current = gt;
  return useCallback<GTFunction>((...args: Parameters<GTFunction>) => latest.current(...args), []);
}
