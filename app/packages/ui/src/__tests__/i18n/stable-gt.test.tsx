import { useEffect, useState } from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useGT } from "gt-react";
import { useStableGT } from "../../i18n/stable-gt.js";

/**
 * Unpatched, gt-react's `useGT()` hands back a new function on every render
 * (a fresh translations snapshot, #925, and in dev a fresh missing-translation
 * queue, #1336), so any memo or effect keyed on `[gt]` is keyed on nothing.
 * When such an effect fetches and sets state, it re-fires on its own output:
 * the custom-graph render loop in #122 and the warehouse-option request flood
 * in #1336.
 *
 * `patches/@generaltranslation__react-core@11.1.6.patch` makes `useGT()`
 * stable across renders. These tests run outside production (vitest sets
 * NODE_ENV to "test"), which is the branch #1336 was about, so they fail if
 * the patch stops applying or a gt-react upgrade brings the churn back.
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

/** The shape of every fetch effect in the panels: keyed on `gt`, sets state. */
function EffectProbe({ runs }: { runs: { count: number } }) {
  const gt = useGT();
  const [label, setLabel] = useState("");
  useEffect(() => {
    runs.count += 1;
    setLabel(gt("Loaded"));
  }, [gt, runs]);
  return <span>{label}</span>;
}

describe("useGT", () => {
  it("keeps one identity across renders (patched, #925 and #1336)", () => {
    const seen = new Set<unknown>();
    const { rerender } = render(<IdentityProbe hook={useGT} seen={seen} />);
    rerender(<IdentityProbe hook={useGT} seen={seen} />);
    rerender(<IdentityProbe hook={useGT} seen={seen} />);
    expect(seen.size).toBe(1);
  });

  it("does not re-run an effect that depends on it and sets state", () => {
    const runs = { count: 0 };
    const { container, rerender } = render(<EffectProbe runs={runs} />);
    rerender(<EffectProbe runs={runs} />);
    expect(container.textContent).toBe("Loaded");
    expect(runs.count).toBe(1);
  });
});

describe("useStableGT", () => {
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
