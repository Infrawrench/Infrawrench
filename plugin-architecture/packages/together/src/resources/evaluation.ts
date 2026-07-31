import { f, o, rt } from "@infrawrench/plugin-base";

export const EvaluationResourceType = rt({
  name: "Evaluation",
  id: "evaluation",
  description:
    "A Together AI evaluation job — classify, score or compare model outputs against a dataset",
  fields: [
    f("workflowId", "Workflow ID"),
    f("status", "Status", { required: false }),
    f("type", "Type", { required: false }),
    f("ownerId", "Owner", { required: false }),
    f("model", "Model", { required: false }),
    f("judgeModel", "Judge Model", { required: false }),
    f("parameters", "Parameters", { required: false }),
    f("createdAt", "Created", { required: false }),
    f("updatedAt", "Updated", { required: false }),
  ],
  outputs: [o("workflowId", "Workflow ID"), o("status", "Status")],
  // Both are `/models` ids lifted out of the job's `parameters` bag.
  dependsOn: [
    { fieldKey: "model", targetTypeId: "model", label: "evaluates" },
    { fieldKey: "judgeModel", targetTypeId: "model", label: "judged by" },
  ],
  supportsDelete: false,
  iconKey: "dashboard",
});
