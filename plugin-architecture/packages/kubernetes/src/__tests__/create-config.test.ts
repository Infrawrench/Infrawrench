import { describe, expect, it, vi } from "vitest";
import { getCreateConfig } from "../create-config.js";

const nsList = vi.fn(async () => ({
  items: [
    { metadata: { name: "prod" } },
    { metadata: { name: "kube-system" } },
    { metadata: { name: "dev" } },
  ],
}));

function keys(fields: { key: string }[]): string[] {
  return fields.map((f) => f.key);
}

describe("getCreateConfig namespace field", () => {
  it("builds a namespace select from the API, filtering system namespaces and sorting", async () => {
    const cfg = await getCreateConfig("k8s-deployment", undefined, nsList);
    const ns = cfg.fields.find((f) => f.key === "namespace")!;
    expect(ns.kind).toBe("select");
    expect((ns as { options: { id: string }[] }).options.map((o) => o.id)).toEqual(["dev", "prod"]);
  });

  it("falls back to default namespace option when the API throws", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("forbidden");
    });
    const cfg = await getCreateConfig("k8s-secret", undefined, throwing);
    const ns = cfg.fields.find((f) => f.key === "namespace")!;
    expect((ns as { options: { id: string }[] }).options).toEqual([
      { id: "default", label: "default" },
    ]);
  });

  it("omits the namespace field when created under a namespace parent", async () => {
    const cfg = await getCreateConfig("k8s-deployment", "a:k8s-namespace:prod", nsList);
    expect(keys(cfg.fields)).not.toContain("namespace");
  });
});

describe("getCreateConfig per type", () => {
  it("pod: includes name, namespace, image select, custom image, ttl", async () => {
    const cfg = await getCreateConfig("k8s-pod", undefined, nsList);
    expect(keys(cfg.fields)).toEqual(["name", "namespace", "image", "customImage", "ttl"]);
    const custom = cfg.fields.find((f) => f.key === "customImage")!;
    expect((custom as { showWhen?: unknown }).showWhen).toEqual({
      fieldKey: "image",
      fieldValue: "custom",
    });
  });

  it("configmap: uses a plain text namespace field", async () => {
    const cfg = await getCreateConfig("k8s-configmap", undefined, nsList);
    const ns = cfg.fields.find((f) => f.key === "namespace")!;
    expect(ns.kind).toBe("text");
  });

  it("namespace: single name field, no namespace prompt", async () => {
    const cfg = await getCreateConfig("k8s-namespace", undefined, nsList);
    expect(keys(cfg.fields)).toEqual(["name"]);
  });

  it("secret: includes a type select", async () => {
    const cfg = await getCreateConfig("k8s-secret", undefined, nsList);
    expect(keys(cfg.fields)).toContain("type");
  });

  it("deployment: image/replicas/containerPort", async () => {
    const cfg = await getCreateConfig("k8s-deployment", undefined, nsList);
    expect(keys(cfg.fields)).toEqual(["name", "namespace", "image", "replicas", "containerPort"]);
  });

  it("service: includes a resource-picker-free port set", async () => {
    const cfg = await getCreateConfig("k8s-service", undefined, nsList);
    expect(keys(cfg.fields)).toEqual([
      "name",
      "namespace",
      "type",
      "port",
      "targetPort",
      "selector",
    ]);
  });

  it("ingress: backend service is a resource-picker scoped from namespace", async () => {
    const cfg = await getCreateConfig("k8s-ingress", undefined, nsList);
    const svc = cfg.fields.find((f) => f.key === "serviceName")!;
    expect(svc.kind).toBe("resource-picker");
    expect((svc as { scopeFromFieldKey?: string }).scopeFromFieldKey).toBe("namespace");
  });

  it("job/cronjob/statefulset/daemonset configs", async () => {
    expect(keys((await getCreateConfig("k8s-job", undefined, nsList)).fields)).toEqual([
      "name",
      "namespace",
      "image",
      "command",
      "completions",
    ]);
    expect(keys((await getCreateConfig("k8s-cronjob", undefined, nsList)).fields)).toEqual([
      "name",
      "namespace",
      "schedule",
      "image",
      "command",
    ]);
    expect(keys((await getCreateConfig("k8s-statefulset", undefined, nsList)).fields)).toEqual([
      "name",
      "namespace",
      "image",
      "replicas",
      "serviceName",
      "containerPort",
    ]);
    expect(keys((await getCreateConfig("k8s-daemonset", undefined, nsList)).fields)).toEqual([
      "name",
      "namespace",
      "image",
      "containerPort",
    ]);
  });

  it("throws for unsupported types", async () => {
    await expect(getCreateConfig("k8s-bogus", undefined, nsList)).rejects.toThrow(
      /No create config/,
    );
  });
});
