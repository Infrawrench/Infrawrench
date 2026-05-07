export interface K8sMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sList<T> {
  items: T[];
}

export interface K8sNamespace {
  metadata: K8sMeta;
  status: { phase: string };
}

export interface K8sPod {
  metadata: K8sMeta;
  spec: { containers: Array<{ name: string; image: string }> };
  status: {
    phase: string;
    containerStatuses?: Array<{
      ready: boolean;
      restartCount: number;
      state: Record<string, unknown>;
    }>;
  };
}

export interface K8sDeployment {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
  };
}

export interface K8sService {
  metadata: K8sMeta;
  spec: {
    type: string;
    clusterIP?: string;
    ports?: Array<{ port: number; targetPort: number | string; protocol: string; name?: string }>;
    selector?: Record<string, string>;
  };
}

export interface K8sStatefulSet {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: { replicas?: number; readyReplicas?: number; currentReplicas?: number };
}

export interface K8sDaemonSet {
  metadata: K8sMeta;
  spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } };
  status: {
    desiredNumberScheduled: number;
    numberReady: number;
    currentNumberScheduled?: number;
    numberMisscheduled?: number;
  };
}

export interface K8sJob {
  metadata: K8sMeta;
  spec: {
    completions?: number;
    parallelism?: number;
    template: { spec: { containers: Array<{ name: string; image: string }> } };
  };
  status: {
    succeeded?: number;
    failed?: number;
    active?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: Array<{ type: string; status: string }>;
  };
}

export interface K8sCronJob {
  metadata: K8sMeta;
  spec: {
    schedule: string;
    suspend?: boolean;
    jobTemplate: {
      spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } };
    };
  };
  status: { lastScheduleTime?: string; lastSuccessfulTime?: string };
}

export interface K8sIngress {
  metadata: K8sMeta;
  spec: {
    ingressClassName?: string;
    rules?: Array<{ host?: string }>;
  };
  status: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
}

export interface K8sConfigMap {
  metadata: K8sMeta;
  data?: Record<string, string>;
}

export interface K8sSecret {
  metadata: K8sMeta;
  type?: string;
  data?: Record<string, string>;
}

export interface K8sEvent {
  metadata: K8sMeta;
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  source?: { component?: string; host?: string };
}

export interface ParsedKubeconfig {
  server: string;
  caCertData?: string;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
}

import yaml from "js-yaml";
import type { ResourceStatus } from "@infrawrench/plugin-base";

export function parseKubeconfig(raw: string): ParsedKubeconfig {
  const doc = yaml.load(raw) as Record<string, unknown> | null;
  if (!doc) throw new Error("Invalid kubeconfig: empty or unparseable YAML");

  const clusters = (doc["clusters"] ?? []) as Array<{
    cluster?: { server?: string; "certificate-authority-data"?: string };
  }>;
  const cluster = clusters[0]?.cluster;
  const users = (doc["users"] ?? []) as Array<{
    user?: {
      token?: string;
      "client-certificate-data"?: string;
      "client-key-data"?: string;
    };
  }>;
  const user = users[0]?.user;

  return {
    server: (cluster?.server ?? "").replace(/\/$/, ""),
    ...(cluster?.["certificate-authority-data"]
      ? { caCertData: cluster["certificate-authority-data"] }
      : {}),
    ...(user?.token ? { token: user.token } : {}),
    ...(user?.["client-certificate-data"]
      ? { clientCertData: user["client-certificate-data"] }
      : {}),
    ...(user?.["client-key-data"] ? { clientKeyData: user["client-key-data"] } : {}),
  };
}

export function mapPeerStatus(status: string): ResourceStatus {
  switch (status.toLowerCase()) {
    case "running":
    case "ready":
    case "active":
    case "succeeded":
      return "healthy";
    case "pending":
    case "creating":
    case "containercreating":
      return "provisioning";
    case "crashloopbackoff":
    case "terminating":
    case "evicted":
      return "degraded";
    case "failed":
    case "error":
    case "imagepullbackoff":
    case "errimagepull":
    case "oomkilled":
      return "error";
    default:
      return "info";
  }
}

export function mapJobStatus(status: string): ResourceStatus {
  switch (status.toLowerCase()) {
    case "complete":
    case "succeeded":
      return "healthy";
    case "running":
    case "active":
      return "provisioning";
    case "failed":
      return "error";
    default:
      return "info";
  }
}
