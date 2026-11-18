import { useCallback, useRef } from "react";
import { useGT } from "gt-react";

type GTFunction = ReturnType<typeof useGT>;

/**
 * `useGT()` with an identity that never changes, not even with the locale.
 *
 * Plain `useGT()` is stable across ordinary renders, but only because of
 * `patches/@generaltranslation__react-core@11.1.6.patch`. Unpatched,
 * gt-react 11.1.6 hands back a new function on every render: its
 * `useCallback` depends on the tracked translation resolver, which depends on
 * the translations snapshot (a fresh `{}` with no `GTProvider`, #925) and, in
 * dev builds, on `useHandleMissingTranslation()`, whose hot-reload queue
 * allocated a new `Map` and setter per render (#1336). A fetch effect keyed on
 * `[gt]` then re-fired on its own `setState`: ~270 custom-graph renders a
 * second in #122, thousands of warehouse-option requests in #1336.
 * `__tests__/i18n/stable-gt.test.tsx` fails if the patch stops applying.
 *
 * What `useGT()` still does, by design, is change identity when the locale or
 * the loaded catalog changes, so a memo keyed on it recomputes its labels and
 * an effect keyed on it runs once more. This wrapper keeps the latest `gt` in
 * a ref and hands out one permanent delegate, so `[stableGt]` never re-runs
 * anything while every call still goes through the current locale's resolver.
 *
 * **Use it where `gt()` is called lazily** and an extra run is not wanted:
 * inside async closures, event handlers, `catch` blocks, transport clients,
 * i.e. anywhere the dependency array is about the *closure*, not about the
 * translated text. It is also the belt to the patch's braces for a value that
 * feeds an effect which fetches and sets state.
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
