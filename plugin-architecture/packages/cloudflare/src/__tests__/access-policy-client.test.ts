import { describe, it, expect, vi } from "vitest";
import {
  listAllAccessPolicies,
  createAccessPolicy,
  editAccessPolicy,
} from "../clients/access-policy-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const POLICY = {
  id: "pol1",
  name: "Allow staff",
  decision: "allow",
  precedence: 1,
  include: [{ email_domain: { domain: "a.com" } }],
  exclude: [{ ip: { ip: "1.2.3.4" } }],
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-02T00:00:00Z",
};

function policyApi(over: Record<string, unknown> = {}) {
  const policies = {
    list: vi.fn(() => asyncIter([POLICY])),
    get: vi.fn(async () => POLICY),
    create: vi.fn(async () => POLICY),
    update: vi.fn(async () => POLICY),
  };
  const applications = { list: vi.fn(() => asyncIter([{ id: "app1" }])), policies };
  return makeApi({ cf: { zeroTrust: { access: { applications } } }, ...over });
}

describe("access-policy-client", () => {
  it("listAllAccessPolicies maps policies and formats rules", async () => {
    const api = policyApi();
    const out = await listAllAccessPolicies(api, "acct");
    expect(out[0]!.id).toBe("acct:access-policy:app1/pol1");
    expect(out[0]!.parentResourceId).toBe("acct:access-application:app1");
    expect(out[0]!.fields.decision).toBe("allow");
    expect(out[0]!.fields.includeRules).toBe("email_domain:a.com");
    expect(out[0]!.fields.excludeRules).toBe("ip:1.2.3.4");
  });

  function policiesFailing(failure: (appId: string) => unknown) {
    return policyApi({
      cf: {
        zeroTrust: {
          access: {
            applications: {
              list: vi.fn(() => asyncIter([{ id: "app1" }, { id: "app2" }])),
              policies: {
                list: vi.fn((appId: string) => {
                  const err = failure(appId);
                  if (err) throw err;
                  return asyncIter([POLICY]);
                }),
              },
            },
          },
        },
      },
    });
  }

  it("listAllAccessPolicies reads an app with no policies to read as none", async () => {
    const api = policiesFailing((appId) => (appId === "app2" ? { status: 404 } : null));
    const out = await listAllAccessPolicies(api, "acct");
    expect(out.map((p) => p.id)).toEqual(["acct:access-policy:app1/pol1"]);
  });

  it.each([
    ["a 429", { status: 429 }],
    ["a 500", { status: 500 }],
    ["a dropped connection", new Error("Connection error.")],
  ])("listAllAccessPolicies fails on %s for one app, so its rows stay", async (_what, err) => {
    const api = policiesFailing((appId) => (appId === "app2" ? err : null));
    await expect(listAllAccessPolicies(api, "acct")).rejects.toBe(err);
  });

  it("listAllAccessPolicies says so when the token can read no app's policies", async () => {
    const api = policiesFailing(() => ({ status: 403 }));
    await expect(listAllAccessPolicies(api, "acct")).rejects.toThrow(
      /doesn't have the Account · Access: Apps and Policies:Read permission/,
    );
  });

  it("createAccessPolicy builds an email-domain include rule", async () => {
    const api = policyApi();
    await createAccessPolicy(api, "acct", { name: "P", includeEmail: "@a.com" }, "app1");
    expect(api.cf.zeroTrust.access.applications.policies.create).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({
        name: "P",
        decision: "allow",
        include: [{ email_domain: { domain: "a.com" } }],
      }),
    );
  });

  it("createAccessPolicy builds an exact-email include rule", async () => {
    const api = policyApi();
    await createAccessPolicy(api, "acct", { name: "P", includeEmail: "me@a.com" }, "app1");
    expect(api.cf.zeroTrust.access.applications.policies.create).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ include: [{ email: { email: "me@a.com" } }] }),
    );
  });

  it("createAccessPolicy splits a comma-separated list into one rule per entry", async () => {
    const api = policyApi();
    await createAccessPolicy(
      api,
      "acct",
      { name: "P", includeEmail: "me@a.com, @a.com , you@b.com," },
      "app1",
    );
    expect(api.cf.zeroTrust.access.applications.policies.create).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({
        include: [
          { email: { email: "me@a.com" } },
          { email_domain: { domain: "a.com" } },
          { email: { email: "you@b.com" } },
        ],
      }),
    );
  });

  it("createAccessPolicy throws when no include email is given", async () => {
    await expect(
      createAccessPolicy(policyApi(), "acct", { name: "P", includeEmail: " , " }, "app1"),
    ).rejects.toThrow(/at least one include email/);
  });

  it("createAccessPolicy throws without an app id", async () => {
    await expect(createAccessPolicy(policyApi(), "acct", {}, "")).rejects.toThrow(
      /appId is required/,
    );
  });

  it("editAccessPolicy preserves include/exclude and edits precedence", async () => {
    const api = policyApi();
    await editAccessPolicy(api, "acct", "app1/pol1", { name: "Edited", precedence: "5" });
    expect(api.cf.zeroTrust.access.applications.policies.update).toHaveBeenCalledWith(
      "app1",
      "pol1",
      expect.objectContaining({ name: "Edited", precedence: 5, include: POLICY.include }),
    );
  });

  it("editAccessPolicy throws on a malformed id", async () => {
    await expect(editAccessPolicy(policyApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid access policy ID",
    );
  });
});
