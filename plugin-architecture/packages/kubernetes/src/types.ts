interface K8sOwnerReference {
  apiVersion?: string;
  kind?: string;
  name?: string;
  uid?: string;
  controller?: boolean;
}

interface K8sMeta {
  name: string;
  namespace?: string;
  uid: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** Set by the controller that created this object (a Job's CronJob, say). */
  ownerReferences?: K8sOwnerReference[];
}

export interface K8sList<T> {
  items: T[];
}

export interface K8sNamespace {
  metadata: K8sMeta;
  status: { phase: string };
}

export interface K8sNode {
  metadata: K8sMeta & { labels?: Record<string, string> };
  spec?: { unschedulable?: boolean };
  status?: {
    conditions?: Array<{ type: string; status: string }>;
    /**
     * Total machine size — what the cloud invoice is for. Distinct from
     * `allocatable`, which subtracts kube-reserved, system-reserved and
     * eviction headroom and is what the scheduler actually hands out.
     */
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
    nodeInfo?: { kubeletVersion?: string };
  };
}

/** A container's `resources` block. Values are Kubernetes quantity strings. */
interface K8sResourceRequirements {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface K8sPodContainer {
  name: string;
  image: string;
  /** CPU/memory requests and limits. Absent means "unbounded, unreserved". */
  resources?: K8sResourceRequirements;
  /**
   * Only meaningful on an entry in `initContainers`: `Always` marks it a
   * sidecar (KEP-753), which changes the pod's effective request.
   */
  restartPolicy?: string;
  /** Whole-ConfigMap/Secret env imports. */
  envFrom?: Array<{
    configMapRef?: { name?: string };
    secretRef?: { name?: string };
  }>;
  /** Single-key env imports. */
  env?: Array<{
    valueFrom?: {
      configMapKeyRef?: { name?: string };
      secretKeyRef?: { name?: string };
    };
  }>;
}

/**
 * The parts of a PodSpec the listers read. Shared by pods and by the pod
 * templates inside Deployments and StatefulSets, which carry the same shape.
 */
export interface K8sPodSpec {
  containers: K8sPodContainer[];
  initContainers?: K8sPodContainer[];
  /**
   * Pod-level resources (KEP-2837, beta and on by default since v1.34). When
   * present these OVERRIDE the container aggregate for the resources named.
   */
  resources?: K8sResourceRequirements;
  /** Runtime overhead the scheduler reserves on top of the containers. */
  overhead?: Record<string, string>;
  /** The node the scheduler placed the pod on — empty while still Pending. */
  nodeName?: string;
  serviceAccountName?: string;
  imagePullSecrets?: Array<{ name?: string }>;
  volumes?: Array<{
    configMap?: { name?: string };
    secret?: { secretName?: string };
    /**
     * The only link from a pod to a PersistentVolumeClaim, and therefore the
     * only way to attribute a disk to a workload. `claimName` always names a
     * PVC in the *pod's own namespace* — the API reference is explicit about
     * that — so no qualification is needed beyond the pod's namespace.
     */
    persistentVolumeClaim?: { claimName?: string; readOnly?: boolean };
    projected?: {
      sources?: Array<{ configMap?: { name?: string }; secret?: { name?: string } }>;
    };
  }>;
}

export interface K8sPod {
  metadata: K8sMeta & { ownerReferences?: K8sOwnerReference[] };
  spec: K8sPodSpec;
  status: {
    phase: string;
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
    containerStatuses?: Array<{
      ready: boolean;
      restartCount: number;
      state: {
        waiting?: { reason?: string; message?: string };
        [key: string]: unknown;
      };
    }>;
  };
}

export interface K8sDeployment {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: K8sPodSpec };
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
    /**
     * Services take **equality-based selectors only** — a plain map, never a
     * `matchExpressions` block. (The labels concept page: "Label selectors for
     * both objects are defined in json or yaml files using maps, and only
     * equality-based requirement selectors are supported".) So matching a
     * Service to its pods is an exact subset test, not a selector engine.
     */
    selector?: Record<string, string>;
    /**
     * Names a non-default load-balancer implementation. Present means some
     * controller other than the cloud provider's built-in one provisions it —
     * which may or may not be a billed cloud LB, so it is reported rather than
     * used to decide the price.
     */
    loadBalancerClass?: string;
  };
  status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
}

/**
 * A PersistentVolumeClaim, which is where cluster storage cost is actually
 * attributable: the claim is namespaced, is what a pod mounts, and carries the
 * provisioned size.
 *
 * `status.phase` is `Pending` | `Bound` | `Lost`. `status.capacity.storage` is
 * what the provisioner really made (which can exceed the request — providers
 * round up to their own minimum), so it is the honest thing to price; the
 * request is only a fallback for a claim that has not bound yet.
 */
export interface K8sPersistentVolumeClaim {
  metadata: K8sMeta;
  spec: {
    storageClassName?: string;
    volumeName?: string;
    accessModes?: string[];
    volumeMode?: string;
    resources?: { requests?: Record<string, string> };
  };
  status?: {
    phase?: string;
    capacity?: Record<string, string>;
    accessModes?: string[];
  };
}

export interface K8sStatefulSet {
  metadata: K8sMeta;
  spec: {
    replicas?: number;
    template: { spec: K8sPodSpec };
  };
  status: { replicas?: number; readyReplicas?: number; currentReplicas?: number };
}

export interface K8sDaemonSet {
  metadata: K8sMeta;
  spec: { template: { spec: K8sPodSpec } };
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
    template: { spec: K8sPodSpec };
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
      spec: { template: { spec: K8sPodSpec } };
    };
  };
  status: { lastScheduleTime?: string; lastSuccessfulTime?: string };
}

export interface K8sIngressBackend {
  service?: { name?: string; port?: { number?: number; name?: string } };
}

export interface K8sIngress {
  metadata: K8sMeta;
  spec: {
    ingressClassName?: string;
    defaultBackend?: K8sIngressBackend;
    rules?: Array<{
      host?: string;
      http?: { paths?: Array<{ path?: string; pathType?: string; backend?: K8sIngressBackend }> };
    }>;
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
