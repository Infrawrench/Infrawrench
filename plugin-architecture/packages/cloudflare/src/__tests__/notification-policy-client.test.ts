import { describe, it, expect, vi } from "vitest";
import {
  listNotificationPolicies,
  createNotificationPolicy,
  editNotificationPolicy,
  deleteNotificationPolicy,
} from "../clients/notification-policy-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const POLICY = {
  id: "np1",
  name: "SSL expiry",
  alert_type: "universal_ssl_event_type",
  enabled: true,
  description: "alerts",
  mechanisms: {
    email: [{ id: "ops@a.com" }],
    webhooks: [{ id: "w1" }],
    pagerduty: [{ id: "pd1" }],
  },
  created: "2020-01-01T00:00:00Z",
  modified: "2020-01-02T00:00:00Z",
};

function npApi(over: Record<string, unknown> = {}) {
  const policies = {
    list: vi.fn(() => asyncIter([POLICY])),
    create: vi.fn(async () => POLICY),
    update: vi.fn(async () => POLICY),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { alerting: { policies } }, ...over });
}

describe("notification-policy-client", () => {
  it("listNotificationPolicies maps and summarizes mechanisms", async () => {
    const api = npApi();
    const out = await listNotificationPolicies(api, "acct");
    expect(out[0].id).toBe("acct:notification-policy:np1");
    expect(out[0].fields.alertType).toBe("universal_ssl_event_type");
    expect(out[0].fields.mechanisms).toBe("ops@a.com; 1 webhook(s); 1 PagerDuty");
  });

  it("listNotificationPolicies surfaces a permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        alerting: {
          policies: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listNotificationPolicies(api, "acct")).rejects.toThrow(
      /Notifications:Read permission/,
    );
  });

  it("createNotificationPolicy builds email mechanisms", async () => {
    const api = npApi();
    await createNotificationPolicy(api, "acct", {
      name: "SSL expiry",
      alertType: "universal_ssl_event_type",
      email: "ops@a.com, sec@a.com",
    });
    expect(api.cf.alerting.policies.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "SSL expiry",
        mechanisms: { email: [{ id: "ops@a.com" }, { id: "sec@a.com" }] },
      }),
    );
  });

  it("editNotificationPolicy sends only supplied scalars", async () => {
    const api = npApi();
    await editNotificationPolicy(api, "acct", "np1", { enabled: "false", email: "new@a.com" });
    expect(api.cf.alerting.policies.update).toHaveBeenCalledWith(
      "np1",
      expect.objectContaining({ enabled: false, mechanisms: { email: [{ id: "new@a.com" }] } }),
    );
  });

  it("deleteNotificationPolicy calls delete", async () => {
    const api = npApi();
    await deleteNotificationPolicy(api, "np1");
    expect(api.cf.alerting.policies.delete).toHaveBeenCalledWith("np1", { account_id: "acct-cf" });
  });
});
