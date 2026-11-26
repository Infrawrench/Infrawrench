// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, httpTransport, responseTypeOf, setTransport } from "../client";
import { API_ROUTES } from "../routes.gen";

afterEach(() => {
  vi.unstubAllGlobals();
  setTransport(httpTransport);
});

const params = { owner: "acme", repo: "infra", workspace: "staging", versionId: "sv_1" };

describe("the API client", () => {
  it("asks for a state version at the contract's own path and hands back its bytes", async () => {
    // Parsed and printed again, this document would lose its number and its spacing.
    const document = '{"version":4,"serial": 9007199254740993,\n  "lineage":"a"}\n';
    const fetched = vi.fn(async () => new Response(document, { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    const text = await api.terraform.downloadStateVersion({ params });
    expect(text).toBe(document);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "/api/repos/acme/infra/terraform/workspaces/staging/state-versions/sv_1/download",
    );
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
  });

  it("still reads a refusal of a text endpoint as the API's error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 })),
    );
    const error = await api.terraform.downloadStateVersion({ params }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: "Forbidden" });
  });

  it("restores a state version with a POST and reads the new version", async () => {
    const fetched = vi.fn(async () => Response.json({ id: "sv_2", serial: 8, current: true }));
    vi.stubGlobal("fetch", fetched);
    const version = await api.terraform.restoreStateVersion({ params });
    expect(version).toMatchObject({ id: "sv_2", current: true });
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/state-versions\/sv_1\/restore$/);
    expect(init.method).toBe("POST");
  });

  it("tells the transport which endpoints answer text, all of them real", () => {
    const routes: Record<string, Record<string, unknown>> = API_ROUTES;
    expect(responseTypeOf("terraform", "downloadStateVersion")).toBe("text");
    expect(responseTypeOf("terraform", "restoreStateVersion")).toBe("json");
    expect(routes["terraform"]?.["downloadStateVersion"]).toBeDefined();
  });
});
