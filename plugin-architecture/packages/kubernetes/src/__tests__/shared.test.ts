import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  k8sApiForKind,
  k8sKindForType,
  parseResourceId,
  buildResourcePath,
  formatDescribe,
  K8sFetcher,
} from "../shared.js";
import type { ParsedKubeconfig, K8sEvent } from "../types.js";

describe("k8sApiForKind", () => {
  it("maps known namespaced kinds", () => {
    expect(k8sApiForKind("Pod")).toEqual({ plural: "pods", namespaced: true });
    expect(k8sApiForKind("Ingress")).toEqual({ plural: "ingresses", namespaced: true });
    expect(k8sApiForKind("NetworkPolicy")).toEqual({
      plural: "networkpolicies",
      namespaced: true,
    });
  });
  it("maps cluster-scoped kinds", () => {
    expect(k8sApiForKind("Namespace")).toEqual({ plural: "namespaces", namespaced: false });
    expect(k8sApiForKind("ClusterRole")).toEqual({ plural: "clusterroles", namespaced: false });
    expect(k8sApiForKind("StorageClass")).toEqual({ plural: "storageclasses", namespaced: false });
  });
  it("returns null for unknown kinds", () => {
    expect(k8sApiForKind("Whatever")).toBeNull();
  });
});

describe("k8sKindForType", () => {
  it("maps known type ids to kinds", () => {
    expect(k8sKindForType("k8s-pod")).toBe("Pod");
    expect(k8sKindForType("k8s-cronjob")).toBe("CronJob");
    expect(k8sKindForType("k8s-namespace")).toBe("Namespace");
  });
  it("returns the type id unchanged for unknown types", () => {
    expect(k8sKindForType("k8s-foobar")).toBe("k8s-foobar");
  });
});

describe("parseResourceId", () => {
  it("parses namespaced ids", () => {
    expect(parseResourceId("acct:k8s-pod:ns1:mypod")).toEqual({
      typeId: "k8s-pod",
      namespace: "ns1",
      name: "mypod",
    });
  });
  it("parses non-namespaced ids", () => {
    expect(parseResourceId("acct:k8s-namespace:prod")).toEqual({
      typeId: "k8s-namespace",
      namespace: "",
      name: "prod",
    });
  });
  it("handles malformed ids gracefully", () => {
    expect(parseResourceId("")).toEqual({ typeId: "", namespace: "", name: "" });
  });
});

describe("buildResourcePath", () => {
  it("builds namespaced paths with encoding", () => {
    expect(buildResourcePath("acct:k8s-deployment:ns/x:my app")).toBe(
      "/apis/apps/v1/namespaces/ns%2Fx/deployments/my%20app",
    );
  });
  it("builds non-namespaced paths", () => {
    expect(buildResourcePath("acct:k8s-namespace:prod")).toBe("/api/v1/namespaces/prod");
  });
  it("uses the right prefix per type", () => {
    expect(buildResourcePath("acct:k8s-job:ns:j")).toBe("/apis/batch/v1/namespaces/ns/jobs/j");
    expect(buildResourcePath("acct:k8s-ingress:ns:i")).toBe(
      "/apis/networking.k8s.io/v1/namespaces/ns/ingresses/i",
    );
    expect(buildResourcePath("acct:k8s-secret:ns:s")).toBe("/api/v1/namespaces/ns/secrets/s");
  });
  it("throws for unknown types", () => {
    expect(() => buildResourcePath("acct:k8s-mystery:ns:x")).toThrow(/Unknown resource type/);
  });
});

