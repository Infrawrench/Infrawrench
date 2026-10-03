import { f, o, rt } from "@infrawrench/plugin-base";

export const DpoJobResourceType = rt({
  name: "DPO Job",
  id: "dpo-job",
  plural: "DPO Jobs",
  description:
    "A preference fine-tuning run (DPO or ORPO) trained on chosen/rejected response pairs",
  fields: [
    f("displayName", "Display Name"),
    f("jobId", "Job ID"),
    f("state", "State", { required: false }),
    f("statusMessage", "Status Message", { required: false }),
    f("baseModel", "Base Model", { required: false }),
    f("dataset", "Dataset", { required: false }),
    f("outputModel", "Output Model", { required: false }),
    f("lossMethod", "Loss Method", { required: false }),
    f("klBeta", "KL Beta", { kind: "number", required: false }),
    f("epochs", "Epochs", { kind: "number", required: false }),
    f("learningRate", "Learning Rate", { kind: "number", required: false }),
    f("loraRank", "LoRA Rank", { kind: "number", required: false }),
    f("batchSizeSamples", "Batch Size", { kind: "number", required: false }),
    f("wandbUrl", "Weights & Biases Run", { required: false }),
    f("createdBy", "Created By", { required: false }),
    f("createTime", "Created", { required: false }),
    f("completedTime", "Completed", { required: false }),
  ],
  outputs: [o("jobName", "Job Resource Name"), o("outputModel", "Output Model Name")],
  dependsOn: [
    { fieldKey: "baseModel", targetTypeId: "model", targetKey: "modelName", label: "trained from" },
    { fieldKey: "dataset", targetTypeId: "dataset", targetKey: "datasetName", label: "trains on" },
  ],
  iconKey: "pipeline",
});
