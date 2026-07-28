import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * `GET /v1/evals`, `POST/DELETE /v1/evals/{id}` — verified 2026-07-29 against
 * openapi.yaml v2.3.0 (`listEvals`, `updateEval`, `deleteEval`).
 *
 * Create is deliberately omitted: `POST /v1/evals` requires a
 * `data_source_config` plus a `testing_criteria` array of graders, which is a
 * JSON authoring task rather than a form.
 */
export const EvalResourceType = rt({
  name: "Eval",
  id: "eval",
  description:
    "An evaluation definition — a data source config plus the graders that score each run against it.",
  fields: [
    f("name", "Name"),
    f("dataSourceType", "Data Source", { required: false }),
    f("testingCriteria", "Graders", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("evalId", "Eval ID"), o("name", "Name")],
  iconKey: "checklist",
  supportsUpdate: true,
  supportsDelete: true,
});
