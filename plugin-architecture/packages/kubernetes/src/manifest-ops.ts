import yaml from "js-yaml";

import type { K8sEvent, K8sList } from "./types.js";
import {
  buildResourcePath,
  formatDescribe,
  k8sApiForKind,
  k8sKindForType,
  parseResourceId,
  type K8sFetch,
} from "./shared.js";

/** Fetch the live object as YAML, with noisy managedFields stripped. */
export async function getManifest(resourceId: string, k8sFetch: K8sFetch): Promise<string> {
  const path = buildResourcePath(resourceId);
  const raw = await k8sFetch<Record<string, unknown>>(path);
  // Strip managed fields — they're noisy and kubectl hides them by default
  if (raw.metadata && typeof raw.metadata === "object") {
    delete (raw.metadata as Record<string, unknown>).managedFields;
  }
  return yaml.dump(raw, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/** Apply an edited manifest back to the cluster via PUT. */
export async function applyManifest(
  resourceId: string,
  manifest: string,
  k8sFetch: K8sFetch,
): Promise<void> {
  const path = buildResourcePath(resourceId);
  const body = yaml.load(manifest);
  await k8sFetch(path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

/**
 * Apply one or more YAML documents using server-side apply (PATCH with
 * application/apply-patch+yaml). Returns the count of successfully applied
 * documents.
 */
export async function importYaml(
  yamlText: string,
  k8sFetch: K8sFetch,
): Promise<{ applied: number }> {
  const docs = (yaml.loadAll(yamlText) as Array<Record<string, unknown> | null>).filter(
    (d): d is Record<string, unknown> => !!d && typeof d === "object",
  );
  if (docs.length === 0) throw new Error("No YAML documents found");

  let applied = 0;
  for (const [i, doc] of docs.entries()) {
    const apiVersion = String(doc["apiVersion"] ?? "");
    const kind = String(doc["kind"] ?? "");
    const metadata = (doc["metadata"] ?? {}) as Record<string, unknown>;
    const name = String(metadata["name"] ?? "");
    const namespace = String(metadata["namespace"] ?? "");
    if (!apiVersion || !kind || !name) {
      throw new Error(`Document ${i + 1}: missing apiVersion, kind, or metadata.name`);
    }

    const api = k8sApiForKind(kind);
    if (!api) throw new Error(`Document ${i + 1}: unsupported kind "${kind}"`);

    const prefix = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
    const q = "fieldManager=infrawrench&force=true";
    const path = api.namespaced
      ? `${prefix}/namespaces/${encodeURIComponent(namespace || "default")}/${api.plural}/${encodeURIComponent(name)}?${q}`
      : `${prefix}/${api.plural}/${encodeURIComponent(name)}?${q}`;

    await k8sFetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/apply-patch+yaml" },
      body: yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false }),
    });
    applied++;
  }
  return { applied };
}

/**
 * Render a `kubectl describe`-style text view of a resource: metadata,
 * spec/status as YAML, and any associated events.
 */
export async function describeResource(
  typeId: string,
  resourceId: string,
  k8sFetch: K8sFetch,
): Promise<string> {
  const { namespace, name } = parseResourceId(resourceId);
  const kind = k8sKindForType(typeId);

  const objectPath = buildResourcePath(resourceId);
  const obj = await k8sFetch<Record<string, unknown>>(objectPath);
  if (obj.metadata && typeof obj.metadata === "object") {
    delete (obj.metadata as Record<string, unknown>).managedFields;
  }

  let events: K8sEvent[] = [];
  if (namespace) {
    try {
      const eventsPath =
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/events` +
        `?fieldSelector=involvedObject.kind=${encodeURIComponent(kind)},involvedObject.name=${encodeURIComponent(name)}`;
      const data = await k8sFetch<K8sList<K8sEvent>>(eventsPath);
      events = data.items;
    } catch (e) {
      console.warn(`[describe] k8s events fetch failed (non-fatal):`, e);
    }
  }

  return formatDescribe(kind, obj, events);
}
