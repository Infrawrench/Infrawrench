import { f, o, rt } from "@infrawrench/plugin-base";

export const EvaluatorResourceType = rt({
  name: "Evaluator",
  id: "evaluator",
  description:
    "Custom scoring code (Eval Protocol) used by evaluation jobs and as the reward for reinforcement fine-tuning",
  fields: [
    f("displayName", "Display Name", { required: false }),
    f("evaluatorId", "Evaluator ID", { editable: false }),
    f("description", "Description", { required: false }),
    f("state", "State", { required: false, editable: false }),
    f("statusMessage", "Status Message", { required: false, editable: false }),
    f("defaultDataset", "Default Dataset", { required: false, editable: false }),
    f("entryPoint", "Entry Point", { required: false, editable: false }),
    f("sourceType", "Source", { required: false, editable: false }),
    f("githubRepository", "GitHub Repository", { required: false, editable: false }),
    f("commitHash", "Commit", { required: false, editable: false }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createTime", "Created", { required: false, editable: false }),
    f("updateTime", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("evaluatorName", "Evaluator Resource Name"), o("evaluatorId", "Evaluator ID")],
  dependsOn: [
    {
      fieldKey: "defaultDataset",
      targetTypeId: "dataset",
      targetKey: "datasetName",
      label: "defaults to",
    },
  ],
  supportsUpdate: true,
  iconKey: "checklist",
});
