import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ComposerEnvironmentResourceType: ResourceTypeDefinition = {
  id: "composer-environment",
  displayName: "Composer Environment",
  pluralDisplayName: "Composer Environments",
  description: "A Google Cloud Composer managed Apache Airflow environment",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "imageVersion", label: "Image Version", kind: "string", required: false },
    { key: "airflowUri", label: "Airflow URI", kind: "string", required: false },
    { key: "dagGcsPrefix", label: "DAG GCS Prefix", kind: "string", required: false },
  ],
  outputs: [{ key: "airflowUri", label: "Airflow Web UI", sensitive: false }],
  dashboardPinnable: true,
};
