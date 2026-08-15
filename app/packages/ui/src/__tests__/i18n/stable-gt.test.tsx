import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useGT } from "gt-react";
import { useStableGT } from "../../i18n/stable-gt.js";

/**
 * gt-react's own `useGT()` hands back a new function on every render, so any
 * `useMemo`/`useCallback` keyed on `[gt]` is keyed on nothing. When such a
 * value reaches an effect that fetches and sets state, the effect re-fires on
 * its own output — the custom-graph render loop in #122.
 *
 * These tests pin the property the fix depends on. The first is a guard on the
 * upstream behaviour: if a gt-react upgrade ever makes `useGT()` stable on its
 * own, it should say so out loud rather than leave the wrapper as cargo cult.
 */

function IdentityProbe({
  hook,
  seen,
}: {
  hook: () => (source: string) => string;
  seen: Set<unknown>;
}) {
  const gt = hook();
  seen.add(gt);
  return <span>{gt("Custom graph")}</span>;
}

describe("useStableGT", () => {
  it("documents that gt-react's useGT() is not referentially stable", () => {
    const seen = new Set<unknown>();
    const { rerender } = render(<IdentityProbe hook={useGT} seen={seen} />);
    rerender(<IdentityProbe hook={useGT} seen={seen} />);
    rerender(<IdentityProbe hook={useGT} seen={seen} />);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("keeps one identity across renders", () => {
    const seen = new Set<unknown>();
    const { rerender } = render(<IdentityProbe hook={useStableGT} seen={seen} />);
    rerender(<IdentityProbe hook={useStableGT} seen={seen} />);
    rerender(<IdentityProbe hook={useStableGT} seen={seen} />);
    expect(seen.size).toBe(1);
  });

  it("still translates through the live gt", () => {
    const { container } = render(<IdentityProbe hook={useStableGT} seen={new Set()} />);
    // English is the source locale, so the source string is the translation;
    // what matters is that the delegate reaches gt at all.
    expect(container.textContent).toBe("Custom graph");
  });
});
