/**
 * Object sharing levels: the org default, member and role grants, implicit
 * report ownership, folder inheritance (explicit folder sharing only), and
 * the `sharing:override` bypass.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const results: unknown[][] = [];
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => results.shift() ?? [],
      }),
    }),
  },
}));

const sharing = await import("@/services/object-sharing");

type Row = {
  objectType: string;
  objectId: string;
  principalKind: string;
  principalId: string;
  level: string;
};
const g = (
  objectType: string,
  objectId: string,
  principalKind: string,
  principalId: string,
  level: string,
): Row => ({ objectType, objectId, principalKind, principalId, level });

const ALICE = { organizationId: "o", userId: "alice", roleId: "role-fin", override: false };

async function levelOf(
  type: "cost_report" | "cost_report_folder" | "dashboard",
  id: string,
  grants: Row[],
  meta: { createdByUserId?: string | null; folderId?: string | null } = {},
  folders: Array<{ id: string; parent: string | null }> = [],
  principal = ALICE,
) {
  results.length = 0;
  results.push(grants);
  if (type !== "dashboard") results.push(folders);
  return await sharing.runWithSharingPrincipal(principal, async () => {
    const r = await sharing.loadAccessResolver("o", type);
    return r.level(id, meta);
  });
}

beforeEach(() => {
  results.length = 0;
});

describe("object sharing levels", () => {
  it("defaults to editor for an object nobody shared", async () => {
    expect(await levelOf("dashboard", "d1", [])).toBe("editor");
  });

  it("honours an org default of none or viewer", async () => {
    expect(await levelOf("dashboard", "d1", [g("dashboard", "d1", "org", "", "none")])).toBe(
      "none",
    );
    expect(await levelOf("dashboard", "d1", [g("dashboard", "d1", "org", "", "viewer")])).toBe(
      "viewer",
    );
  });

  it("a member or role grant lifts above the org default", async () => {
    const base = g("dashboard", "d1", "org", "", "none");
    expect(
      await levelOf("dashboard", "d1", [base, g("dashboard", "d1", "member", "alice", "viewer")]),
    ).toBe("viewer");
    expect(
      await levelOf("dashboard", "d1", [base, g("dashboard", "d1", "role", "role-fin", "owner")]),
    ).toBe("owner");
    expect(
      await levelOf("dashboard", "d1", [base, g("dashboard", "d1", "member", "bob", "owner")]),
    ).toBe("none");
  });

  it("the creator of a report owns it", async () => {
    const base = g("cost_report", "r1", "org", "", "none");
    expect(await levelOf("cost_report", "r1", [base], { createdByUserId: "alice" })).toBe("owner");
  });

  it("explicit folder sharing reaches reports inside it, through every ancestor", async () => {
    const grants = [
      g("cost_report", "r1", "org", "", "none"),
      g("cost_report_folder", "f-root", "member", "alice", "editor"),
    ];
    const folders = [
      { id: "f-root", parent: null },
      { id: "f-child", parent: "f-root" },
    ];
    expect(await levelOf("cost_report", "r1", grants, { folderId: "f-child" }, folders)).toBe(
      "editor",
    );
  });

  it("a folder left at the default does not undo a report's 'none'", async () => {
    const grants = [g("cost_report", "r1", "org", "", "none")];
    expect(
      await levelOf("cost_report", "r1", grants, { folderId: "f1" }, [{ id: "f1", parent: null }]),
    ).toBe("none");
  });

  it("sharing:override sees everything", async () => {
    expect(
      await levelOf("dashboard", "d1", [g("dashboard", "d1", "org", "", "none")], {}, [], {
        ...ALICE,
        override: true,
      }),
    ).toBe("owner");
  });

  it("no principal (a system caller) has full access", async () => {
    results.length = 0;
    const r = await sharing.loadAccessResolver("o", "dashboard");
    expect(r.level("d1")).toBe("owner");
  });
});