describe("formatDescribe", () => {
  it("renders metadata, labels, annotations, spec and events", () => {
    const obj = {
      metadata: {
        name: "web",
        namespace: "prod",
        creationTimestamp: new Date(Date.now() - 5000).toISOString(),
        labels: { app: "web", tier: "frontend" },
        annotations: { "kubectl.kubernetes.io/last-applied": "x" },
      },
      spec: { replicas: 3 },
      status: { readyReplicas: 3 },
    };
    const events: K8sEvent[] = [
      {
        metadata: { name: "e1", uid: "u1", creationTimestamp: "2024-01-01T00:00:00Z" },
        type: "Normal",
        reason: "Scheduled",
        message: "multi\n  line   message",
        lastTimestamp: new Date(Date.now() - 1000).toISOString(),
        source: { component: "scheduler" },
      },
      {
        metadata: { name: "e2", uid: "u2", creationTimestamp: "2024-01-01T00:00:00Z" },
        type: "Warning",
        reason: "BackOff",
        eventTime: new Date(Date.now() - 60000).toISOString(),
      },
    ];
    const out = formatDescribe("Deployment", obj, events);
    expect(out).toContain("Name:         web");
    expect(out).toContain("Namespace:    prod");
    expect(out).toContain("Kind:         Deployment");
    expect(out).toContain("Labels:");
    expect(out).toContain("app=web");
    expect(out).toContain("Annotations:");
    expect(out).toContain("Spec / Status:");
    expect(out).toContain("Events:");
    // multi-line message collapsed to single spaces
    expect(out).toContain("multi line message");
    // most recent event sorts first
    const scheduledIdx = out.indexOf("Scheduled");
    const backoffIdx = out.indexOf("BackOff");
    expect(scheduledIdx).toBeLessThan(backoffIdx);
  });

  it("renders <none> when there are no events and omits empty meta blocks", () => {
    const out = formatDescribe("Pod", { metadata: { name: "p" } }, []);
    expect(out).toContain("Name:         p");
    expect(out).not.toContain("Namespace:");
    expect(out).not.toContain("Labels:");
    expect(out).toContain("  <none>");
  });
});

// ---- K8sFetcher --------------------------------------------------------

const BASE: ParsedKubeconfig = { server: "https://k8s.example" };

describe("K8sFetcher via services.k8s driver", () => {
  it("routes JSON fetch through the driver command with method/headers/body", async () => {
    const command = vi.fn(async () => ({ items: [] }));
    const fetcher = new K8sFetcher(BASE, { k8s: { command } });
    const result = await fetcher.fetch("/api/v1/pods", {
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload",
    });
    expect(result).toEqual({ items: [] });
    expect(command).toHaveBeenCalledWith("request", {
      path: "/api/v1/pods",
      method: "POST",
      headers: { "X-Test": "1" },
      body: "payload",
    });
  });

  it("defaults to GET with empty headers when none supplied", async () => {
    const command = vi.fn(async () => ({}));
    const fetcher = new K8sFetcher(BASE, { k8s: { command } });
    await fetcher.fetch("/version");
    expect(command).toHaveBeenCalledWith("request", {
      path: "/version",
      method: "GET",
      headers: {},
    });
  });

  it("fetchText returns string results directly and stringifies objects", async () => {
    const strCmd = vi.fn(async () => "raw log text");
    expect(await new K8sFetcher(BASE, { k8s: { command: strCmd } }).fetchText("/log")).toBe(
      "raw log text",
    );
    const objCmd = vi.fn(async () => ({ a: 1 }));
    expect(await new K8sFetcher(BASE, { k8s: { command: objCmd } }).fetchText("/log")).toBe(
      JSON.stringify({ a: 1 }),
    );
  });
});

