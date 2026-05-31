import { describe, it, expect, vi } from "vitest";
import {
  listWorkers,
  createWorker,
  deleteWorker,
  getWorkerManifest,
  applyWorkerManifest,
} from "../clients/worker-client.js";
import { makeApi, asyncIter } from "./_helpers.js";

function workerApi(over: Record<string, unknown> = {}) {
  const scripts = {
    list: vi.fn(() =>
      asyncIter([
        { id: "w1", created_on: "2020", modified_on: "2021", compatibility_date: "2024-01-01" },
      ]),
    ),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    scriptAndVersionSettings: {
      get: vi.fn(async () => ({
        logpush: true,
        observability: { enabled: true, head_sampling_rate: 0.5 },
        placement: { mode: "smart" },
        tags: ["a", "b"],
        usage_model: "standard",
        tail_consumers: [{ service: "log-svc", environment: "prod" }],
        compatibility_date: "2024-01-01",
        compatibility_flags: ["nodejs_compat"],
        limits: { cpu_ms: 50 },
        bindings: [{ name: "KV" }],
      })),
    },
    subdomain: {
      get: vi.fn(async () => ({ enabled: true })),
      create: vi.fn(async () => undefined),
    },
    schedules: {
      get: vi.fn(async () => ({ schedules: [{ cron: "*/5 * * * *" }] })),
      update: vi.fn(async () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({
        logpush: false,
        tags: [],
        observability: { enabled: false, head_sampling_rate: null },
      })),
      edit: vi.fn(async () => undefined),
    },
  };
  return makeApi({ cf: { workers: { scripts } } }, ...[over].filter(Boolean));
}

describe("worker-client", () => {
  it("listWorkers maps scripts", async () => {
    const api = workerApi();
    const out = await listWorkers(api, "acct");
    expect(out[0].id).toBe("acct:worker:w1");
    expect(out[0].fields.compatibilityDate).toBe("2024-01-01");
    expect(out[0].resolvedOutputs.workerName).toBe("w1");
  });

  it("createWorker uploads the script and returns the instance", async () => {
    const api = workerApi();
    const out = await createWorker(api, "acct", {
      name: "w2",
      script: "export default {}",
      compatibilityDate: "2024-02-02",
    });
    expect(api.cf.workers.scripts.update).toHaveBeenCalledWith(
      "w2",
      expect.objectContaining({ account_id: "acct-cf" }),
    );
    expect(out.externalId).toBe("w2");
    expect(out.fields.compatibilityDate).toBe("2024-02-02");
  });

  it("deleteWorker calls SDK delete", async () => {
    const api = workerApi();
    await deleteWorker(api, "w1");
    expect(api.cf.workers.scripts.delete).toHaveBeenCalledWith("w1", { account_id: "acct-cf" });
  });

  it("getWorkerManifest gathers settings, subdomain, and crons", async () => {
    const api = workerApi();
    const json = JSON.parse(await getWorkerManifest(api, "w1")) as {
      settings: Array<{ id: string; value: string }>;
    };
    const byId = Object.fromEntries(json.settings.map((s) => [s.id, s.value]));
    expect(byId["subdomain_enabled"]).toBe("on");
    expect(byId["logpush"]).toBe("on");
    expect(byId["cron_triggers"]).toBe("*/5 * * * *");
    expect(byId["tags"]).toBe("a, b");
  });

  it("getWorkerManifest tolerates subdomain/cron lookup failures", async () => {
    const api = workerApi();
    (api.cf.workers.scripts.subdomain.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no scope"),
    );
    (api.cf.workers.scripts.schedules.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no scope"),
    );
    const json = JSON.parse(await getWorkerManifest(api, "w1")) as {
      settings: Array<{ id: string; value: string }>;
    };
    const byId = Object.fromEntries(json.settings.map((s) => [s.id, s.value]));
    expect(byId["subdomain_enabled"]).toBe("off");
    expect(byId["cron_triggers"]).toBe("");
  });

  it("applyWorkerManifest routes changes to the right endpoints", async () => {
    const api = workerApi();
    await applyWorkerManifest(
      api,
      "w1",
      JSON.stringify([
        { id: "logpush", value: "on" },
        { id: "subdomain_enabled", value: "on" },
        { id: "cron_triggers", value: "*/10 * * * *" },
      ]),
    );
    expect(api.cf.workers.scripts.settings.edit).toHaveBeenCalled();
    expect(api.cf.workers.scripts.subdomain.create).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ enabled: true }),
    );
    expect(api.cf.workers.scripts.schedules.update).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ body: [{ cron: "*/10 * * * *" }] }),
    );
  });

  it("applyWorkerManifest skips the settings edit when no script field changed", async () => {
    const api = workerApi();
    await applyWorkerManifest(
      api,
      "w1",
      JSON.stringify([{ id: "subdomain_enabled", value: "off" }]),
    );
    expect(api.cf.workers.scripts.settings.edit).not.toHaveBeenCalled();
  });

  it("applyWorkerManifest throws on a non-array payload", async () => {
    await expect(applyWorkerManifest(workerApi(), "w1", JSON.stringify({}))).rejects.toThrow(
      /must be an array/,
    );
  });
});
