import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApi } from "@/http/testing";

// The queries reach server-core's db client at import time: stub them at the
// boundary. These tests own the transport contract of the Git domain: the
// permission each route takes, how a refusal is answered and the audit trail.
const mockOverview = vi.fn();
const mockRepositories = vi.fn();
const mockSetNamespace = vi.fn();
const mockSetVisibility = vi.fn();
const mockLogAudit = vi.fn();
const mockEnsurePrice = vi.fn<(orgId: string) => Promise<string[]>>();

class GitForgeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("@infrawrench/server-core/git/forge", () => ({
  GitForgeError,
  gitForgeOverview: (...args: unknown[]) => mockOverview(...args),
  listGitForgeRepositories: (...args: unknown[]) => mockRepositories(...args),
  setGitForgeNamespace: (...args: unknown[]) => mockSetNamespace(...args),
  setGitForgeDefaultVisibility: (...args: unknown[]) => mockSetVisibility(...args),
}));
vi.mock("../../../services/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));
// git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
const mockGitEnabled = vi.fn<(orgId: string) => Promise<boolean>>();
vi.mock("@infrawrench/server-core/git/feature-flag", () => ({
  isGitEnabled: (orgId: string) => mockGitEnabled(orgId),
}));
vi.mock("../billing/operations", () => ({
  ensureGitStoragePrice: (orgId: string) => mockEnsurePrice(orgId),
}));

const { gitDomain } = await import("@/http/domains/git/index");

const buildApp = (permissions: string[]) =>
  buildTestApi(gitDomain, { basePath: "/api/org/org-1/git", permissions });

const namespace = {
  slug: "acme",
  url: "https://git.infrawrench.com/acme",
  defaultVisibility: "private",
  createdAt: "2026-11-20T10:00:00.000Z",
  renamedAt: null,
};
const overview = {
  forgeUrl: "https://git.infrawrench.com",
  namespace,
  plan: "free",
  limits: {
    privateRepositories: 3,
    privateStorageBytes: 1024 ** 3,
    includedStorageBytes: 1024 ** 3,
  },
  usage: {
    repositories: 2,
    publicRepositories: 1,
    privateRepositories: 1,
    storageBytes: 2048,
    privateStorageBytes: 1024,
  },
};
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mockOverview.mockResolvedValue(overview);
  mockRepositories.mockResolvedValue([]);
  mockEnsurePrice.mockResolvedValue([]);
  mockGitEnabled.mockResolvedValue(true); // git-feature-flag
});

// git-feature-flag: remove with the flag (KNOWLEDGE.md "Git feature flag").
describe("the Git feature flag", () => {
  it("answers every route 404 until the organisation has Git, and reads nothing", async () => {
    mockGitEnabled.mockResolvedValue(false);
    const app = buildApp(["git:read", "git:write", "git:admin"]);
    const answers = await Promise.all([
      app.request("/"),
      app.request("/repositories"),
      app.request("/namespace", put({ slug: "acme" })),
      app.request("/settings", put({ defaultVisibility: "public" })),
    ]);
    expect(answers.map((res) => res.status)).toEqual([404, 404, 404, 404]);
    expect(mockGitEnabled).toHaveBeenCalledWith("org-1");
    expect(mockOverview).not.toHaveBeenCalled();
    expect(mockSetNamespace).not.toHaveBeenCalled();
  });
});

describe("GET /git", () => {
  it("needs git:read", async () => {
    expect((await buildApp(["resources:read"]).request("/")).status).toBe(403);
    const res = await buildApp(["git:read"]).request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...overview, reservedNamesAllowed: false });
    expect(mockOverview).toHaveBeenCalledWith("org-1");
  });

  it("lists repositories on git:read", async () => {
    expect((await buildApp([]).request("/repositories")).status).toBe(403);
    const res = await buildApp(["git:read"]).request("/repositories");
    expect(await res.json()).toEqual({ repositories: [] });
  });
});

