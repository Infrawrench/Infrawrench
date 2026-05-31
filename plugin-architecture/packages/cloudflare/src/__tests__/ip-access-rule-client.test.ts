import { describe, it, expect, vi } from "vitest";
import {
  listAllIpAccessRules,
  createIpAccessRule,
  editIpAccessRule,
  deleteIpAccessRule,
} from "../clients/ip-access-rule-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const RULE = {
  id: "ar1",
  mode: "block",
  notes: "bad actor",
  configuration: { target: "ip", value: "1.2.3.4" },
};

function ipApi(over: Record<string, unknown> = {}) {
  const accessRules = {
    list: vi.fn(() => asyncIter([RULE])),
    create: vi.fn(async () => RULE),
    edit: vi.fn(async () => RULE),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { firewall: { accessRules } }, ...over });
}

describe("ip-access-rule-client", () => {
  it("listAllIpAccessRules maps rules", async () => {
    const api = ipApi();
    const out = await listAllIpAccessRules(api, "acct");
    expect(out[0]!.id).toBe("acct:ip-access-rule:z1/ar1");
    expect(out[0]!.displayName).toBe("bad actor");
    expect(out[0]!.fields).toMatchObject({ mode: "block", target: "ip", value: "1.2.3.4" });
  });

  it("createIpAccessRule sends mode/target/value/notes", async () => {
    const api = ipApi();
    await createIpAccessRule(
      api,
      "acct",
      { mode: "challenge", target: "country", value: "RU", notes: "geo" },
      "z1",
    );
    expect(api.cf.firewall.accessRules.create).toHaveBeenCalledWith(
      expect.objectContaining({
        zone_id: "z1",
        mode: "challenge",
        configuration: { target: "country", value: "RU" },
        notes: "geo",
      }),
    );
  });

  it("createIpAccessRule throws without a zone", async () => {
    await expect(createIpAccessRule(ipApi(), "acct", {}, "")).rejects.toThrow(/zoneId is required/);
  });

  it("editIpAccessRule edits mode + notes", async () => {
    const api = ipApi();
    await editIpAccessRule(api, "acct", "z1/ar1", { mode: "whitelist", notes: "ok" });
    expect(api.cf.firewall.accessRules.edit).toHaveBeenCalledWith(
      "ar1",
      expect.objectContaining({ zone_id: "z1", mode: "whitelist", notes: "ok" }),
    );
  });

  it("editIpAccessRule throws on a malformed id", async () => {
    await expect(editIpAccessRule(ipApi(), "acct", "bad", {})).rejects.toThrow(
      "Invalid IP access rule ID",
    );
  });

  it("deleteIpAccessRule calls delete", async () => {
    const api = ipApi();
    await deleteIpAccessRule(api, "z1/ar1");
    expect(api.cf.firewall.accessRules.delete).toHaveBeenCalledWith("ar1", { zone_id: "z1" });
  });

  it("deleteIpAccessRule throws on a malformed id", async () => {
    await expect(deleteIpAccessRule(ipApi(), "bad")).rejects.toThrow("Invalid IP access rule ID");
  });
});
