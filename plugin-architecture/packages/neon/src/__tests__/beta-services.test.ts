import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock the Neon SDK ----------------------------------------------------
const api = {
  listProjects: vi.fn(),
  listProjectBranches: vi.fn(),
  listSnapshots: vi.fn(),
  createSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  getProjectBranchStorage: vi.fn(),
  listProjectBranchBuckets: vi.fn(),
  createProjectBranchBucket: vi.fn(),
  deleteProjectBranchBucket: vi.fn(),
  listProjectBranchBucketObjects: vi.fn(),
  deleteProjectBranchBucketObject: vi.fn(),
  deleteProjectBranchBucketObjectsByPrefix: vi.fn(),
  presignProjectBranchBucketObject: vi.fn(),
  listCredentials: vi.fn(),
  createCredential: vi.fn(),
  revokeCredential: vi.fn(),
  listProjectBranchFunctions: vi.fn(),
  deleteProjectBranchFunction: vi.fn(),
  getProjectBranchAiGateway: vi.fn(),
  getNeonAuth: vi.fn(),
  createNeonAuth: vi.fn(),
  disableNeonAuth: vi.fn(),
  getNeonAuthPluginConfigs: vi.fn(),
  listBranchNeonAuthOauthProviders: vi.fn(),
  addBranchNeonAuthOauthProvider: vi.fn(),
  deleteBranchNeonAuthOauthProvider: vi.fn(),
  listBranchNeonAuthTrustedDomains: vi.fn(),
  addBranchNeonAuthTrustedDomain: vi.fn(),
  deleteBranchNeonAuthTrustedDomain: vi.fn(),
};

vi.mock("@neondatabase/api-client", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createApiClient: (..._args: any[]) => api,
  ConsumptionHistoryGranularity: { Hourly: "hourly" },
  EndpointType: { ReadWrite: "read_write", ReadOnly: "read_only" },
  BucketAccessLevel: { Private: "private", PublicRead: "public_read" },
  CredentialScope: {
    StorageRead: "storage:read",
    StorageWrite: "storage:write",
    AiGatewayInvoke: "ai_gateway:invoke",
    FunctionsInvoke: "functions:invoke",
  },
  NeonAuthOauthProviderId: {
    Google: "google",
    Github: "github",
    Microsoft: "microsoft",
    Vercel: "vercel",
  },
  NeonAuthSupportedAuthProvider: { Mock: "mock", Stack: "stack", BetterAuth: "better_auth" },
}));

import { NeonClient } from "../client.js";

const ACCOUNT = "acct1";
const wrap = (data: unknown) => ({ data });

