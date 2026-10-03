import { f, o, rt } from "@infrawrench/plugin-base";

export const EvaluationJobResourceType = rt({
  name: "Evaluation Job",
  id: "evaluation-job",
  description: "A run of an evaluator over a dataset, with the aggregate scores it produced",
  fields: [
    f("displayName", "Display Name"),
    f("jobId", "Job ID"),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("evaluator", "Evaluator", { required: false }),
    f("inputDataset", "Input Dataset", { required: false }),
    f("outputDataset", "Output Dataset", { required: false }),
    f("metrics", "Metrics", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createTime", "Created", { required: false }),
    f("updateTime", "Updated", { required: false }),
  ],
  outputs: [o("jobName", "Job Resource Name"), o("outputDataset", "Output Dataset Name")],
  dependsOn: [
    {
      fieldKey: "evaluator",
      targetTypeId: "evaluator",
      targetKey: "evaluatorName",
      label: "scored by",
    },
    {
      fieldKey: "inputDataset",
      targetTypeId: "dataset",
      targetKey: "datasetName",
      label: "reads",
    },
    {
      fieldKey: "outputDataset",
      targetTypeId: "dataset",
      targetKey: "datasetName",
      label: "writes",
    },
  ],
  iconKey: "dashboard",
});
