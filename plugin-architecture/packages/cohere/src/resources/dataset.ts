import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * An uploaded dataset — training data for fine-tuning, or the input/output of
 * an embed or batch job. Cohere deletes datasets automatically after 30 days.
 *
 * Verified: https://docs.cohere.com/reference/list-datasets
 * `GET /v1/datasets` → `{ datasets: [...] }`, paginated with `limit`/`offset`.
 *
 * ⚠️ Row counts and byte sizes are per-`dataset_parts` entry rather than
 * top-level, and the row field is `num_rows` — so `numRows` and `sizeBytes`
 * below are sums this plugin computes.
 */
export const DatasetResourceType = rt({
  name: "Dataset",
  id: "dataset",
  description: "An uploaded Cohere dataset used for fine-tuning, embed jobs, or batches",
  fields: [
    f("name", "Name"),
    f("datasetType", "Type", { required: false }),
    f("validationStatus", "Validation Status", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
    f("validationError", "Validation Error", { required: false }),
    f("validationWarnings", "Validation Warnings", { required: false }),
    f("partCount", "Parts", { kind: "number", required: false }),
    f("sizeBytes", "Size (bytes)", { required: false }),
    f("numRows", "Rows", { kind: "number", required: false }),
    f("requiredFields", "Required Fields", { required: false }),
  ],
  outputs: [
    o("datasetId", "Dataset ID", {
      description: "Pass as `dataset_id` when creating a fine-tune or an embed job",
    }),
    o("datasetName", "Dataset Name"),
  ],
  iconKey: "storage",
});
