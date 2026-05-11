import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";

import type { K8sList, K8sPod } from "./types.js";
import type { K8sFetcher } from "./shared.js";
import { parseResourceId } from "./shared.js";

/**
 * Fetch container logs for a resource. For a Pod we read it directly; for
 * workload/Service types we first resolve a single representative pod via
 * the label selector and read logs from that.
 */
export async function getLogs(
  typeId: string,
  resourceId: string,
  params: LogsFetchParams,
  fetcher: K8sFetcher,
): Promise<LogsFetchResult> {
  const { namespace, name } = parseResourceId(resourceId);
  if (!namespace)
    throw new Error(`Kubernetes plugin: logs require a namespaced resource (${typeId})`);

  const podRef = await resolvePodForLogs(typeId, namespace, name, fetcher);
  const pod = await fetcher.fetch<K8sPod>(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podRef)}`,
  );
  const containers = pod.spec.containers.map((c) => c.name);
  if (containers.length === 0)
    throw new Error(`Kubernetes plugin: pod ${namespace}/${podRef} has no containers`);

  const activeContainer =
    params.container && containers.includes(params.container) ? params.container : containers[0]!;

  const query = new URLSearchParams();
  query.set("container", activeContainer);
  query.set("tailLines", String(params.tailLines ?? 500));
  query.set("timestamps", "true");
  if (params.previous) query.set("previous", "true");

  const path =
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podRef)}/log` +
    `?${query.toString()}`;
  const text = await fetcher.fetchText(path);
  return { text, containers, activeContainer };
}

/**
 * Resolve the pod name to fetch logs from. For k8s-pod this is the name
 * itself. For workload types (deployment, statefulset, daemonset, job) we
 * read the object's spec selector, query pods by label, and pick the first
 * running one.
 */
async function resolvePodForLogs(
  typeId: string,
  namespace: string,
  name: string,
  fetcher: K8sFetcher,
): Promise<string> {
  if (typeId === "k8s-pod") return name;

  let labelSelector: string;
  if (typeId === "k8s-job") {
    // Jobs get a standard `job-name` label applied to their pods.
    labelSelector = `job-name=${name}`;
  } else if (
    typeId === "k8s-deployment" ||
    typeId === "k8s-statefulset" ||
    typeId === "k8s-daemonset"
  ) {
    const api =
      typeId === "k8s-deployment"
        ? "deployments"
        : typeId === "k8s-statefulset"
          ? "statefulsets"
          : "daemonsets";
    const obj = await fetcher.fetch<{
      spec?: { selector?: { matchLabels?: Record<string, string> } };
    }>(
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/${api}/${encodeURIComponent(name)}`,
    );
    const match = obj.spec?.selector?.matchLabels;
    if (!match || Object.keys(match).length === 0) {
      throw new Error(`Kubernetes plugin: ${typeId} ${name} has no matchLabels`);
    }
    labelSelector = Object.entries(match)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  } else if (typeId === "k8s-service") {
    const obj = await fetcher.fetch<{ spec?: { selector?: Record<string, string> } }>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`,
    );
    const match = obj.spec?.selector;
    if (!match || Object.keys(match).length === 0) {
      throw new Error(`Kubernetes plugin: service ${name} has no pod selector`);
    }
    labelSelector = Object.entries(match)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  } else {
    throw new Error(`Kubernetes plugin: logs not supported for type "${typeId}"`);
  }

  const podList = await fetcher.fetch<K8sList<K8sPod>>(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods` +
      `?labelSelector=${encodeURIComponent(labelSelector)}`,
  );
  const candidate = podList.items.find((p) => p.status.phase === "Running") ?? podList.items[0];
  if (!candidate)
    throw new Error(`Kubernetes plugin: no pods matched ${labelSelector} in ${namespace}`);
  return candidate.metadata.name;
}
