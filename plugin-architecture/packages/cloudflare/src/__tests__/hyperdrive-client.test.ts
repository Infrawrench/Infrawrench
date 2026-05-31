import { describe, it, expect, vi } from "vitest";
import {
  listHyperdrives,
  createHyperdrive,
  editHyperdrive,
  deleteHyperdrive,
} from "../clients/hyperdrive-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

const HD = {
  id: "hd1",
  name: "pg",
  origin: { host: "db.a.com", port: 5432, scheme: "postgres", database: "app", user: "u" },
  caching: { disabled: false },
};

function hdApi(over: Record<string, unknown> = {}) {
  const configs = {
    list: vi.fn(() => asyncIter([HD])),
    create: vi.fn(async () => HD),
    edit: vi.fn(async () => HD),
    delete: vi.fn(async () => undefined),
  };
  return makeApi({ cf: { hyperdrive: { configs } }, ...over });
}

describe("hyperdrive-client", () => {
  it("listHyperdrives maps a config", async () => {
    const api = hdApi();
    const out = await listHyperdrives(api, "acct");
    expect(out[0]!.id).toBe("acct:hyperdrive:hd1");
    expect(out[0]!.fields.originHost).toBe("db.a.com");
    expect(out[0]!.fields.originPort).toBe(5432);
    expect(out[0]!.resolvedOutputs?.hyperdriveId).toBe("hd1");
  });

  it("listHyperdrives surfaces a permission hint on a 403", async () => {
    const api = makeApi({
      cf: {
        hyperdrive: {
          configs: {
            list: vi.fn(() => {
              throw { status: 403 };
            }),
          },
        },
      },
    });
    await expect(listHyperdrives(api, "acct")).rejects.toThrow(/Hyperdrive:Read permission/);
  });

  it("createHyperdrive builds an origin from fields", async () => {
    const api = hdApi();
    await createHyperdrive(api, "acct", {
      name: "pg",
      host: "db.a.com",
      port: "5432",
      database: "app",
      user: "u",
      password: "secret",
    });
    const call = (api.cf.hyperdrive.configs.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.name).toBe("pg");
    expect(call.origin).toMatchObject({ host: "db.a.com", port: 5432, password: "secret" });
  });

  it("editHyperdrive toggles caching only when supplied", async () => {
    const api = hdApi();
    await editHyperdrive(api, "acct", "hd1", { cachingDisabled: "true" });
    expect(api.cf.hyperdrive.configs.edit).toHaveBeenCalledWith(
      "hd1",
      expect.objectContaining({ caching: { disabled: true } }),
    );
  });

  it("deleteHyperdrive calls delete", async () => {
    const api = hdApi();
    await deleteHyperdrive(api, "hd1");
    expect(api.cf.hyperdrive.configs.delete).toHaveBeenCalledWith("hd1", { account_id: "acct-cf" });
  });
});
