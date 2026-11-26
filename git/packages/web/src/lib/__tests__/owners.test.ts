// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Session } from "@infrawrench/git-contract";
import { ownersOf, visibilityFor } from "../owners";

const REFUSAL = "The free plan includes 3 private repositories. Make this one public";

const session: Session = {
  user: {
    id: "u1",
    email: "mara@acme.example",
    username: "mara",
    displayName: null,
    avatarUrl: null,
  },
  onboarding: { needsUsername: false, suggestedUsername: null },
  personal: {
    privateRepositories: true,
    privateRepositoryRefusal: null,
    defaultVisibility: "private",
  },
  organizations: [
    {
      id: "o1",
      name: "Acme",
      namespace: "acme",
      permissions: ["git:read", "git:write"],
      canClaimNamespace: false,
      privateRepositories: true,
      privateRepositoryRefusal: null,
      defaultVisibility: "public",
    },
    {
      id: "o2",
      name: "Tidewater",
      namespace: "tidewater",
      permissions: ["git:read", "git:write"],
      canClaimNamespace: false,
      privateRepositories: false,
      privateRepositoryRefusal: REFUSAL,
      defaultVisibility: "private",
    },
    {
      id: "o3",
      name: "Readers",
      namespace: "readers",
      permissions: ["git:read"],
      canClaimNamespace: false,
      privateRepositories: true,
      privateRepositoryRefusal: null,
      defaultVisibility: "private",
    },
    {
      id: "o4",
      name: "Unclaimed",
      namespace: null,
      permissions: ["git:read", "git:write", "git:admin"],
      canClaimNamespace: true,
      privateRepositories: true,
      privateRepositoryRefusal: null,
      defaultVisibility: "private",
    },
  ],
  signInUrl: "/auth/sign-in",
  appUrl: "https://app.example.test",
};

describe("ownersOf", () => {
  it("lists the person's namespace and the organisations they can create in", () => {
    expect(ownersOf(session).map((owner) => owner.slug)).toEqual(["mara", "acme", "tidewater"]);
  });

  it("lists nothing personal before a username", () => {
    const fresh = { ...session, user: { ...session.user!, username: null }, personal: null };
    expect(ownersOf(fresh).map((owner) => owner.slug)).toEqual(["acme", "tidewater"]);
  });
});

describe("visibilityFor", () => {
  const [mara, acme, tidewater] = ownersOf(session) as [
    ReturnType<typeof ownersOf>[number],
    ReturnType<typeof ownersOf>[number],
    ReturnType<typeof ownersOf>[number],
  ];

  it("starts at the namespace's default", () => {
    expect(visibilityFor(mara, null)).toBe("private");
    expect(visibilityFor(acme, null)).toBe("public");
  });

  it("keeps the person's own choice across namespaces", () => {
    expect(visibilityFor(acme, "private")).toBe("private");
    expect(visibilityFor(mara, "public")).toBe("public");
  });

  it("is public where the plan refuses another private repository, with the quota's sentence", () => {
    expect(tidewater.privateRepositoryRefusal).toBe(REFUSAL);
    expect(visibilityFor(tidewater, null)).toBe("public");
    expect(visibilityFor(tidewater, "private")).toBe("public");
  });
});
