import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import yaml from "js-yaml";
import { getManifest, applyManifest, importYaml, describeResource } from "../manifest-ops.js";
import type { K8sFetch } from "../shared.js";

describe("getManifest", () => {
  it("fetches the object as YAML and strips managedFields", async () => {
    const fetch = vi.fn(async () => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "p", namespace: "ns", managedFields: [{ x: 1 }] },
      spec: { foo: "bar" },
    })) as unknown as K8sFetch;
    const out = await getManifest("a:k8s-pod:ns:p", fetch);
    expect(fetch).toHaveBeenCalledWith("/api/v1/namespaces/ns/pods/p");
    expect(out).not.toContain("managedFields");
    expect(out).toContain("kind: Pod");
    expect(out).toContain("foo: bar");
  });

  it("tolerates objects without metadata", async () => {
    const fetch = vi.fn(async () => ({ kind: "X" })) as unknown as K8sFetch;
    const out = await getManifest("a:k8s-pod:ns:p", fetch);
    expect(out).toContain("kind: X");
  });
});

describe("applyManifest", () => {
  it("PUTs the parsed YAML body to the resource path", async () => {
    const fetch = vi.fn(async () => ({})) as unknown as K8sFetch;
    await applyManifest(
      "a:k8s-pod:ns:p",
      "apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\n",
      fetch,
    );
    expect(fetch).toHaveBeenCalledWith("/api/v1/namespaces/ns/pods/p", {
      method: "PUT",
      body: JSON.stringify({ apiVersion: "v1", kind: "Pod", metadata: { name: "p" } }),
    });
  });
});

describe("importYaml", () => {
  it("applies each valid document via server-side apply PATCH", async () => {
    const fetch = vi.fn(async (_path: string, _opts?: RequestInit) => ({}));
    const docs = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cm1
  namespace: prod
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dep1
`;
    const result = await importYaml(docs, fetch as unknown as K8sFetch);
    expect(result).toEqual({ applied: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [cmPath, cmOpts] = fetch.mock.calls[0]!;
    expect(cmPath).toBe(
      "/api/v1/namespaces/prod/configmaps/cm1?fieldManager=infrawrench&force=true",
    );
    expect((cmOpts as unknown as RequestInit).method).toBe("PATCH");
    expect((cmOpts as unknown as { headers: Record<string, string> }).headers["Content-Type"]).toBe(
      "application/apply-patch+yaml",
    );
    // deployment defaults to the `default` namespace
    expect(fetch.mock.calls[1]![0]).toBe(
      "/apis/apps/v1/namespaces/default/deployments/dep1?fieldManager=infrawrench&force=true",
    );
  });

  it("uses the non-namespaced path for cluster-scoped kinds", async () => {
    const fetch = vi.fn(async (_path: string, _opts?: RequestInit) => ({}));
    await importYaml(
      "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: prod\n",
      fetch as unknown as K8sFetch,
    );
    expect(fetch.mock.calls[0]![0]).toBe(
      "/api/v1/namespaces/prod?fieldManager=infrawrench&force=true",
    );
  });

  it("throws when no documents are found", async () => {
    await expect(
      importYaml("\n# just a comment\n", vi.fn() as unknown as K8sFetch),
    ).rejects.toThrow(/No YAML documents/);
  });

  it("throws on documents missing apiVersion/kind/name", async () => {
    await expect(importYaml("kind: Pod\n", vi.fn() as unknown as K8sFetch)).rejects.toThrow(
      /missing apiVersion/,
    );
  });

  it("throws on unsupported kinds", async () => {
    await expect(
      importYaml(
        "apiVersion: v1\nkind: Bogus\nmetadata:\n  name: x\n",
        vi.fn() as unknown as K8sFetch,
      ),
    ).rejects.toThrow(/unsupported kind/);
  });
});

describe("describeResource", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it("fetches object + events and renders a describe view", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.includes("/events")) {
        return {
          items: [
            {
              metadata: { name: "e", uid: "u", creationTimestamp: "2024-01-01T00:00:00Z" },
              type: "Normal",
              reason: "Pulled",
              message: "ok",
              lastTimestamp: "2024-01-01T00:00:00Z",
            },
          ],
        };
      }
      return {
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: "p", namespace: "ns", managedFields: [{}] },
        spec: {},
      };
    });
    const out = await describeResource("k8s-pod", "a:k8s-pod:ns:p", fetch as unknown as K8sFetch);
    expect(out).toContain("Name:         p");
    expect(out).toContain("Kind:         Pod");
    expect(out).toContain("Pulled");
    // events path uses fieldSelector with kind+name
    const eventsCall = fetch.mock.calls.find((c) => String(c[0]).includes("/events"))![0] as string;
    expect(decodeURIComponent(eventsCall)).toContain("involvedObject.kind=Pod");
    expect(decodeURIComponent(eventsCall)).toContain("involvedObject.name=p");
  });

  it("continues without events when the events fetch fails", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path.includes("/events")) throw new Error("rbac forbidden");
      return { kind: "Pod", metadata: { name: "p", namespace: "ns" } };
    });
    const out = await describeResource("k8s-pod", "a:k8s-pod:ns:p", fetch as unknown as K8sFetch);
    expect(out).toContain("<none>");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("skips event fetch for non-namespaced resources", async () => {
    const fetch = vi.fn(async () => ({
      kind: "Namespace",
      metadata: { name: "prod" },
    })) as unknown as K8sFetch;
    const out = await describeResource("k8s-namespace", "a:k8s-namespace:prod", fetch);
    expect(out).toContain("Kind:         Namespace");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
