import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplicateClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

function client() {
  return new ReplicateClient({ apiToken: "r8_test" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth", () => {
  it("sends the Bearer scheme, not the legacy Token scheme", async () => {
    installFetch(() => jsonResponse([]));
    await client().listResources("hardware", ACCOUNT);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer r8_test");
  });
});

describe("pagination", () => {
  it("follows the opaque `next` URL verbatim instead of rebuilding a cursor", async () => {
    const nextUrl =
      "https://api.replicate.com/v1/predictions?cursor=cD0yMDIzLTA2LTA2KzIzJTNBNDAlM0EwOC45NjMwMDAlMkIwMCUzQTAw";
    installFetch((url) => {
      if (url === "https://api.replicate.com/v1/predictions") {
        return jsonResponse({ next: nextUrl, results: [{ id: "p1", status: "succeeded" }] });
      }
      if (url === nextUrl) {
        return jsonResponse({ next: null, results: [{ id: "p2", status: "failed" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const items = await client().listResources("prediction", ACCOUNT);
    expect(calls.map((c) => c.url)).toEqual(["https://api.replicate.com/v1/predictions", nextUrl]);
    expect(items.map((i) => i.externalId)).toEqual(["p1", "p2"]);
  });
});

describe("prediction status mapping", () => {
  it("keeps `aborted` distinct from `canceled`", async () => {
    installFetch((url) => {
      if (url.endsWith("/predictions/aborted-one")) {
        return jsonResponse({ id: "aborted-one", status: "aborted", model: "meta/llama" });
      }
      if (url.endsWith("/predictions/canceled-one")) {
        return jsonResponse({ id: "canceled-one", status: "canceled", model: "meta/llama" });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const c = client();
    const aborted = await c.getResource("prediction", `${ACCOUNT}:prediction:aborted-one`, ACCOUNT);
    const canceled = await c.getResource(
      "prediction",
      `${ACCOUNT}:prediction:canceled-one`,
      ACCOUNT,
    );

    expect(c.renderSidebarItem(aborted).status).toEqual({
      kind: "status-dot",
      status: "degraded",
      label: "Aborted before start",
    });
    expect(c.renderSidebarItem(canceled).status).toEqual({
      kind: "status-dot",
      status: "unknown",
      label: "Canceled",
    });
  });

  it("renders `hidden` versions readably instead of as an opaque id", async () => {
    installFetch(() =>
      jsonResponse({ id: "p1", status: "succeeded", model: "openai/whisper", version: "hidden" }),
    );
    const c = client();
    const resource = await c.getResource("prediction", `${ACCOUNT}:prediction:p1`, ACCOUNT);
    const detail = c.renderDetail(resource);
    const first = detail.sections[0]?.children[0];
    expect(first?.kind).toBe("key-value-list");
    const items = first?.kind === "key-value-list" ? first.items : [];
    expect(items.find((i) => i.key === "Version")?.value).toBe("hidden (official model)");
  });
});

describe("deployments", () => {
  it("resolves the latest version when the user leaves it blank", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/models/stability-ai/sdxl") && init?.method !== "POST") {
        return jsonResponse({
          owner: "stability-ai",
          name: "sdxl",
          latest_version: { id: "ver-abc" },
        });
      }
      if (url.endsWith("/deployments") && init?.method === "POST") {
        return jsonResponse({
          owner: "acme",
          name: "sdxl-prod",
          current_release: {
            number: 1,
            model: "stability-ai/sdxl",
            version: "ver-abc",
            configuration: { hardware: "gpu-a40-large", min_instances: 0, max_instances: 3 },
          },
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    const created = await client().createResource("deployment", ACCOUNT, {
      name: "sdxl-prod",
      model: "stability-ai/sdxl",
      version: "",
      hardware: "gpu-a40-large",
      min_instances: "0",
      max_instances: "3",
    });

    const post = calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(post!.init!.body as string)).toEqual({
      name: "sdxl-prod",
      model: "stability-ai/sdxl",
      version: "ver-abc",
      hardware: "gpu-a40-large",
      min_instances: 0,
      max_instances: 3,
    });
    expect(created.externalId).toBe("acme/sdxl-prod");
  });

  it("clamps instance counts to Replicate's asymmetric bounds", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/deployments/acme/sdxl-prod") && init?.method === "PATCH") {
        return jsonResponse({
          owner: "acme",
          name: "sdxl-prod",
          current_release: {
            number: 2,
            configuration: { hardware: "gpu-a40-large", min_instances: 5, max_instances: 20 },
          },
        });
      }
      throw new Error(`unrouted: ${init?.method ?? "GET"} ${url}`);
    });

    await client().updateResource("deployment", `${ACCOUNT}:deployment:acme/sdxl-prod`, ACCOUNT, {
      minInstances: "99",
      maxInstances: "99",
    });

    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      min_instances: 5,
      max_instances: 20,
    });
  });
});

describe("cancel", () => {
  it("POSTs the cancel sub-path for predictions and trainings", async () => {
    installFetch(() => jsonResponse({}));
    const c = client();
    await c.invokeAction("prediction", `${ACCOUNT}:prediction:p1`, "cancel", ACCOUNT);
    await c.invokeAction("training", `${ACCOUNT}:training:t1`, "cancel", ACCOUNT);
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      "POST https://api.replicate.com/v1/predictions/p1/cancel",
      "POST https://api.replicate.com/v1/trainings/t1/cancel",
    ]);
  });
});

describe("models", () => {
  it("derives the account's models from deployments, trainings and predictions", async () => {
    installFetch((url) => {
      if (url.endsWith("/account")) return jsonResponse({ type: "user", username: "acme" });
      if (url.endsWith("/deployments")) {
        return jsonResponse({
          results: [{ owner: "acme", name: "d1", current_release: { model: "acme/sdxl-lora" } }],
        });
      }
      if (url.endsWith("/trainings")) {
        return jsonResponse({
          results: [
            {
              id: "t1",
              model: "stability-ai/sdxl",
              input: { destination: "acme/trained" },
              output: { version: "ver-trained" },
            },
          ],
        });
      }
      if (url.endsWith("/predictions")) {
        return jsonResponse({ results: [{ id: "p1", model: "meta/llama-3", version: "hidden" }] });
      }
      throw new Error(`unrouted: ${url}`);
    });

    const models = await client().listResources("model", ACCOUNT);
    // Account-owned models sort first, then everything else alphabetically.
    expect(models.map((m) => m.externalId)).toEqual([
      "acme/sdxl-lora",
      "acme/trained",
      "meta/llama-3",
      "stability-ai/sdxl",
    ]);
    // `"hidden"` is a placeholder, not a real version — it must not leak out.
    const llama = models.find((m) => m.externalId === "meta/llama-3");
    expect(llama?.resolvedOutputs["latestVersion"]).toBe("");
    const trained = models.find((m) => m.externalId === "acme/trained");
    expect(trained?.resolvedOutputs["latestVersion"]).toBe("ver-trained");
  });
});

describe("files", () => {
  it("maps the checksum and the per-object expiry", async () => {
    installFetch(() =>
      jsonResponse({
        id: "file-1",
        content_type: "audio/wav",
        size: 2048,
        checksums: { sha256: "abc123" },
        created_at: "2026-02-21T12:54:18Z",
        expires_at: "2026-02-21T13:54:18Z",
        urls: { get: "https://api.replicate.com/v1/files/file-1/download" },
      }),
    );
    const resource = await client().getResource("file", `${ACCOUNT}:file:file-1`, ACCOUNT);
    expect(resource.fields["sha256"]).toBe("abc123");
    expect(resource.fields["expiresAt"]).toBe("2026-02-21T13:54:18Z");
    expect(resource.resolvedOutputs["fileUrl"]).toBe(
      "https://api.replicate.com/v1/files/file-1/download",
    );
  });

  it("DELETEs the file endpoint", async () => {
    installFetch(() => jsonResponse({}, 204));
    await client().deleteResource("file", `${ACCOUNT}:file:file-1`, ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.replicate.com/v1/files/file-1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});
