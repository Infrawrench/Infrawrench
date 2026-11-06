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
});
