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
    expect(out[0].id).toBe("acct:access-policy:app1/pol1");
    expect(out[0].parentResourceId).toBe("acct:access-application:app1");
    expect(out[0].fields.decision).toBe("allow");
    expect(out[0].fields.includeRules).toBe("email_domain:a.com");
    expect(out[0].fields.excludeRules).toBe("ip:1.2.3.4");
  });

  it("listAllAccessPolicies skips apps where policies throw", async () => {
    const api = policyApi({
      cf: {
        zeroTrust: {
          access: {
            applications: {
              list: vi.fn(() => asyncIter([{ id: "app1" }])),
              policies: {
                list: vi.fn(() => {
                  throw new Error("no");
                }),
              },
            },
          },
        },
      },
    });
    expect(await listAllAccessPolicies(api, "acct")).toEqual([]);
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
