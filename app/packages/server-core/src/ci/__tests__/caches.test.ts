import { beforeEach, describe, expect, it, vi } from "vitest";

// The account lookup and the proxy are stubbed: these tests pin which owner
// and repository a request names, and what is refused before any request.
const mockAccounts = vi.fn<() => Array<{ installationId?: number; accountLogin: string }>>();
vi.mock("../../db/client.js", () => {
  const rows = () => Promise.resolve(mockAccounts());
  const where = () => ({ limit: rows, orderBy: rows });
  const from = () => ({ where });
  return { db: { select: () => ({ from }) } };
});
const mockProxy = vi.fn();
vi.mock("../proxy.js", async (orig) => ({
  ...(await orig<typeof import("../proxy.js")>()),
  proxyJson: (...a: unknown[]) => mockProxy(...a),
}));

const { CiProxyError } = await import("../proxy.js");
const { clearCiCache, listCiCaches } = await import("../caches");

beforeEach(() => {
  vi.clearAllMocks();
  mockAccounts.mockReturnValue([{ installationId: 7, accountLogin: "Acme" }]);
});

describe("CI caches", () => {
  it("lists each account's caches per repository, largest first", async () => {
    mockProxy.mockResolvedValue({
      used_bytes: 300,
      quota_bytes: 1000,
      repos: { api: { bytes: 100, entries: 2 }, web: { bytes: 200, entries: 5 } },
    });
    const caches = await listCiCaches("org-1");
    expect(mockProxy).toHaveBeenCalledWith("/v1/storage/github.com-acme");
    expect(caches.accounts).toEqual([
      {
        installationId: 7,
        accountLogin: "Acme",
        usedBytes: 300,
        quotaBytes: 1000,
        repos: [
          { repo: "web", bytes: 200, entries: 5 },
          { repo: "api", bytes: 100, entries: 2 },
        ],
        error: null,
      },
    ]);
  });

  it("keeps listing the other accounts when the runners cannot answer for one", async () => {
    mockAccounts.mockReturnValue([
      { installationId: 7, accountLogin: "acme" },
      { installationId: 8, accountLogin: "beta" },
    ]);
    mockProxy.mockImplementation(async (path: string) => {
      if (path.endsWith("acme")) throw new CiProxyError("no runner answered", 503);
      return { used_bytes: 0, repos: {} };
    });
    const caches = await listCiCaches("org-1");
    expect(caches.accounts[0]).toMatchObject({ accountLogin: "acme", error: "no runner answered" });
    expect(caches.accounts[1]).toMatchObject({ accountLogin: "beta", error: null, repos: [] });
  });

  it("clears one repository of an account the organization runs CI for", async () => {
    mockProxy.mockResolvedValue({ deleted_objects: 7, deleted_entries: 5, deleted_bytes: 4096 });
    const cleared = await clearCiCache("org-1", 7, "Web");
    expect(mockProxy).toHaveBeenCalledWith("/v1/storage/github.com-acme/web", {
      method: "DELETE",
    });
    expect(cleared).toEqual({
      installationId: 7,
      repo: "web",
      deletedEntries: 5,
      deletedBytes: 4096,
    });
  });

  it("refuses another organization's account and names that could escape, before asking", async () => {
    await expect(clearCiCache("org-1", 7, "../other")).rejects.toMatchObject({ status: 400 });
    await expect(clearCiCache("org-1", 7, "a/b")).rejects.toMatchObject({ status: 400 });
    mockAccounts.mockReturnValue([]);
    await expect(clearCiCache("org-2", 7, "web")).rejects.toMatchObject({ status: 404 });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("says so when the runners cannot clear caches", async () => {
    mockProxy.mockRejectedValueOnce(new CiProxyError("no route DELETE", 404));
    await expect(clearCiCache("org-1", 7, "web")).rejects.toMatchObject({
      status: 409,
      message: "The CI runners cannot clear caches yet.",
    });
    mockProxy.mockRejectedValueOnce(new CiProxyError("no runner answered", 503));
    await expect(clearCiCache("org-1", 7, "web")).rejects.toMatchObject({ status: 409 });
  });
});
