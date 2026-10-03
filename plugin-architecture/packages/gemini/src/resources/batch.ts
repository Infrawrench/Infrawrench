import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * A batch job: asynchronous inference at half the interactive rate, with a
 * 24-hour target turnaround.
 *
 * Verified: https://ai.google.dev/api/batch-mode
 *
 * ⚠️ Batches is an **Operations-shaped** API, not an ordinary collection.
 * `GET /v1beta/batches?pageSize=&pageToken=` returns a `ListOperationsResponse`
 * whose top-level key is **`operations[]`**, not `batches[]`. Each entry is an
 * `Operation` (`name`, `done`, `error`, `response`, `metadata`) and the real
 * batch payload (display name, model, state, per-request counts) lives in
 * `metadata`, typed `GenerateContentBatch`. The fields below are flattened out
 * of that nested shape by the client.
 *
 * Cancel is `POST /v1beta/batches/{id}:cancel`; delete is
 * `DELETE /v1beta/batches/{id}`.
 *
 * Create is `POST /v1beta/models/{model}:batchGenerateContent` with an
 * uploaded JSONL file as input; display name and priority are editable
 * afterwards through `PATCH /v1beta/batches/{id}:updateGenerateContentBatch`
 * (verified 2026-10-03 against the v1beta discovery document).
 */
export const BatchResourceType = rt({
  name: "Batch",
  id: "batch",
  plural: "Batches",
  description: "An asynchronous batch inference job, billed at half the interactive rate",
  fields: [
    f("name", "Operation Name", { editable: false }),
    f("displayName", "Display Name", { required: false }),
    f("priority", "Priority", {
      kind: "number",
      required: false,
      description: "Higher-priority batches are processed first. Negative values are allowed.",
    }),
    f("model", "Model", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("done", "Done", { kind: "boolean", required: false, editable: false }),
    f("createTime", "Created", { required: false, editable: false }),
    f("updateTime", "Updated", { required: false, editable: false }),
    f("endTime", "Ended", { required: false, editable: false }),
    f("requestCount", "Total Requests", { kind: "number", required: false, editable: false }),
    f("pendingRequestCount", "Pending Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("successfulRequestCount", "Successful Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("failedRequestCount", "Failed Requests", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("inputFileName", "Input File", { required: false, editable: false }),
    f("outputFileName", "Output File", { required: false, editable: false }),
    f("errorMessage", "Error", { required: false, editable: false }),
  ],
  outputs: [
    o("batchName", "Batch Name", { description: 'e.g. "batches/abc123"' }),
    o("state", "State"),
    o("outputFileName", "Output File", {
      description: "Files API name holding the JSONL results once the batch succeeds",
    }),
  ],
  // Both are full resource names (`models/…`, `files/…`), which is what the
  // Model and File rows carry in their own `name` field.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", targetKey: "name", label: "runs" },
    { fieldKey: "inputFileName", targetTypeId: "file", targetKey: "name", label: "reads" },
    { fieldKey: "outputFileName", targetTypeId: "file", targetKey: "name", label: "writes" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "batch",
});
