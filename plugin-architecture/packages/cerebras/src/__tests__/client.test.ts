import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";
import { CerebrasClient, parseVersionName } from "../client.js";
import { parsePrometheus } from "../prometheus.js";
import { parseStatusFeed } from "../status-feed.js";

const ACCOUNT = "acct";

function host(
  handler: (
    url: string,
    method: string,
    headers: Record<string, string>,
  ) => { status?: number; body?: unknown },
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }> = [];
  const http: HttpHostServices = {
    request: vi.fn(async (req) => {
      calls.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        ...(typeof req.body === "string" ? { body: req.body } : {}),
      });
      const res = handler(req.url, req.method, req.headers);
      return {
        status: res.status ?? 200,
        headers: {},
        body:
          res.body === undefined
            ? ""
            : typeof res.body === "string"
              ? res.body
              : JSON.stringify(res.body),
      };
    }),
  };
  return { http, calls };
}

describe("models", () => {
  it("joins the key's models with the public catalogue and converts prices per million", async () => {
    const { http, calls } = host((url) => {
      if (url === "https://api.cerebras.ai/v1/models")
        return { body: { data: [{ id: "gpt-oss-120b", owned_by: "OpenAI" }] } };
      if (url.endsWith("/public/v1/models")) {
        return {
          body: {
            data: [
              {
                id: "gpt-oss-120b",
                name: "OpenAI GPT OSS",
                pricing: { prompt: "0.00000035", completion: "0.00000075" },
                limits: { max_context_length: 131072 },
                capabilities: { tools: true, vision: false },
              },
            ],
          },
        };
      }
      throw new Error(url);
    });
    const [m] = await hostClient(new CerebrasClient({ apiKey: "csk-x" }, { http })).listResources(
      "cerebras-model",
      ACCOUNT,
    );
    expect(m?.fields["inputPricePerMillion"]).toBe(0.35);
    expect(m?.fields["outputPricePerMillion"]).toBe(0.75);
    expect(m?.fields["capabilities"]).toBe("tools");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer csk-x");
    // The public catalogue is called without credentials.
    expect(calls[1]?.headers["Authorization"]).toBeUndefined();
  });
});

