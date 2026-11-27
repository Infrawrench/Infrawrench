/**
 * What the Terraform endpoints show of the owning organisation, and what they
 * accept, as the rules over plain values (no database).
 */
import { describe, expect, it } from "vitest";
import { BadRequest } from "@infrawrench/git-contract";
import {
  LEND_ACCOUNTS_PERMISSION,
  holdsInOrganization,
  lockHolderUserId,
  normalRoot,
} from "../handlers/automation";

describe("holdsInOrganization", () => {
  const member = [{ id: "org-1", permissions: ["accounts:read", "resources:read"] }];

  it("answers a member by their permissions in that organisation", () => {
    expect(holdsInOrganization(member, "org-1", "accounts:read")).toBe(true);
    expect(holdsInOrganization(member, "org-1", "resources:read")).toBe(true);
    expect(holdsInOrganization(member, "org-1", LEND_ACCOUNTS_PERMISSION)).toBe(false);
    expect(
      holdsInOrganization([{ id: "org-1", permissions: ["*"] }], "org-1", "ci-access:write"),
    ).toBe(true);
  });

  it("gives a reader of a public repository who is not a member nothing", () => {
    expect(holdsInOrganization([], "org-1", "accounts:read")).toBe(false);
    expect(holdsInOrganization(member, "org-2", "accounts:read")).toBe(false);
    expect(holdsInOrganization(member, null, "accounts:read")).toBe(false);
  });

  it("asks the app's own permission for lending accounts, not seeing them", () => {
    expect(LEND_ACCOUNTS_PERMISSION).toBe("ci-access:write");
  });
});

describe("lockHolderUserId", () => {
  it("names a person who holds a lock and nobody else", () => {
    expect(lockHolderUserId("user:abc")).toBe("abc");
    expect(lockHolderUserId("ci:run-1")).toBeNull();
    expect(lockHolderUserId("token:t-1")).toBeNull();
    expect(lockHolderUserId("user:")).toBeNull();
    expect(lockHolderUserId(null)).toBeNull();
  });
});

describe("normalRoot", () => {
  it("accepts what the run pipeline accepts, trimmed of outer slashes", () => {
    expect(normalRoot("")).toBe("");
    expect(normalRoot("/")).toBe("");
    expect(normalRoot("infra/prod/")).toBe("infra/prod");
    expect(normalRoot("modules/v1.2_x-y")).toBe("modules/v1.2_x-y");
  });

  it("refuses what the pipeline would refuse at its first run", () => {
    for (const path of ["a/../b", "./a", "a//b", "a b", "a;b", "a$(x)", "émoji", "a\\b"]) {
      expect(() => normalRoot(path), path).toThrow(BadRequest);
    }
  });
});