describe("K8sFetcher via host http service (CA pinning)", () => {
  it("uses host http when available even without kubeconfig CA data", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: JSON.stringify({ ok: true }),
    }));
    const parsed: ParsedKubeconfig = {
      server: "https://k8s.example",
      token: "tok",
    };
    const fetcher = new K8sFetcher(parsed, { http: { request } });
    const result = await fetcher.fetch("/api/v1/pods", {
      method: "POST",
      body: "{}",
    });
    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://k8s.example/api/v1/pods",
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.not.objectContaining({ caCert: expect.anything() }),
    );
  });

  it("decodes the CA, calls http.request, parses the JSON body", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: JSON.stringify({ ok: true }),
    }));
    const parsed: ParsedKubeconfig = {
      server: "https://k8s.example",
      token: "tok",
      caCertData: btoa("CA-PEM"),
    };
    const fetcher = new K8sFetcher(parsed, { http: { request } });
    const result = await fetcher.fetch("/api/v1/pods");
    expect(result).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://k8s.example/api/v1/pods",
        method: "GET",
        caCert: "CA-PEM",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });

  it("passes through the body when present", async () => {
    const request = vi.fn(async () => ({
      status: 201,
      headers: {} as Record<string, string>,
      body: "{}",
    }));
    const parsed: ParsedKubeconfig = { server: "https://k8s.example", caCertData: btoa("C") };
    await new K8sFetcher(parsed, { http: { request } }).fetch("/x", {
      method: "POST",
      body: "data",
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ body: "data" }));
  });

  it("throws a descriptive error when http.request rejects", async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("boom"), {
        cause: { code: "ECONNREFUSED", hostname: "k8s.example" },
      });
    });
    const parsed: ParsedKubeconfig = { server: "https://k8s.example", caCertData: btoa("C") };
    await expect(new K8sFetcher(parsed, { http: { request } }).fetch("/x")).rejects.toThrow(
      /unreachable.*ECONNREFUSED \(k8s.example\)/,
    );
  });

  it("throws on non-2xx http.request status", async () => {
    const request = vi.fn(async () => ({
      status: 403,
      headers: {} as Record<string, string>,
      body: "forbidden",
    }));
    const parsed: ParsedKubeconfig = { server: "https://k8s.example", caCertData: btoa("C") };
    await expect(new K8sFetcher(parsed, { http: { request } }).fetch("/x")).rejects.toThrow(
      /K8s API error 403.*forbidden/,
    );
  });

  it("fetchText returns the raw body and surfaces http errors", async () => {
    const ok = vi.fn(async () => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: "plain logs",
    }));
    const parsed: ParsedKubeconfig = { server: "https://k8s.example", caCertData: btoa("C") };
    expect(await new K8sFetcher(parsed, { http: { request: ok } }).fetchText("/log")).toBe(
      "plain logs",
    );

    const bad = vi.fn(async () => ({
      status: 500,
      headers: {} as Record<string, string>,
      body: "oops",
    }));
    await expect(
      new K8sFetcher(parsed, { http: { request: bad } }).fetchText("/log"),
    ).rejects.toThrow(/K8s API error 500/);

    const throws = vi.fn(async () => {
      throw new Error("net down");
    });
    await expect(
      new K8sFetcher(parsed, { http: { request: throws } }).fetchText("/log"),
    ).rejects.toThrow(/unreachable.*net down/);
  });

  it("fetchText also uses host http without kubeconfig CA data", async () => {
    const request = vi.fn(async () => ({
      status: 200,
      headers: {} as Record<string, string>,
      body: "plain logs",
    }));
    const parsed: ParsedKubeconfig = { server: "https://k8s.example", token: "tok" };
    expect(await new K8sFetcher(parsed, { http: { request } }).fetchText("/log")).toBe(
      "plain logs",
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://k8s.example/log",
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
    expect(request).toHaveBeenCalledWith(
      expect.not.objectContaining({ caCert: expect.anything() }),
    );
  });
});

describe("K8sFetcher via global fetch fallback", () => {
  let original: typeof globalThis.fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    vi.restoreAllMocks();
  });

  it("issues a fetch with bearer header and parses JSON", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ items: [1] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await new K8sFetcher({ server: "https://k8s.example", token: "abc" }).fetch(
      "/api/v1/pods",
    );
    expect(result).toEqual({ items: [1] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://k8s.example/api/v1/pods",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer abc" }),
      }),
    );
  });

  it("throws when there is no server", async () => {
    await expect(new K8sFetcher({ server: "" }).fetch("/x")).rejects.toThrow(/no server/);
    await expect(new K8sFetcher({ server: "" }).fetchText("/x")).rejects.toThrow(/no server/);
  });

  it("throws a wrapped error when fetch rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(new K8sFetcher({ server: "https://k8s.example" }).fetch("/x")).rejects.toThrow(
      /unreachable.*network/,
    );
  });

  it("throws on a non-ok fetch response", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(new K8sFetcher({ server: "https://k8s.example" }).fetch("/x")).rejects.toThrow(
      /K8s API error 404/,
    );
  });

  it("fetchText returns text and surfaces errors", async () => {
    const ok = vi.fn(async () => new Response("logline", { status: 200 }));
    globalThis.fetch = ok as unknown as typeof fetch;
    expect(await new K8sFetcher({ server: "https://k8s.example" }).fetchText("/log")).toBe(
      "logline",
    );

    const bad = vi.fn(async () => new Response("nope", { status: 500 }));
    globalThis.fetch = bad as unknown as typeof fetch;
    await expect(
      new K8sFetcher({ server: "https://k8s.example" }).fetchText("/log"),
    ).rejects.toThrow(/K8s API error 500/);

    const throws = vi.fn(async () => {
      throw new Error("offline");
    });
    globalThis.fetch = throws as unknown as typeof fetch;
    await expect(
      new K8sFetcher({ server: "https://k8s.example" }).fetchText("/log"),
    ).rejects.toThrow(/unreachable.*offline/);
  });
});
