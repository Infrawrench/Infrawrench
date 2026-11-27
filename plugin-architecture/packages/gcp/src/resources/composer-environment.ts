import { f, o, rt } from "@infrawrench/plugin-base";

export const ComposerEnvironmentResourceType = rt({
  name: "Composer Environment",
  id: "composer-environment",
  iconKey: "workflow",
  description: "A Google Cloud Composer managed Apache Airflow environment",
  fields: [
    f("name", "Name"),
    f("location", "Location", { showcase: true }),
    f("state", "State", { showcase: true, required: false }),
    f("imageVersion", "Image Version", { required: false }),
    f("airflowUri", "Airflow URI", { required: false }),
    f("dagGcsPrefix", "DAG GCS Prefix", { required: false }),
  ],
  outputs: [o("airflowUri", "Airflow Web UI")],
  supportsMetrics: true,
  // The Airflow database's `environment/database/disk/utilization` ("Disk
  // quota usage ratio (from 0.0 to 1.0)") and
  // `environment/database/network/connections` over `.../max_connections`
  // ("Maximum permitted number of concurrent connections"), both charted as
  // 0..100 under these labels:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_c, read 2026-11-23
  capacityMetrics: [
    {
      seriesLabel: "Database Disk Utilization",
      limit: { constant: 100 },
      unit: "%",
      label: "Airflow Database Disk",
    },
    {
      seriesLabel: "Database Connections Used",
      limit: { constant: 100 },
      unit: "%",
      label: "Airflow Database Connections",
    },
  ],
});
