// ── K8s API response shapes (minimal) ──────────────────────────────────────

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
    jobTemplate: { spec: { template: { spec: { containers: Array<{ name: string; image: string }> } } } };
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

// ── Kubeconfig parsing ──────────────────────────────────────────────────────

export interface ParsedKubeconfig {
  server: string;
  caCertData?: string;
  token?: string;
  clientCertData?: string;
  clientKeyData?: string;
}

export function parseKubeconfig(raw: string): ParsedKubeconfig {
  const getVal = (key: string): string => {
    const re = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m");
    const m = raw.match(re);
    return m?.[1]?.trim() ?? "";
  };
  const ca = getVal("certificate-authority-data");
  const tok = getVal("token");
  const cert = getVal("client-certificate-data");
  const key = getVal("client-key-data");
  return {
    server: getVal("server"),
    ...(ca ? { caCertData: ca } : {}),
    ...(tok ? { token: tok } : {}),
    ...(cert ? { clientCertData: cert } : {}),
    ...(key ? { clientKeyData: key } : {}),
  };
}

// ── Status mapping helpers ────────────────────────────────────────────────

import type { ResourceStatus } from "@infrawrench/plugin-base";

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
      return "unknown";
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
      return "unknown";
  }
}