describe("batches and files", () => {
  it("pages batches with the last id as the after cursor", async () => {
    const { http, calls } = host((url) => {
      if (!url.includes("after="))
        return { body: { data: [{ id: "batch_1", status: "in_progress" }], has_more: true } };
      return { body: { data: [{ id: "batch_2", status: "completed" }], has_more: false } };
    });
    const items = await hostClient(new CerebrasClient({ apiKey: "csk-x" }, { http })).listResources(
      "cerebras-batch",
      ACCOUNT,
    );
    expect(items.map((i) => i.externalId)).toEqual(["batch_1", "batch_2"]);
    expect(calls[1]?.url).toContain("after=batch_1");
  });

  it("cancels a batch with DELETE on the batch, as Cerebras documents (#1064)", async () => {
    const { http, calls } = host(() => ({ body: { id: "batch_1", status: "cancelling" } }));
    await hostClient(new CerebrasClient({ apiKey: "csk-x" }, { http })).invokeAction(
      "cerebras-batch",
      `${ACCOUNT}:cerebras-batch:batch_1`,
      "cancel",
      ACCOUNT,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.cerebras.ai/v1/batches/batch_1");
  });

  it("reads a Private Preview 403 as an empty list and keeps the status elsewhere", async () => {
    const { http } = host(() => ({ status: 403, body: { message: "not enabled" } }));
    const client = hostClient(new CerebrasClient({ apiKey: "csk-x" }, { http }));
    expect(await client.listResources("cerebras-file", ACCOUNT)).toEqual([]);
    await expect(client.listResources("cerebras-model", ACCOUNT)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("dedicated inference", () => {
  it("skips management listings without a management key", async () => {
    const { http, calls } = host(() => ({ body: {} }));
    const client = hostClient(new CerebrasClient({ apiKey: "csk-x" }, { http }));
    expect(await client.listResources("cerebras-endpoint", ACCOUNT)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("lists versions per architecture with the management key", async () => {
    const { http, calls } = host((url) => {
      if (url.endsWith("/orgs/acme/models"))
        return { body: { model_architectures: ["gpt-oss-120b"] } };
      return {
        body: {
          model_versions: [
            {
              name: "orgs/acme/models/gpt-oss-120b/versions/2",
              response: { version_aliases: ["prod"], sync_status: "done" },
            },
          ],
        },
      };
    });
    const client = hostClient(
      new CerebrasClient({ apiKey: "csk-x", managementKey: "mk", orgName: "acme" }, { http }),
    );
    const [v] = await client.listResources("cerebras-model-version", ACCOUNT);
    expect(v?.externalId).toBe("gpt-oss-120b/2");
    expect(v?.fields["aliases"]).toBe("prod");
    expect(calls[0]?.headers["Authorization"]).toBe("Bearer mk");
    expect(calls[0]?.url).toBe("https://api.cerebras.ai/management/v1/orgs/acme/models");
  });

  it("turns this endpoint's Prometheus samples into one-point series", async () => {
    const text = [
      "# HELP ttft_seconds x",
      'ttft_seconds{endpoint="acme-gpt",organization_id="org_1",statistic="p50"} 0.25',
      'ttft_seconds{endpoint="other",organization_id="org_1",statistic="p50"} 9',
      'requests_count_total{endpoint="acme-gpt",organization_id="org_1"} 12.0',
    ].join("\n");
    const { http, calls } = host(() => ({ body: text }));
    const client = hostClient(
      new CerebrasClient({ apiKey: "csk-x", organizationId: "org_1" }, { http }),
    );
    const series = await client.fetchMetricSeries(
      "cerebras-endpoint",
      `${ACCOUNT}:cerebras-endpoint:acme-gpt`,
      ACCOUNT,
    );
    expect(series.map((s) => [s.label, s.points[0]?.value, s.unit])).toEqual([
      ["ttft_seconds p50", 0.25, "s"],
      ["requests_count_total", 12, undefined],
    ]);
    expect(calls[0]?.url).toBe("https://cloud.cerebras.ai/api/v1/metrics/organizations/org_1");
  });
});

describe("helpers", () => {
  it("parses version resource names", () => {
    expect(parseVersionName("orgs/a/models/b/versions/3")).toEqual({
      org: "a",
      arch: "b",
      version: "3",
    });
  });

  it("parses Prometheus labels with escapes", () => {
    expect(parsePrometheus('m{a="x\\"y"} 1')[0]?.labels).toEqual({ a: 'x"y' });
  });

  it("maps model components and ignores the console", () => {
    const body = JSON.stringify({
      incidents: [
        {
          id: "i1",
          name: "Slow",
          status: "investigating",
          impact: "minor",
          created_at: "2026-10-01T00:00:00Z",
          components: [{ name: "GPT-OSS-120B" }],
          incident_updates: [],
        },
      ],
    });
    const [incident] = parseStatusFeed(body);
    expect(incident?.services).toEqual(["GPT-OSS-120B"]);
    expect(incident?.resourceTypes).toContain("cerebras-model");
  });
});

const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

/** A host that tracks what a list did not read, as the server's sync does. */
function trackUnread() {
  const parts: Array<{ idPrefixes?: readonly string[] }> = [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: { idPrefixes?: readonly string[] }) => {
    parts.push(part);
  });
  return parts;
}

describe("lists that cannot say they are whole", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
  });

  function client(http: HttpHostServices) {
    return hostClient(
      new CerebrasClient({ apiKey: "csk-x", managementKey: "mk", orgName: "acme" }, { http }),
    );
  }

  it.each([
    ["cerebras-batch", "/v1/batches"],
    ["cerebras-file", "/v1/files"],
  ])("%s throws at the cap rather than return part of a list", async (typeId, route) => {
    let n = 0;
    const { http, calls } = host((url) => {
      if (!url.includes(route)) throw new Error(url);
      n += 1;
      return { body: { data: [{ id: `row_${n}` }], has_more: true } };
    });
    await expect(client(http).listResources(typeId, ACCOUNT)).rejects.toThrow(
      "has more than Infrawrench reads",
    );
    expect(calls).toHaveLength(1000);
  });

  it.each([
    ["cerebras-batch", "/v1/batches"],
    ["cerebras-file", "/v1/files"],
  ])("%s reads past the old 20 page cap to the last page", async (typeId, route) => {
    let n = 0;
    const { http } = host((url) => {
      if (!url.includes(route)) throw new Error(url);
      n += 1;
      return { body: { data: [{ id: `row_${n}` }], has_more: n < 25 } };
    });
    expect(await client(http).listResources(typeId, ACCOUNT)).toHaveLength(25);
  });

  it.each([
    ["cerebras-batch", "/v1/batches"],
    ["cerebras-file", "/v1/files"],
  ])("%s refuses a page with its key renamed, first or later", async (typeId, route) => {
    const first = host((url) => {
      if (!url.includes(route)) throw new Error(url);
      return { body: { items: [{ id: "a" }] } };
    });
    await expect(client(first.http).listResources(typeId, ACCOUNT)).rejects.toThrow(
      "is not a list",
    );

    const later = host((url) => {
      if (!url.includes(route)) throw new Error(url);
      return url.includes("after=")
        ? { body: { items: [{ id: "b" }] } }
        : { body: { data: [{ id: "a" }], has_more: true } };
    });
    await expect(client(later.http).listResources(typeId, ACCOUNT)).rejects.toThrow(
      "is not a list",
    );
  });

  it("reads the documented null data as an empty list", async () => {
    const { http } = host(() => ({ body: { data: null, has_more: null } }));
    expect(await client(http).listResources("cerebras-batch", ACCOUNT)).toEqual([]);
  });

  it.each([
    ["no rows", { data: [], has_more: true }],
    ["no cursor", { data: [{ status: "queued" }], has_more: true }],
  ])("refuses a page that says there is more with %s", async (saysMoreWith, body) => {
    const { http, calls } = host(() => ({ body }));
    await expect(client(http).listResources("cerebras-file", ACCOUNT)).rejects.toThrow(
      `says there is more, with ${saysMoreWith}`,
    );
    expect(calls).toHaveLength(1);
  });

  it("lets the batch form's file picker stop at its old cap instead of failing", async () => {
    let n = 0;
    const { http, calls } = host((url) => {
      if (!url.includes("/v1/files")) throw new Error(url);
      n += 1;
      return { body: { data: [{ id: `file_${n}`, purpose: "batch" }], has_more: true } };
    });
    const config = await client(http).getCreateConfig!("cerebras-batch");
    expect(calls).toHaveLength(20);
    expect(config.fields[0]?.options).toHaveLength(20);
  });

  it("refuses model and management lists with their key renamed", async () => {
    const models = host((url) => {
      if (url.endsWith("/public/v1/models")) return { body: { data: [] } };
      if (url.endsWith("/v1/models")) return { body: { models: [{ id: "m" }] } };
      throw new Error(url);
    });
    await expect(client(models.http).listResources("cerebras-model", ACCOUNT)).rejects.toThrow(
      "is not a list",
    );

    const endpoints = host((url) => {
      if (url.endsWith("/orgs/acme/endpoints")) return { body: { items: [] } };
      throw new Error(url);
    });
    await expect(
      client(endpoints.http).listResources("cerebras-endpoint", ACCOUNT),
    ).rejects.toThrow("is not a list");

    const archs = host((url) => {
      if (url.endsWith("/orgs/acme/models")) return { body: { items: ["a"] } };
      throw new Error(url);
    });
    await expect(
      client(archs.http).listResources("cerebras-model-version", ACCOUNT),
    ).rejects.toThrow("is not a list");

    const versions = host((url) => {
      if (url.endsWith("/orgs/acme/models")) return { body: { model_architectures: ["a"] } };
      if (url.endsWith("/models/a/versions")) return { body: { items: [] } };
      throw new Error(url);
    });
    await expect(
      client(versions.http).listResources("cerebras-model-version", ACCOUNT),
    ).rejects.toThrow("is not a list");
  });

  it("keeps a model's row when only the public catalogue fails", async () => {
    const { http } = host((url) => {
      if (url.endsWith("/public/v1/models")) return { status: 503, body: "down" };
      if (url.endsWith("/v1/models")) return { body: { data: [{ id: "m" }] } };
      throw new Error(url);
    });
    const rows = await client(http).listResources("cerebras-model", ACCOUNT);
    expect(rows.map((r) => r.externalId)).toEqual(["m"]);
  });

  describe("model versions per architecture", () => {
    const VERSION = {
      model_versions: [{ name: "orgs/acme/models/good/versions/1", done: true }],
    };

    function archs(bad: { status: number; body?: unknown }, ...names: string[]) {
      return host((url) => {
        if (url.endsWith("/orgs/acme/models")) return { body: { model_architectures: names } };
        if (url.endsWith("/models/good/versions")) return { body: VERSION };
        if (url.endsWith("/models/bad/versions")) return bad;
        throw new Error(url);
      });
    }

    it.each([401, 429, 500, 503])(
      "fails the whole type on a %i for one architecture",
      async (status) => {
        const { http } = archs({ status, body: "nope" }, "good", "bad");
        await expect(
          client(http).listResources("cerebras-model-version", ACCOUNT),
        ).rejects.toMatchObject({ status });
      },
    );

    it("reads a 404 for an architecture as no versions", async () => {
      const unread = trackUnread();
      const { http } = archs({ status: 404, body: "gone" }, "good", "bad");
      const rows = await client(http).listResources("cerebras-model-version", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["good/1"]);
      expect(unread).toEqual([]);
    });

    it("keeps a refused architecture's stored rows and reads the rest", async () => {
      const unread = trackUnread();
      const { http } = archs({ status: 403, body: "no" }, "good", "bad");
      const rows = await client(http).listResources("cerebras-model-version", ACCOUNT);
      expect(rows.map((r) => r.externalId)).toEqual(["good/1"]);
      expect(unread).toEqual([{ idPrefixes: [`${ACCOUNT}:cerebras-model-version:bad/`] }]);
    });

    it("keeps every row quietly when each architecture refuses", async () => {
      const unread = trackUnread();
      const { http } = archs({ status: 403, body: "no" }, "bad");
      expect(await client(http).listResources("cerebras-model-version", ACCOUNT)).toEqual([]);
      expect(unread).toEqual([{ idPrefixes: [`${ACCOUNT}:cerebras-model-version:bad/`] }]);
    });

    it("shows the refusal on a host that keeps no track when nothing could be read", async () => {
      const { http } = archs({ status: 403, body: "no" }, "bad");
      await expect(
        client(http).listResources("cerebras-model-version", ACCOUNT),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("shows a refusal of one architecture on a host that keeps no track", async () => {
      const { http } = archs({ status: 403, body: "no" }, "good", "bad");
      await expect(
        client(http).listResources("cerebras-model-version", ACCOUNT),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it.each([403, 404])(
    "keeps stored rows when a Private Preview route answers %i",
    async (status) => {
      const unread = trackUnread();
      const { http } = host(() => ({ status, body: { message: "not enabled" } }));
      expect(await client(http).listResources("cerebras-batch", ACCOUNT)).toEqual([]);
      expect(unread).toEqual([{ idPrefixes: [""] }]);
    },
  );
});
