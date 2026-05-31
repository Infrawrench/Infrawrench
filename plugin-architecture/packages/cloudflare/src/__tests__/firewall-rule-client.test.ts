import { describe, it, expect, vi } from "vitest";
import {
  listAllFirewallRules,
  createFirewallRule,
  editFirewallRule,
  deleteFirewallRule,
} from "../clients/firewall-rule-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const RULE = {
  id: "rule1",
  description: "Block bots",
  expression: "cf.client.bot",
  action: "block",
  enabled: true,
  priority: 1,
};
const RULESET = { id: "rs1", phase: "http_request_firewall_custom", rules: [RULE] };

function fwApi(over: Record<string, unknown> = {}) {
  const rulesets = {
    list: vi.fn(() => asyncIter([RULESET])),
    get: vi.fn(async () => RULESET),
    create: vi.fn(async () => RULESET),
    rules: {
      create: vi.fn(async () => RULESET),
      edit: vi.fn(async () => RULESET),
      delete: vi.fn(async () => undefined),
    },
  };
  return makeApi({ cf: { rulesets }, ...over });
}

describe("firewall-rule-client", () => {
  it("listAllFirewallRules reads the custom ruleset rules", async () => {
    const api = fwApi();
    const out = await listAllFirewallRules(api, "acct");
    expect(out[0].id).toBe("acct:firewall-rule:z1/rs1/rule1");
    expect(out[0].parentResourceId).toBe("acct:zone:z1");
    expect(out[0].fields.action).toBe("block");
    expect(out[0].fields.expression).toBe("cf.client.bot");
  });

  it("listAllFirewallRules returns empty when no custom ruleset", async () => {
    const api = fwApi({
      cf: { rulesets: { list: vi.fn(() => asyncIter([{ id: "x", phase: "other" }])) } },
    });
    expect(await listAllFirewallRules(api, "acct")).toEqual([]);
  });

  it("createFirewallRule appends to an existing ruleset", async () => {
    const api = fwApi();
    const out = await createFirewallRule(
      api,
      "acct",
      { description: "Block bots", expression: "cf.client.bot", action: "block" },
      "z1",
    );
    expect(api.cf.rulesets.rules.create).toHaveBeenCalledWith(
      "rs1",
      expect.objectContaining({ zone_id: "z1", action: "block" }),
    );
    expect(out.externalId).toBe("z1/rs1/rule1");
  });

  it("createFirewallRule creates the entrypoint ruleset when none exists", async () => {
    const api = fwApi({
      cf: {
        rulesets: {
          list: vi.fn(() => asyncIter([])),
          create: vi.fn(async () => ({ id: "rsNew", rules: [{ id: "ruleN" }] })),
          rules: { create: vi.fn() },
        },
      },
    });
    const out = await createFirewallRule(api, "acct", { expression: "x", action: "block" }, "z1");
    expect(api.cf.rulesets.create).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "http_request_firewall_custom", kind: "zone" }),
    );
    expect(out.externalId).toBe("z1/rsNew/ruleN");
  });

  it("createFirewallRule throws without a zone", async () => {
    await expect(createFirewallRule(fwApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editFirewallRule edits a rule in place", async () => {
    const api = fwApi();
    await editFirewallRule(api, "acct", "z1/rs1/rule1", {
      description: "x",
      expression: "y",
      action: "challenge",
    });
    expect(api.cf.rulesets.rules.edit).toHaveBeenCalledWith(
      "rs1",
      "rule1",
      expect.objectContaining({ zone_id: "z1", action: "challenge", enabled: true }),
    );
  });

  it("editFirewallRule throws on a malformed id", async () => {
    await expect(editFirewallRule(fwApi(), "acct", "z1/rs1", {})).rejects.toThrow(
      "Invalid firewall rule ID",
    );
  });

  it("deleteFirewallRule calls delete", async () => {
    const api = fwApi();
    await deleteFirewallRule(api, "z1/rs1/rule1");
    expect(api.cf.rulesets.rules.delete).toHaveBeenCalledWith("rs1", "rule1", { zone_id: "z1" });
  });

  it("deleteFirewallRule throws on a malformed id", async () => {
    await expect(deleteFirewallRule(fwApi(), "bad")).rejects.toThrow("Invalid firewall rule ID");
  });
});