/** Neon answers 404 on branches whose org lacks the Private Beta entitlement. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

function makeClient() {
  return new NeonClient({ apiKey: "neon_test" });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listProjects.mockResolvedValue(wrap({ projects: [{ id: "p1", name: "proj" }] }));
  api.listProjectBranches.mockResolvedValue(
    wrap({ branches: [{ id: "b1", name: "main", project_id: "p1" }] }),
  );
});

describe("snapshots", () => {
  it("lists snapshots despite the SDK mistyping the response", async () => {
    api.listSnapshots.mockResolvedValue(
      wrap({
        snapshots: [
          {
            id: "snap1",
            name: "nightly",
            source_branch_id: "b1",
            created_at: "2026-07-01T00:00:00Z",
            manual: true,
            full_size: 1024,
          },
        ],
      }),
    );

    const res = await makeClient().listResources("neon-snapshot", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-snapshot:p1/snap1",
      resourceTypeId: "neon-snapshot",
      displayName: "nightly",
      parentResourceId: "acct1:neon-branch:p1/b1",
      fields: { name: "nightly", manual: true, sourceBranchId: "b1" },
      resolvedOutputs: { snapshotId: "snap1", projectId: "p1" },
    });
  });

  it("creates a snapshot scoped to the parent branch", async () => {
    api.createSnapshot.mockResolvedValue(
      wrap({
        snapshot: { id: "snap2", name: "before-migration", created_at: "2026-07-02T00:00:00Z" },
      }),
    );

    const res = await makeClient().createResource(
      "neon-snapshot",
      ACCOUNT,
      { name: "before-migration" },
      "acct1:neon-branch:p1/b1",
    );

    expect(api.createSnapshot).toHaveBeenCalledWith({
      projectId: "p1",
      branchId: "b1",
      name: "before-migration",
    });
    expect(res.displayName).toBe("before-migration");
  });

  it("omits the name when the user leaves it blank", async () => {
    api.createSnapshot.mockResolvedValue(
      wrap({ snapshot: { id: "s", name: "auto", created_at: "" } }),
    );

    await makeClient().createResource("neon-snapshot", ACCOUNT, {}, "acct1:neon-branch:p1/b1");

    expect(api.createSnapshot).toHaveBeenCalledWith({ projectId: "p1", branchId: "b1" });
  });

  it("restores without finalizing, so the data can be inspected first", async () => {
    api.restoreSnapshot.mockResolvedValue(wrap({}));

    await makeClient().invokeAction(
      "neon-snapshot",
      "acct1:neon-snapshot:p1/snap1",
      "restore",
      ACCOUNT,
    );

    expect(api.restoreSnapshot).toHaveBeenCalledWith(
      { projectId: "p1", snapshotId: "snap1" },
      { finalize_restore: false },
    );
  });

  it("deletes a snapshot", async () => {
    await makeClient().deleteResource("neon-snapshot", "acct1:neon-snapshot:p1/snap1", ACCOUNT);
    expect(api.deleteSnapshot).toHaveBeenCalledWith("p1", "snap1");
  });

  it("exposes a restore action and drops the lifecycle status", () => {
    const detail = makeClient().renderDetail({
      id: "acct1:neon-snapshot:p1/snap1",
      pluginId: "neon",
      resourceTypeId: "neon-snapshot",
      accountId: ACCOUNT,
      displayName: "nightly",
      fields: { name: "nightly", projectId: "p1" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "p1/snap1",
      createdAt: "",
      updatedAt: "",
    });

    expect(detail.status).toBeUndefined();
    expect(detail.headerActions?.[0]).toMatchObject({
      label: "Restore",
      action: { type: "plugin-action", actionId: "restore" },
    });
  });
});

describe("object storage", () => {
  const storage = wrap({
    enabled: true,
    s3_endpoint: "https://br-b1.storage.neon.build",
    region: "us-east-2",
    force_path_style: true,
  });

  it("lists buckets with the branch's storage endpoint", async () => {
    api.getProjectBranchStorage.mockResolvedValue(storage);
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({
        buckets: [{ name: "assets", access_level: "private", created_at: "2026-07-01T00:00:00Z" }],
      }),
    );

    const res = await makeClient().listResources("neon-bucket", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-bucket:p1/b1/assets",
      parentResourceId: "acct1:neon-branch:p1/b1",
      fields: { name: "assets", accessLevel: "private", region: "us-east-2" },
      resolvedOutputs: { s3Endpoint: "https://br-b1.storage.neon.build", region: "us-east-2" },
    });
  });

  it("skips branches without the Private Beta entitlement instead of failing", async () => {
    api.getProjectBranchStorage.mockRejectedValue(httpError(404));

    const res = await makeClient().listResources("neon-bucket", ACCOUNT);

    expect(res).toEqual([]);
    expect(api.listProjectBranchBuckets).not.toHaveBeenCalled();
  });

  it("surfaces unexpected errors rather than silently hiding buckets", async () => {
    api.getProjectBranchStorage.mockRejectedValue(httpError(500));

    await expect(makeClient().listResources("neon-bucket", ACCOUNT)).rejects.toThrow();
  });

  it("maps folders and objects into browser entries relative to the prefix", async () => {
    api.getProjectBranchStorage.mockResolvedValue(storage);
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({ buckets: [{ name: "assets", access_level: "private", created_at: "" }] }),
    );
    api.listProjectBranchBucketObjects.mockResolvedValue(
      wrap({
        folders: ["img/thumbs/"],
        objects: [
          { key: "img/", size: 0, last_modified: "", etag: "x" },
          { key: "img/logo.png", size: 42, last_modified: "2026-07-01T00:00:00Z", etag: "y" },
        ],
        prefix: "img/",
      }),
    );

    const objects = await makeClient().listStorageObjects("assets", "img/");

    expect(objects).toEqual([
      { key: "img/thumbs/", name: "thumbs", size: 0, lastModified: "", isDirectory: true },
      {
        key: "img/logo.png",
        name: "logo.png",
        size: 42,
        lastModified: "2026-07-01T00:00:00Z",
        isDirectory: false,
      },
    ]);
  });

  it("finds the branch a bucket lives on when the cache is cold", async () => {
    api.getProjectBranchStorage.mockResolvedValue(storage);
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({ buckets: [{ name: "assets", access_level: "private", created_at: "" }] }),
    );
    api.listProjectBranchBucketObjects.mockResolvedValue(
      wrap({ folders: [], objects: [], prefix: "" }),
    );

    await makeClient().listStorageObjects("assets", "");

    expect(api.listProjectBranchBucketObjects).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "p1", branchId: "b1", bucketName: "assets" }),
    );
  });

  it("deletes a whole prefix when the host deletes a folder", async () => {
    api.getProjectBranchStorage.mockResolvedValue(storage);
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({ buckets: [{ name: "assets", access_level: "private", created_at: "" }] }),
    );

    await makeClient().deleteStorageObject("assets", "img/");

    expect(api.deleteProjectBranchBucketObjectsByPrefix).toHaveBeenCalledWith(
      expect.objectContaining({ bucketName: "assets", prefix: "img/" }),
    );
    expect(api.deleteProjectBranchBucketObject).not.toHaveBeenCalled();
  });

  it("deletes a single object by key", async () => {
    api.getProjectBranchStorage.mockResolvedValue(storage);
    api.listProjectBranchBuckets.mockResolvedValue(
      wrap({ buckets: [{ name: "assets", access_level: "private", created_at: "" }] }),
    );

    await makeClient().deleteStorageObject("assets", "img/logo.png");

    expect(api.deleteProjectBranchBucketObject).toHaveBeenCalledWith(
      "p1",
      "b1",
      "assets",
      "img/logo.png",
    );
  });

  it("creates a bucket with the chosen access level", async () => {
    api.createProjectBranchBucket.mockResolvedValue(
      wrap({ bucket: { name: "public-assets", access_level: "public_read", created_at: "" } }),
    );
    api.getProjectBranchStorage.mockResolvedValue(storage);

    await makeClient().createResource(
      "neon-bucket",
      ACCOUNT,
      { name: "public-assets", accessLevel: "public_read" },
      "acct1:neon-branch:p1/b1",
    );

    expect(api.createProjectBranchBucket).toHaveBeenCalledWith("p1", "b1", {
      name: "public-assets",
      access_level: "public_read",
    });
  });

  it("renders a storage browser for a bucket", () => {
    const detail = makeClient().renderDetail({
      id: "acct1:neon-bucket:p1/b1/assets",
      pluginId: "neon",
      resourceTypeId: "neon-bucket",
      accountId: ACCOUNT,
      displayName: "assets",
      fields: { name: "assets", projectId: "p1", branchId: "b1" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: "p1/b1/assets",
      createdAt: "",
      updatedAt: "",
    });

    expect(detail.storageBrowser).toEqual({ bucketName: "assets" });
  });
});

describe("credentials", () => {
  it("expands a scope bundle and returns the once-only secrets", async () => {
    api.createCredential.mockResolvedValue(
      wrap({
        token_id: "tok_1",
        token_id_short: "tok_1abc",
        name: "uploads",
        api_token: "nsk_live_token",
        s3_secret_access_key: "nsk_live_secret",
        scopes: ["storage:read", "storage:write"],
        branch_id: "b1",
        created_at: "2026-07-01T00:00:00Z",
      }),
    );

    const res = await makeClient().createResource(
      "neon-credential",
      ACCOUNT,
      { name: "uploads", scopes: "storage-rw" },
      "acct1:neon-branch:p1/b1",
    );

    expect(api.createCredential).toHaveBeenCalledWith("p1", "b1", {
      name: "uploads",
      scopes: ["storage:read", "storage:write"],
      principal_type: "user",
    });
    expect(res.resolvedOutputs).toMatchObject({
      apiToken: "nsk_live_token",
      s3SecretAccessKey: "nsk_live_secret",
    });
  });

  it("hides revoked credentials from the listing", async () => {
    api.listCredentials.mockResolvedValue(
      wrap({
        credentials: [
          {
            token_id: "t1",
            token_id_short: "t1",
            scopes: ["storage:read"],
            principal_type: "user",
            created_at: "",
          },
          {
            token_id: "t2",
            token_id_short: "t2",
            scopes: ["storage:read"],
            principal_type: "user",
            created_at: "",
            revoked_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const res = await makeClient().listResources("neon-credential", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!.externalId).toBe("p1/b1/t1");
  });

  it("explains that secrets cannot be re-read rather than returning nothing", async () => {
    await expect(
      makeClient().resolveOutput(
        "neon-credential",
        "acct1:neon-credential:p1/b1/t1",
        "apiToken",
        ACCOUNT,
      ),
    ).rejects.toThrow(/shown only once/);
  });

  it("revokes a credential on delete", async () => {
    await makeClient().deleteResource(
      "neon-credential",
      "acct1:neon-credential:p1/b1/tok_1",
      ACCOUNT,
    );
    expect(api.revokeCredential).toHaveBeenCalledWith("p1", "b1", "tok_1");
  });
});

describe("functions", () => {
  it("lists functions despite the SDK mistyping the response", async () => {
    api.listProjectBranchFunctions.mockResolvedValue(
      wrap({
        functions: [
          {
            id: "fn_1",
            slug: "resize",
            name: "Resize images",
            invocation_url: "https://b1-resize.functions.neon.build/",
            current_deployment: { id: 3, status: "completed", runtime: "nodejs24" },
            created_at: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const res = await makeClient().listResources("neon-function", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-function:p1/b1/resize",
      displayName: "Resize images",
      fields: { slug: "resize", deploymentStatus: "completed", runtime: "nodejs24" },
      resolvedOutputs: { functionId: "fn_1" },
    });
  });

  it("skips branches without the Functions entitlement", async () => {
    api.listProjectBranchFunctions.mockRejectedValue(httpError(404));
    await expect(makeClient().listResources("neon-function", ACCOUNT)).resolves.toEqual([]);
  });

  it("deletes a function by slug", async () => {
    await makeClient().deleteResource("neon-function", "acct1:neon-function:p1/b1/resize", ACCOUNT);
    expect(api.deleteProjectBranchFunction).toHaveBeenCalledWith("p1", "b1", "resize");
  });
});

describe("ai gateway", () => {
  it("lists an enabled gateway", async () => {
    api.getProjectBranchAiGateway.mockResolvedValue(
      wrap({ enabled: true, base_url: "https://b1.gateway.neon.build" }),
    );

    const res = await makeClient().listResources("neon-ai-gateway", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-ai-gateway:p1/b1",
      fields: { baseUrl: "https://b1.gateway.neon.build" },
      resolvedOutputs: { baseUrl: "https://b1.gateway.neon.build" },
    });
  });

  it("omits a disabled gateway", async () => {
    api.getProjectBranchAiGateway.mockResolvedValue(wrap({ enabled: false, base_url: "" }));
    await expect(makeClient().listResources("neon-ai-gateway", ACCOUNT)).resolves.toEqual([]);
  });
});

describe("neon auth", () => {
  const integration = {
    auth_provider: "better_auth",
    auth_provider_project_id: "ap1",
    branch_id: "b1",
    db_name: "neondb",
    created_at: "2026-07-01T00:00:00Z",
    owned_by: "neon",
    jwks_url: "https://api.neon.tech/jwks",
  };

  it("folds the plugin config into the auth resource", async () => {
    api.getNeonAuth.mockResolvedValue(wrap(integration));
    api.getNeonAuthPluginConfigs.mockResolvedValue(
      wrap({ email_and_password: { enabled: true }, allow_localhost: true }),
    );

    const res = await makeClient().listResources("neon-auth", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-auth:p1/b1",
      parentResourceId: "acct1:neon-branch:p1/b1",
      fields: { authProvider: "better_auth", emailAndPassword: true, allowLocalhost: true },
      resolvedOutputs: { jwksUrl: "https://api.neon.tech/jwks" },
    });
  });

  it("omits branches where auth is not enabled", async () => {
    api.getNeonAuth.mockRejectedValue(httpError(404));
    await expect(makeClient().listResources("neon-auth", ACCOUNT)).resolves.toEqual([]);
  });

  it("still lists auth when the plugin config is unavailable", async () => {
    api.getNeonAuth.mockResolvedValue(wrap(integration));
    api.getNeonAuthPluginConfigs.mockRejectedValue(httpError(404));

    const res = await makeClient().listResources("neon-auth", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!.fields["emailAndPassword"]).toBe(false);
  });

  it("disables auth without dropping the neon_auth schema", async () => {
    await makeClient().deleteResource("neon-auth", "acct1:neon-auth:p1/b1", ACCOUNT);
    expect(api.disableNeonAuth).toHaveBeenCalledWith("p1", "b1", { delete_data: false });
  });

  it("lists oauth providers from the `providers` key", async () => {
    api.listBranchNeonAuthOauthProviders.mockResolvedValue(
      wrap({ providers: [{ id: "google", type: "standard", client_id: "cid" }] }),
    );

    const res = await makeClient().listResources("neon-auth-oauth-provider", ACCOUNT);

    expect(res).toHaveLength(1);
    expect(res[0]!).toMatchObject({
      id: "acct1:neon-auth-oauth-provider:p1/b1/google",
      parentResourceId: "acct1:neon-auth:p1/b1",
      fields: { providerId: "google", type: "standard", clientId: "cid" },
    });
  });

  it("adds an oauth provider with shared credentials when none are given", async () => {
    api.addBranchNeonAuthOauthProvider.mockResolvedValue(wrap({ id: "github", type: "shared" }));

    await makeClient().createResource(
      "neon-auth-oauth-provider",
      ACCOUNT,
      { providerId: "github" },
      "acct1:neon-auth:p1/b1",
    );

    expect(api.addBranchNeonAuthOauthProvider).toHaveBeenCalledWith("p1", "b1", { id: "github" });
  });

  it("lists trusted domains and carries the provider needed to delete them", async () => {
    api.listBranchNeonAuthTrustedDomains.mockResolvedValue(
      wrap({ domains: [{ domain: "https://app.example.com", auth_provider: "better_auth" }] }),
    );

    const res = await makeClient().listResources("neon-auth-domain", ACCOUNT);

    expect(res[0]!).toMatchObject({
      id: "acct1:neon-auth-domain:p1/b1/https://app.example.com",
      fields: { domain: "https://app.example.com", authProvider: "better_auth" },
    });
  });

  it("deletes a trusted domain using its owning provider", async () => {
    api.listBranchNeonAuthTrustedDomains.mockResolvedValue(
      wrap({ domains: [{ domain: "https://app.example.com", auth_provider: "better_auth" }] }),
    );

    await makeClient().deleteResource(
      "neon-auth-domain",
      "acct1:neon-auth-domain:p1/b1/https://app.example.com",
      ACCOUNT,
    );

    expect(api.deleteBranchNeonAuthTrustedDomain).toHaveBeenCalledWith("p1", "b1", {
      auth_provider: "better_auth",
      domains: [{ domain: "https://app.example.com" }],
    });
  });
});
