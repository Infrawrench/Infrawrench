import { describe, it, expect, vi } from "vitest";
import {
  listAllEmailRoutingRules,
  createEmailRoutingRule,
  editEmailRoutingRule,
} from "../clients/email-routing-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const RULE = {
  tag: "r1",
  name: "Forward support",
  enabled: true,
  priority: 0,
  matchers: [{ type: "literal", field: "to", value: "support@a.com" }],
  actions: [{ type: "forward", value: ["dest@b.com"] }],
};

function emailApi(over: Record<string, unknown> = {}) {
  const rules = {
    list: vi.fn(() => asyncIter([RULE])),
    get: vi.fn(async () => RULE),
    create: vi.fn(async () => RULE),
    update: vi.fn(async () => RULE),
  };
  return makeApi({ cf: { emailRouting: { rules } }, ...over });
}

describe("email-routing-client", () => {
  it("listAllEmailRoutingRules maps matchers/actions", async () => {
    const api = emailApi();
    const out = await listAllEmailRoutingRules(api, "acct");
    expect(out[0].id).toBe("acct:email-routing-rule:z1/r1");
    expect(out[0].parentResourceId).toBe("acct:zone:z1");
    expect(out[0].fields.matchers).toBe("literal:to=support@a.com");
    expect(out[0].fields.actions).toBe("forward: dest@b.com");
  });

  it("createEmailRoutingRule builds a forward action", async () => {
    const api = emailApi();
    await createEmailRoutingRule(
      api,
      "acct",
      { name: "F", matcherValue: "support@a.com", actionValue: "dest@b.com" },
      "z1",
    );
    expect(api.cf.emailRouting.rules.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        matchers: [{ type: "literal", field: "to", value: "support@a.com" }],
        actions: [{ type: "forward", value: ["dest@b.com"] }],
      }),
    );
  });

  it("createEmailRoutingRule omits value for a drop action", async () => {
    const api = emailApi();
    await createEmailRoutingRule(api, "acct", { name: "D", actionType: "drop" }, "z1");
    const call = (api.cf.emailRouting.rules.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.actions).toEqual([{ type: "drop" }]);
  });

  it("createEmailRoutingRule throws without a zone", async () => {
    await expect(createEmailRoutingRule(emailApi(), "acct", {}, "")).rejects.toThrow(
      /zoneId is required/,
    );
  });

  it("editEmailRoutingRule preserves matchers/actions from current", async () => {
    const api = emailApi();
    await editEmailRoutingRule(api, "acct", "z1/r1", { name: "Edited", enabled: "false" });
    expect(api.cf.emailRouting.rules.update).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ name: "Edited", enabled: false, matchers: RULE.matchers }),
    );
  });

  it("editEmailRoutingRule throws on a malformed id", async () => {
    await expect(editEmailRoutingRule(emailApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid email routing rule ID",
    );
  });
});
