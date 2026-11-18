import { hostClient } from "@infrawrench/plugin-base/effect";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The SDK is replaced wholesale, so nothing here can reach Neon.
const api = {
  createProjectBranch: vi.fn(),
  listSnapshots: vi.fn(),
  restoreSnapshot: vi.fn(),
  getProjectBranch: vi.fn(),
  listProjectBranchEndpoints: vi.fn(),
  createProjectEndpoint: vi.fn(),
  listProjectBranchDatabases: vi.fn(),
  getConnectionUri: vi.fn(),
  deleteProjectBranch: vi.fn(),
};

vi.mock("@neondatabase/api-client", () => ({
  createApiClient: () => api,
  ConsumptionHistoryGranularity: { Hourly: "hourly" },
  EndpointType: { ReadWrite: "read_write", ReadOnly: "read_only" },
  BucketAccessLevel: { Private: "private", PublicRead: "public_read" },
  CredentialScope: {},
  NeonAuthOauthProviderId: {},
  NeonAuthSupportedAuthProvider: {},
}));

import { NeonClient } from "../client.js";

const client = () => hostClient(new NeonClient({ apiKey: "test-key" }));
const resourceId = "acct:neon-branch:proj-1/br-main";

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe("Neon restore drills", () => {
  it("branches from a point in the source's history", async () => {
    api.createProjectBranch.mockResolvedValue({ data: { branch: { id: "br-drill" } } });
    const handle = await client().startRestoreDrill!({
      resourceTypeId: "neon-branch",
      resourceId,
      accountId: "acct",
      restorePoint: { kind: "point-in-time", at: "2026-11-17T10:00:00.000Z" },
      copyName: "iw-drill-abc",
    });
    expect(api.createProjectBranch).toHaveBeenCalledWith("proj-1", {
      branch: {
        name: "iw-drill-abc",
        parent_id: "br-main",
        parent_timestamp: "2026-11-17T10:00:00.000Z",
      },
      endpoints: [{ type: "read_write" }],
    });
    expect(handle).toEqual({
      ref: "proj-1/br-drill",
      restoredFrom: "branch br-main at 2026-11-17T10:00:00.000Z",
      restorePointAt: "2026-11-17T10:00:00.000Z",
    });
  });

  it("restores the newest snapshot of the branch without finalizing", async () => {
    api.listSnapshots.mockResolvedValue({
      data: {
        snapshots: [
          {
            id: "s-old",
            name: "old",
            source_branch_id: "br-main",
            created_at: "2026-11-01T00:00:00Z",
          },
          {
            id: "s-new",
            name: "new",
            source_branch_id: "br-main",
            created_at: "2026-11-16T00:00:00Z",
          },
          {
            id: "s-other",
            name: "x",
            source_branch_id: "br-dev",
            created_at: "2026-11-17T00:00:00Z",
          },
        ],
      },
    });
    api.restoreSnapshot.mockResolvedValue({ data: { branch: { id: "br-restored" } } });
    const handle = await client().startRestoreDrill!({
      resourceTypeId: "neon-branch",
      resourceId,
      accountId: "acct",
      restorePoint: { kind: "latest-backup" },
      copyName: "iw-drill-abc",
    });
    expect(api.restoreSnapshot).toHaveBeenCalledWith(
      { projectId: "proj-1", snapshotId: "s-new" },
      { name: "iw-drill-abc", finalize_restore: false },
    );
    expect(handle.ref).toBe("proj-1/br-restored");
    expect(handle.restorePointAt).toBe("2026-11-16T00:00:00Z");
  });

  it("refuses when the branch has no snapshot", async () => {
    api.listSnapshots.mockResolvedValue({ data: { snapshots: [] } });
    await expect(
      client().startRestoreDrill!({
        resourceTypeId: "neon-branch",
        resourceId,
        accountId: "acct",
        restorePoint: { kind: "latest-backup" },
        copyName: "iw-drill-abc",
      }),
    ).rejects.toThrow("no snapshot");
  });

  it("is pending until the branch is ready, then hands back a Postgres URL", async () => {
    api.getProjectBranch.mockResolvedValueOnce({ data: { branch: { current_state: "init" } } });
    expect(await client().checkRestoreDrill!("proj-1/br-drill", "acct")).toMatchObject({
      state: "pending",
    });

    api.getProjectBranch.mockResolvedValue({ data: { branch: { current_state: "ready" } } });
    api.listProjectBranchEndpoints.mockResolvedValue({
      data: { endpoints: [{ type: "read_write" }] },
    });
    api.listProjectBranchDatabases.mockResolvedValue({
      data: { databases: [{ name: "neondb", owner_name: "neondb_owner" }] },
    });
    api.getConnectionUri.mockResolvedValue({ data: { uri: "postgresql://u:p@h/neondb" } });
    expect(await client().checkRestoreDrill!("proj-1/br-drill", "acct")).toEqual({
      state: "ready",
      connection: { driver: "postgres", connectionString: "postgresql://u:p@h/neondb" },
    });
    expect(api.getConnectionUri).toHaveBeenCalledWith({
      projectId: "proj-1",
      branch_id: "br-drill",
      database_name: "neondb",
      role_name: "neondb_owner",
    });
  });

  it("gives a restored branch without a compute one", async () => {
    api.getProjectBranch.mockResolvedValue({ data: { branch: { current_state: "ready" } } });
    api.listProjectBranchEndpoints.mockResolvedValue({ data: { endpoints: [] } });
    api.createProjectEndpoint.mockResolvedValue({ data: {} });
    expect(await client().checkRestoreDrill!("proj-1/br-drill", "acct")).toMatchObject({
      state: "pending",
    });
    expect(api.createProjectEndpoint).toHaveBeenCalledWith("proj-1", {
      endpoint: { branch_id: "br-drill", type: "read_write" },
    });
  });

  it("deletes the drill branch, and treats one already gone as deleted", async () => {
    api.getProjectBranch.mockResolvedValue({ data: { branch: { name: "iw-drill-abc" } } });
    api.deleteProjectBranch.mockResolvedValueOnce({ data: {} });
    await client().endRestoreDrill!("proj-1/br-drill", "acct");
    expect(api.deleteProjectBranch).toHaveBeenCalledWith({
      projectId: "proj-1",
      branchId: "br-drill",
    });

    api.deleteProjectBranch.mockRejectedValueOnce(
      Object.assign(new Error("not found"), { response: { status: 404 } }),
    );
    await expect(client().endRestoreDrill!("proj-1/br-drill", "acct")).resolves.toBeUndefined();
  });

  it("refuses to delete a branch no drill made", async () => {
    api.getProjectBranch.mockResolvedValue({ data: { branch: { name: "main" } } });
    await expect(client().endRestoreDrill!("proj-1/br-main", "acct")).rejects.toThrow("refusing");
    expect(api.deleteProjectBranch).not.toHaveBeenCalled();
  });
});
