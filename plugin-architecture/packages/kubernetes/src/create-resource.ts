import type { ResourceInstance } from "@infrawrench/plugin-base";

import type { K8sFetch } from "./shared.js";

/**
 * Create a new resource of the given type via the K8s API. Each branch
 * shapes its own request body and returns a ResourceInstance reflecting the
 * created object — server-side status fields (clusterIP, readyReplicas,
 * etc.) start out empty and get filled in on the next list.
 */
export async function createResource(
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId: string | undefined,
  k8sFetch: K8sFetch,
): Promise<ResourceInstance> {
  const now = new Date().toISOString();
  const parentTypeId = parentResourceId?.split(":")[1] ?? "";
  const parentNamespace =
    parentResourceId && parentTypeId === "k8s-namespace"
      ? parentResourceId.split(":").slice(2).join(":")
      : "";
  const namespace = fields["namespace"] || parentNamespace || "default";
  const name = fields["name"] || "unnamed";

  if (typeId === "k8s-pod") {
    const rawImage = fields["image"] || "ubuntu:24.04";
    const image = rawImage === "custom" ? fields["customImage"] || "ubuntu:24.04" : rawImage;
    const ttlSeconds = parseInt(fields["ttl"] || "3600", 10);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    await k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
          name,
          namespace,
          labels: {
            "app.kubernetes.io/managed-by": "infrawrench",
            "infrawrench.io/ephemeral": "true",
          },
          annotations: {
            "infrawrench.io/ttl-seconds": String(ttlSeconds),
            "infrawrench.io/expires-at": expiresAt,
          },
        },
        spec: {
          activeDeadlineSeconds: ttlSeconds,
          restartPolicy: "Never",
          containers: [
            {
              name: "scratch",
              image,
              command: ["sleep", String(ttlSeconds)],
              stdin: true,
              tty: true,
            },
          ],
        },
      }),
    });

    return {
      id: `${accountId}:k8s-pod:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-pod",
      accountId,
      displayName: name,
      fields: {
        name,
        namespace,
        image,
        status: "Pending",
        containerName: "scratch",
        ephemeral: "true",
        ttlSeconds,
        expiresAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-configmap") {
    await k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name, namespace, labels: { "app.kubernetes.io/managed-by": "infrawrench" } },
        data: {},
      }),
    });
    return {
      id: `${accountId}:k8s-configmap:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-configmap",
      accountId,
      displayName: name,
      fields: { name, namespace, dataCount: 0, keys: "" },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-namespace") {
    await k8sFetch("/api/v1/namespaces", {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-namespace:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-namespace",
      accountId,
      displayName: name,
      fields: { name },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-cluster:cluster`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-secret") {
    const secretType = fields["type"] || "Opaque";
    await k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        type: secretType,
        data: {},
      }),
    });
    return {
      id: `${accountId}:k8s-secret:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-secret",
      accountId,
      displayName: name,
      fields: { name, namespace, type: secretType, keys: "", dataCount: 0 },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-deployment") {
    const image = fields["image"] || "nginx:latest";
    const replicas = parseInt(fields["replicas"] || "1", 10);
    const containerPort = fields["containerPort"] ? parseInt(fields["containerPort"], 10) : 80;

    await k8sFetch(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
        },
        spec: {
          replicas,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [
                {
                  name,
                  image,
                  ports: [{ containerPort }],
                },
              ],
            },
          },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-deployment:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-deployment",
      accountId,
      displayName: name,
      fields: { name, namespace, replicas },
      resolvedOutputs: { readyReplicas: "0", image },
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-service") {
    const svcType = fields["type"] || "ClusterIP";
    const port = parseInt(fields["port"] || "80", 10);
    const targetPort = parseInt(fields["targetPort"] || "80", 10);
    const selector = fields["selector"] || name;

    await k8sFetch(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "v1",
        kind: "Service",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        spec: {
          type: svcType,
          selector: { app: selector },
          ports: [{ port, targetPort, protocol: "TCP" }],
        },
      }),
    });
    return {
      id: `${accountId}:k8s-service:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-service",
      accountId,
      displayName: name,
      fields: {
        name,
        namespace,
        type: svcType,
        clusterIP: "",
        ports: `${port}→${targetPort}/TCP`,
      },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-ingress") {
    const host = fields["host"] || "localhost";
    const serviceName = fields["serviceName"] || "";
    const servicePort = parseInt(fields["servicePort"] || "80", 10);
    const body: Record<string, unknown> = {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata: {
        name,
        namespace,
        labels: { "app.kubernetes.io/managed-by": "infrawrench" },
      },
      spec: {
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: { name: serviceName, port: { number: servicePort } },
                  },
                },
              ],
            },
          },
        ],
      },
    };
    if (fields["ingressClassName"]) {
      (body["spec"] as Record<string, unknown>)["ingressClassName"] = fields["ingressClassName"];
    }
    await k8sFetch(
      `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses`,
      { method: "POST", body: JSON.stringify(body) },
    );
    return {
      id: `${accountId}:k8s-ingress:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-ingress",
      accountId,
      displayName: name,
      fields: {
        name,
        namespace,
        ingressClassName: fields["ingressClassName"] || "",
        hosts: host,
        address: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-job") {
    const image = fields["image"] || "busybox:latest";
    const completions = parseInt(fields["completions"] || "1", 10);
    const container: Record<string, unknown> = { name: "job", image };
    if (fields["command"]) {
      container["command"] = ["/bin/sh", "-c", fields["command"]];
    }
    await k8sFetch(`/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        spec: {
          completions,
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [container],
            },
          },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-job:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-job",
      accountId,
      displayName: name,
      fields: { name, namespace, completions: String(completions), status: "Active", image },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-cronjob") {
    const image = fields["image"] || "busybox:latest";
    const schedule = fields["schedule"] || "*/5 * * * *";
    const container: Record<string, unknown> = { name: "cronjob", image };
    if (fields["command"]) {
      container["command"] = ["/bin/sh", "-c", fields["command"]];
    }
    await k8sFetch(`/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench" },
        },
        spec: {
          schedule,
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  restartPolicy: "Never",
                  containers: [container],
                },
              },
            },
          },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-cronjob:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-cronjob",
      accountId,
      displayName: name,
      fields: { name, namespace, schedule, suspended: "false", lastSchedule: "" },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-statefulset") {
    const image = fields["image"] || "nginx:latest";
    const replicas = parseInt(fields["replicas"] || "1", 10);
    const serviceName = fields["serviceName"] || name;
    const containerPort = fields["containerPort"] ? parseInt(fields["containerPort"], 10) : 80;
    await k8sFetch(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/statefulsets`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "apps/v1",
        kind: "StatefulSet",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
        },
        spec: {
          serviceName,
          replicas,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [{ name, image, ports: [{ containerPort }] }],
            },
          },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-statefulset:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-statefulset",
      accountId,
      displayName: name,
      fields: { name, namespace, replicas, readyReplicas: 0, image },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "k8s-daemonset") {
    const image = fields["image"] || "fluentd:latest";
    const ports = fields["containerPort"]
      ? [{ containerPort: parseInt(fields["containerPort"], 10) }]
      : [];
    await k8sFetch(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/daemonsets`, {
      method: "POST",
      body: JSON.stringify({
        apiVersion: "apps/v1",
        kind: "DaemonSet",
        metadata: {
          name,
          namespace,
          labels: { "app.kubernetes.io/managed-by": "infrawrench", app: name },
        },
        spec: {
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [{ name, image, ...(ports.length ? { ports } : {}) }],
            },
          },
        },
      }),
    });
    return {
      id: `${accountId}:k8s-daemonset:${namespace}:${name}`,
      pluginId: "kubernetes",
      resourceTypeId: "k8s-daemonset",
      accountId,
      displayName: name,
      fields: { name, namespace, desiredNumberScheduled: 0, numberReady: 0, image },
      resolvedOutputs: {},
      secretStates: [],
      parentResourceId: `${accountId}:k8s-namespace:${namespace}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  throw new Error(`Kubernetes plugin: createResource not supported for type "${typeId}"`);
}
