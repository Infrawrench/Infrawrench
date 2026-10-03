import { f, o, rt } from "@infrawrench/plugin-base";

export const GpuClusterResourceType = rt({
  name: "GPU Cluster",
  id: "gpu-cluster",
  description:
    "A Together Instant Cluster: a Kubernetes or Slurm cluster of reserved, on-demand or scheduled GPU nodes with optional shared storage",
  fields: [
    f("clusterName", "Name", { editable: false }),
    f("clusterId", "Cluster ID", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("clusterType", "Cluster Type", {
      kind: "enum",
      enumValues: ["KUBERNETES", "SLURM"],
      required: false,
    }),
    f("region", "Region", { required: false, editable: false }),
    f("gpuType", "GPU Type", { required: false, editable: false }),
    f("numGpus", "GPUs", {
      kind: "number",
      required: false,
      description: "Target GPU count. Must be a multiple of 8.",
    }),
    f("numReservedGpus", "Reserved GPUs", {
      kind: "number",
      required: false,
      description: "Prepaid GPUs. Only applies to clusters with RESERVED billing.",
    }),
    f("desiredPreemptibleGpus", "Preemptible GPUs (requested)", {
      kind: "number",
      required: false,
      description:
        "Discounted preemptible GPUs to run alongside on-demand capacity. Must be a multiple of 8.",
    }),
    f("allocatedPreemptibleGpus", "Preemptible GPUs (allocated)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("billingType", "Billing Type", { required: false, editable: false }),
    f("cudaVersion", "CUDA Version", { required: false, editable: false }),
    f("nvidiaDriverVersion", "NVIDIA Driver", { required: false, editable: false }),
    f("numCpuWorkers", "CPU Workers", { kind: "number", required: false, editable: false }),
    f("gpuWorkerCount", "GPU Worker Nodes", { kind: "number", required: false, editable: false }),
    f("controlPlaneCount", "Control Plane Nodes", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("volumeId", "Shared Volume", { required: false, editable: false }),
    f("reservationStartTime", "Reservation Start", { required: false, editable: false }),
    f("reservationEndTime", "Reservation End", {
      required: false,
      description:
        "When the cluster is decommissioned, as an RFC 3339 timestamp (e.g. 2026-12-31T00:00:00Z). Only prepaid clusters accept a change.",
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("clusterId", "Cluster ID"),
    o("clusterName", "Cluster Name"),
    o("region", "Region"),
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description:
        "Kubeconfig YAML for the cluster's Kubernetes API. Fetched on demand, never stored with the listing.",
    }),
  ],
  // The first attached shared volume; a cluster can only attach volumes in
  // its own region.
  dependsOn: [{ fieldKey: "volumeId", targetTypeId: "shared-volume", label: "mounts" }],
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
      // Slurm clusters are driven through Slurm and SSH, not kubectl.
      showWhen: { fieldKey: "clusterType", equals: "KUBERNETES" },
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "server",
});