describe("PUT /git/namespace", () => {
  it("needs git:admin: writing repositories is not enough to name the organisation", async () => {
    const res = await buildApp(["git:read", "git:write"]).request("/namespace", put({ slug: "x" }));
    expect(res.status).toBe(403);
    expect(mockSetNamespace).not.toHaveBeenCalled();
  });

  it("claims, audits the claim and adds the storage price to the subscription", async () => {
    mockSetNamespace.mockResolvedValue({ namespace, change: "claimed" });
    const res = await buildApp(["git:admin"]).request("/namespace", put({ slug: "acme" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(namespace);
    expect(mockSetNamespace).toHaveBeenCalledWith("org-1", "acme", expect.any(String), {
      allowReserved: false,
    });
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "git.namespace.claim",
        metadata: { slug: "acme", from: null },
      }),
    );
    expect(mockEnsurePrice).toHaveBeenCalledWith("org-1");
  });

  it("lets a platform admin, and nobody else, take a reserved name", async () => {
    mockSetNamespace.mockResolvedValue({ namespace, change: "claimed" });
    const before = process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
    try {
      process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "test@example.com";
      await buildApp(["git:admin"]).request("/namespace", put({ slug: "Infrawrench" }));
      expect(mockSetNamespace).toHaveBeenLastCalledWith(
        "org-1",
        "Infrawrench",
        expect.any(String),
        {
          allowReserved: true,
        },
      );
      const overviewRes = await buildApp(["git:read"]).request("/");
      expect(await overviewRes.json()).toMatchObject({ reservedNamesAllowed: true });

      process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = "someone@else.com";
      await buildApp(["git:admin"]).request("/namespace", put({ slug: "Infrawrench" }));
      expect(mockSetNamespace).toHaveBeenLastCalledWith(
        "org-1",
        "Infrawrench",
        expect.any(String),
        {
          allowReserved: false,
        },
      );
      const other = await buildApp(["git:read"]).request("/");
      expect(await other.json()).toMatchObject({ reservedNamesAllowed: false });
    } finally {
      if (before === undefined) delete process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"];
      else process.env["INFRAWRENCH_PLATFORM_ADMIN_EMAILS"] = before;
    }
  });

  it("audits a rename with the old name, and touches no subscription", async () => {
    mockSetNamespace.mockResolvedValue({ namespace, change: "renamed", from: "old" });
    await buildApp(["git:admin"]).request("/namespace", put({ slug: "acme" }));
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "git.namespace.rename",
        metadata: { slug: "acme", from: "old" },
      }),
    );
    expect(mockEnsurePrice).not.toHaveBeenCalled();
  });

  it("audits nothing when the name is the one it has", async () => {
    mockSetNamespace.mockResolvedValue({ namespace, change: "none" });
    await buildApp(["git:admin"]).request("/namespace", put({ slug: "acme" }));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("answers a taken name 409 and a name that breaks the rules 400, in the forge's words", async () => {
    mockSetNamespace.mockRejectedValueOnce(
      new GitForgeError(409, "namespace_taken", "That name is taken"),
    );
    const taken = await buildApp(["git:admin"]).request("/namespace", put({ slug: "acme" }));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "That name is taken" });

    mockSetNamespace.mockRejectedValueOnce(
      new GitForgeError(400, "name_invalid", "That name is reserved"),
    );
    const reserved = await buildApp(["git:admin"]).request("/namespace", put({ slug: "api" }));
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toEqual({ error: "That name is reserved" });
  });

  it("refuses an empty or over-long name before the store is asked", async () => {
    const app = buildApp(["git:admin"]);
    expect((await app.request("/namespace", put({ slug: "" }))).status).toBe(400);
    expect((await app.request("/namespace", put({ slug: "a".repeat(40) }))).status).toBe(400);
    expect(mockSetNamespace).not.toHaveBeenCalled();
  });
});

describe("PUT /git/settings", () => {
  it("needs git:admin and takes only the two visibilities", async () => {
    expect(
      (await buildApp(["git:write"]).request("/settings", put({ defaultVisibility: "public" })))
        .status,
    ).toBe(403);
    const res = await buildApp(["git:admin"]).request(
      "/settings",
      put({ defaultVisibility: "internal" }),
    );
    expect(res.status).toBe(400);
    expect(mockSetVisibility).not.toHaveBeenCalled();
  });

  it("saves and audits the default", async () => {
    mockSetVisibility.mockResolvedValue({ ...namespace, defaultVisibility: "public" });
    const res = await buildApp(["git:admin"]).request(
      "/settings",
      put({ defaultVisibility: "public" }),
    );
    expect(res.status).toBe(200);
    expect(mockSetVisibility).toHaveBeenCalledWith("org-1", "public");
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "git.settings.update",
        metadata: { defaultVisibility: "public" },
      }),
    );
  });

  it("answers 404 until a namespace is claimed", async () => {
    mockSetVisibility.mockRejectedValueOnce(
      new GitForgeError(404, "namespace_required", "Claim a namespace first"),
    );
    const res = await buildApp(["git:admin"]).request(
      "/settings",
      put({ defaultVisibility: "public" }),
    );
    expect(res.status).toBe(404);
  });
});
