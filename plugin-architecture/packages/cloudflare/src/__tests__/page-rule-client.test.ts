import { describe, it, expect, vi } from "vitest";
import {
  listAllPageRules,
  createPageRule,
  editPageRule,
  deletePageRule,
} from "../clients/page-rule-client.js";
import { makeApi } from "./_helpers.js";

const RULE = {
  id: "pr1",
  targets: [{ target: "url", constraint: { operator: "matches", value: "a.com/*" } }],
  actions: [{ id: "always_use_https" }],
  status: "active",
  priority: 1,
  created_on: "2020-01-01T00:00:00Z",
  modified_on: "2020-01-02T00:00:00Z",
};

function prApi(over: Record<string, unknown> = {}) {
  const pageRules = {
    list: vi.fn(async () => [RULE]),
    get: vi.fn(async () => RULE),
    create: vi.fn(async () => RULE),
    update: vi.fn(async () => RULE),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { pageRules }, ...over });
}

describe("page-rule-client", () => {
  it("listAllPageRules maps targets/actions", async () => {
    const api = prApi();
    const out = await listAllPageRules(api, "acct");
    expect(out[0].id).toBe("acct:page-rule:z1/pr1");
    expect(out[0].fields.targets).toBe("a.com/*");
    expect(out[0].fields.actions).toBe("always_use_https");
  });

  it("createPageRule builds a url-matches target", async () => {
    const api = prApi();
    await createPageRule(api, "acct", { urlPattern: "a.com/*", action: "always_use_https" }, "z1");
    const call = (api.cf.pageRules.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.targets[0].constraint.value).toBe("a.com/*");
    expect(call.actions[0].id).toBe("always_use_https");
  });

  it("createPageRule throws without a zone", async () => {
    await expect(createPageRule(prApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editPageRule preserves targets/actions from current", async () => {
    const api = prApi();
    await editPageRule(api, "acct", "z1/pr1", { status: "disabled", priority: "3" });
    expect(api.cf.pageRules.update).toHaveBeenCalledWith(
      "pr1",
      expect.objectContaining({ status: "disabled", priority: 3, targets: RULE.targets }),
    );
  });

  it("editPageRule throws on a malformed id", async () => {
    await expect(editPageRule(prApi(), "acct", "bad", {})).rejects.toThrow("Invalid page rule ID");
  });

  it("deletePageRule calls delete", async () => {
    const api = prApi();
    await deletePageRule(api, "z1/pr1");
    expect(api.cf.pageRules.delete).toHaveBeenCalledWith("pr1", { zone_id: "z1" });
  });

  it("deletePageRule throws on a malformed id", async () => {
    await expect(deletePageRule(prApi(), "bad")).rejects.toThrow("Invalid page rule ID");
  });
});
