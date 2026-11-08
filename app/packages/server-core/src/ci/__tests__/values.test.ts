import { beforeEach, describe, expect, it, vi } from "vitest";

// The account lookup and the proxy are stubbed: these tests pin which owner
// key and path a scope resolves to, and what is refused before any request.
const mockAccount = vi.fn<() => Array<{ accountLogin: string }>>();
vi.mock("../../db/client.js", () => {
  const limit = () => Promise.resolve(mockAccount());
  const where = () => ({ limit });
  const from = () => ({ where });
  return { db: { select: () => ({ from }) } };
});
const mockProxy = vi.fn();
vi.mock("../proxy.js", async (orig) => ({
  ...(await orig<typeof import("../proxy.js")>()),
  proxyJson: (...a: unknown[]) => mockProxy(...a),
}));

const { CiProxyError } = await import("../proxy.js");
const { CiInputError } = await import("../runs");
const { deleteCiValue, listCiValues, setCiValue } = await import("../values");

beforeEach(() => {
  vi.clearAllMocks();
  mockAccount.mockReturnValue([{ accountLogin: "Acme" }]);
});

describe("CI secrets and variables", () => {
  it("lists secret names without values, and variables with them", async () => {
    mockProxy.mockImplementation(async (path: string) =>
      path.endsWith("/secrets")
        ? { secrets: [{ name: "NPM_TOKEN", "updated-at": 1_700_000_000 }] }
        : { vars: [{ name: "REGION", value: "eu", "updated-at": 1_700_000_000 }] },
    );
    const values = await listCiValues("org-1", 7, "Web");
    expect(mockProxy).toHaveBeenCalledWith("/v1/orgs/github.com-acme/repos/web/secrets");
    expect(values.secrets).toEqual([{ name: "NPM_TOKEN", updatedAt: "2023-11-14T22:13:20.000Z" }]);
    expect(values.variables[0]).toMatchObject({ name: "REGION", value: "eu" });
  });

  it("refuses an account this organization does not run CI for, before asking the proxy", async () => {
    mockAccount.mockReturnValue([]);
    await expect(setCiValue("org-2", 7, null, "secrets", "NPM_TOKEN", "x")).rejects.toBeInstanceOf(
      CiInputError,
    );
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("refuses names and repositories that could escape the scope", async () => {
    await expect(setCiValue("org-1", 7, null, "secrets", "../x", "v")).rejects.toMatchObject({
      status: 400,
    });
    await expect(deleteCiValue("org-1", 7, "../other", "variables", "A")).rejects.toMatchObject({
      status: 400,
    });
    expect(mockProxy).not.toHaveBeenCalled();
  });

  it("writes to the account's scope and maps the proxy's refusals", async () => {
    mockProxy.mockResolvedValueOnce({});
    await setCiValue("org-1", 7, null, "variables", "REGION", "eu");
    expect(mockProxy).toHaveBeenCalledWith("/v1/orgs/github.com-acme/vars/REGION", {
      method: "PUT",
      body: JSON.stringify({ value: "eu" }),
    });
    mockProxy.mockRejectedValueOnce(new CiProxyError("set SECRETS_KEY", 503));
    await expect(setCiValue("org-1", 7, null, "secrets", "A", "b")).rejects.toMatchObject({
      status: 409,
    });
  });
});
