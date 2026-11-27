// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Owner } from "../../lib/owners";
import { forkTargets } from "../RepoLayout";

const owner = (slug: string, kind: "user" | "org", refusal: string | null = null): Owner => ({
  slug,
  label: slug,
  kind,
  defaultVisibility: "private",
  privateRepositoryRefusal: refusal,
});

const REFUSAL = "The free plan includes 3 private repositories";
const owners = [owner("mara", "user"), owner("acme", "org"), owner("tidewater", "org", REFUSAL)];
const acme = { slug: "acme", kind: "org" as const, displayName: null, avatarUrl: null };

describe("forkTargets", () => {
  it("offers every namespace the person can create in for a public repository", () => {
    const targets = forkTargets({ owner: acme, visibility: "public" }, owners);
    expect(targets.map((target) => target.slug)).toEqual(["mara", "acme", "tidewater"]);
    // A public fork counts toward no plan.
    expect(targets.every((target) => target.refusal === null)).toBe(true);
  });

  it("keeps a private repository's fork in its owner's namespace", () => {
    const targets = forkTargets({ owner: acme, visibility: "private" }, owners);
    expect(targets.map((target) => target.slug)).toEqual(["acme"]);
  });

  it("says why a private fork does not fit the owner's plan", () => {
    const tidewater = { ...acme, slug: "Tidewater" };
    const [target] = forkTargets({ owner: tidewater, visibility: "private" }, owners);
    expect(target).toMatchObject({ slug: "tidewater", refusal: REFUSAL });
  });

  it("offers nothing to someone who cannot create where a private repository lives", () => {
    expect(forkTargets({ owner: acme, visibility: "private" }, [owner("mara", "user")])).toEqual(
      [],
    );
  });
});
