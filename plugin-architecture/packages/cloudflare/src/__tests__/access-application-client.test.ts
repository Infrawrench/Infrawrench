import { describe, it, expect, vi } from "vitest";
import {
  listAccessApplications,
  createAccessApplication,
  editAccessApplication,
  deleteAccessApplication,
} from "../clients/access-application-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const APP = {
  id: "app1",
  name: "Dashboard",
  domain: "dash.a.com",
  type: "self_hosted",
  session_duration: "24h",
  aud: "aud-token",
  created_at: "2020-01-01T00:00:00Z",
  updated_at: "2020-01-02T00:00:00Z",
};

function accessApi(over: Record<string, unknown> = {}) {
  const applications = {
    list: vi.fn(() => asyncIter([APP])),
    create: vi.fn(async () => APP),
    update: vi.fn(async () => APP),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { zeroTrust: { access: { applications } } }, ...over });
}

describe("access-application-client", () => {
  it("listAccessApplications maps an app", async () => {
    const api = accessApi();
    const out = await listAccessApplications(api, "acct");
    expect(out[0]!.id).toBe("acct:access-application:app1");
    expect(out[0]!.displayName).toBe("Dashboard");
    expect(out[0]!.fields.domain).toBe("dash.a.com");
    expect(out[0]!.resolvedOutputs?.aud).toBe("aud-token");
  });

  it("createAccessApplication builds a self_hosted default body", async () => {
    const api = accessApi();
    await createAccessApplication(api, "acct", { name: "Dashboard", domain: "dash.a.com" });
    expect(api.cf.zeroTrust.access.applications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "acct-cf",
        name: "Dashboard",
        domain: "dash.a.com",
        type: "self_hosted",
      }),
    );
  });

  it("editAccessApplication includes session_duration when supplied", async () => {
    const api = accessApi();
    await editAccessApplication(api, "acct", "app1", {
      name: "New",
      domain: "dash.a.com",
      type: "self_hosted",
      sessionDuration: "1h",
    });
    expect(api.cf.zeroTrust.access.applications.update).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ name: "New", session_duration: "1h" }),
    );
  });

  it("deleteAccessApplication calls delete", async () => {
    const api = accessApi();
    await deleteAccessApplication(api, "app1");
    expect(api.cf.zeroTrust.access.applications.delete).toHaveBeenCalledWith("app1", {
      account_id: "acct-cf",
    });
  });
});
