import { f, o, rt } from "@infrawrench/plugin-base";

export const ComposerEnvironmentResourceType = rt({
  name: "Composer Environment",
  id: "composer-environment",
  description: "A Google Cloud Composer managed Apache Airflow environment",
  fields: [
    f("name", "Name"),
    f("location", "Location"),
    f("state", "State", { required: false }),
    f("imageVersion", "Image Version", { required: false }),
    f("airflowUri", "Airflow URI", { required: false }),
    f("dagGcsPrefix", "DAG GCS Prefix", { required: false }),
  ],
  outputs: [o("airflowUri", "Airflow Web UI")],
});
