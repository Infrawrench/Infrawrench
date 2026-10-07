import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** Spacelift resource types for one account (GraphQL API, 2026-10). */

const ro = { required: false, editable: false } as const;
const num = { kind: "number", required: false, editable: false } as const;
const bool = { kind: "boolean", required: false, editable: false } as const;

export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  accountRoot: true,
  description:
    "The Spacelift account: its billing period, seats and run minutes included in the plan, run minutes used on public and private workers this period, the public worker pool's capacity and queue, and counts of stacks, spaces and worker pools.",
  fields: [
    f("name", "Account", ro),
    f("stackCount", "Stacks", num),
    f("spaceCount", "Spaces", num),
    f("workerPoolCount", "Private Worker Pools", num),
    f("billingPeriodStart", "Billing Period Start", ro),
    f("billingPeriodEnd", "Billing Period End", ro),
    f("allowedSeats", "Seats in Plan", num),
    f("allowedMinutes", "Run Minutes in Plan", num),
    f("publicMinutes", "Public Worker Minutes This Period", num),
    f("privateMinutes", "Private Worker Minutes This Period", num),
    f("pricePerSeat", "Price per Seat", num),
    f("pricePerWorker", "Price per Worker", num),
    f("publicParallelism", "Public Worker Parallelism", num),
    f("publicBusyWorkers", "Busy Public Workers", num),
    f("publicPendingRuns", "Runs Waiting for Public Workers", num),
  ],
  outputs: [o("name", "Account name"), o("url", "Spacelift URL")],
  supportsDelete: false,
  iconKey: "account",
});

export const SpaceResourceType = rt({
  name: "Space",
  id: "space",
  description:
    "A space: a folder of stacks, contexts and policies with its own access. Create, edit or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("inheritEntities", "Inherit Entities", {
      kind: "boolean",
      required: false,
      description:
        "Give access to this space read access to the parent's contexts, policies and integrations.",
    }),
    f("labels", "Labels", { required: false, description: "Comma-separated." }),
    f("parentSpace", "Parent Space", ro),
    f("spaceId", "Space ID", ro),
  ],
  outputs: [o("spaceId", "Space ID")],
  dependsOn: [{ fieldKey: "parentSpace", targetTypeId: "space", label: "inside" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const StackResourceType = rt({
  name: "Stack",
  id: "stack",
  parentTypeId: "space",
  showInSidebar: true,
  description:
    "A stack: tool and version, repository, branch and tracked commit, state, whether it is locked, disabled or blocked, its drift detection schedule and attached contexts. Trigger a tracked or proposed run, lock, unlock, enable, disable, set up drift detection, edit settings, download its state, or delete it. Outputs are separate resources other resources can reference. Charts runs, failures and planned changes.",
  fields: [
    f("name", "Name", ro),
    f("description", "Description", { required: false }),
    f("branch", "Branch"),
    f("projectRoot", "Project Root", { required: false }),
    f("labels", "Labels", {
      required: false,
      description: "Comma-separated. autoattach:<label> attaches contexts and policies.",
    }),
    f("autodeploy", "Autodeploy", {
      kind: "boolean",
      required: false,
      description: "Apply tracked runs without confirmation.",
    }),
    f("autoretry", "Autoretry", { kind: "boolean", required: false }),
    f("protectFromDeletion", "Protect from Deletion", { kind: "boolean", required: false }),
    f("runnerImage", "Runner Image", { required: false }),
    f("state", "State", ro),
    f("stateSetAt", "State Since", ro),
    f("vendor", "Tool", ro),
    f("toolVersion", "Tool Version", ro),
    f("repository", "Repository", ro),
    f("provider", "VCS", ro),
    f("namespace", "Namespace", ro),
    f("commit", "Tracked Commit", ro),
    f("commitMessage", "Commit Message", ro),
    f("commitAuthor", "Commit Author", ro),
    f("spaceName", "Space", ro),
    f("space", "Space ID", ro),
    f("workerPool", "Worker Pool", ro),
    f("workerPoolId", "Worker Pool ID", ro),
    f("administrative", "Administrative", bool),
    f("disabled", "Disabled", bool),
    f("locked", "Locked", bool),
    f("lockedBy", "Locked By", ro),
    f("lockNote", "Lock Note", ro),
    f("blocked", "Blocked by a Dependency", bool),
    f("managesState", "Spacelift Manages State", bool),
    f("driftSchedule", "Drift Detection Schedule", ro),
    f("createdAt", "Created", ro),
    f("stackId", "Stack ID", ro),
  ],
  outputs: [o("stackId", "Stack ID"), o("url", "Spacelift URL")],
  dependsOn: [{ fieldKey: "workerPoolId", targetTypeId: "worker-pool", label: "runs on" }],
  postureChecks: [
    {
      id: "spacelift-stack-unprotected-autodeploy",
      title: "Stack applies without review and can be deleted",
      severity: "low",
      category: "data-protection",
      conditions: [
        { fieldKey: "autodeploy", when: "truthy" },
        { fieldKey: "protectFromDeletion", when: "falsy" },
      ],
      reason:
        "Tracked runs apply without confirmation and nothing stops the stack being deleted. Turn on Protect from Deletion, or require confirmation.",
    },
  ],
  credentialFormats: [
    {
      id: "state",
      label: "Current state (.tfstate)",
      description:
        "The stack's Terraform or OpenTofu state, for stacks whose state Spacelift manages. Upload it under IaC to see which of your synced resources it manages.",
      mediaType: "json",
      filenameTemplate: "{resource}.tfstate",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "stack",
});

export const StackOutputResourceType = rt({
  name: "Stack Output",
  id: "stack-output",
  parentTypeId: "stack",
  showInSidebar: true,
  description:
    "An output of a stack's last tracked run. Its value is an output other resources can reference. Sensitive outputs only have a value when the stack uploads sensitive outputs.",
  fields: [
    f("name", "Name", ro),
    f("sensitive", "Sensitive", bool),
    f("preview", "Value", ro),
    f("description", "Description", ro),
    f("stackName", "Stack", ro),
    f("stackId", "Stack ID", ro),
  ],
  outputs: [o("value", "Value", { sensitive: true }), o("name", "Name")],
  supportsDelete: false,
  iconKey: "output",
  pinnable: false,
});

export const RunResourceType = rt({
  name: "Run",
  id: "run",
  parentTypeId: "stack",
  showInSidebar: true,
  description:
    "A run: tracked, proposed, task or drift detection, its state, commit and planned changes, with every phase's log in the Logs tab. Confirm, discard, cancel, stop or retry it. The 50 most recent runs in the account are listed; create one to trigger a run.",
  fields: [
    f("state", "State", ro),
    f("type", "Type", ro),
    f("title", "Title", ro),
    f("stackName", "Stack", ro),
    f("stackId", "Stack ID", ro),
    f("branch", "Branch", ro),
    f("commit", "Commit", ro),
    f("author", "Author", ro),
    f("triggeredBy", "Triggered By", ro),
    f("drift", "Drift Detection", bool),
    f("needsApproval", "Needs Approval", bool),
    f("canConfirm", "Can Confirm", bool),
    f("canRetry", "Can Retry", bool),
    f("expired", "Expired", bool),
    f("toAdd", "To Add", num),
    f("toChange", "To Change", num),
    f("toDelete", "To Delete", num),
    f("resources", "Resources", num),
    f("createdAt", "Created", ro),
    f("runId", "Run ID", ro),
  ],
  outputs: [o("runId", "Run ID"), o("url", "Spacelift URL")],
  supportsCreate: true,
  supportsDelete: false,
  iconKey: "play",
  pinnable: false,
});

export const ContextResourceType = rt({
  name: "Context",
  id: "context",
  description:
    "A context: shared environment variables and mounted files that stacks and modules attach. Create, edit or delete it, attach it to a stack or detach it, and manage its variables.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("labels", "Labels", {
      required: false,
      description: "Comma-separated. autoattach:<label> attaches it to matching stacks.",
    }),
    f("space", "Space ID", ro),
    f("variableCount", "Variables and Files", num),
    f("attachedStacks", "Attached To", ro),
    f("updatedAt", "Updated", ro),
    f("contextId", "Context ID", ro),
  ],
  outputs: [o("contextId", "Context ID")],
  dependsOn: [{ fieldKey: "space", targetTypeId: "space", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
});

export const ContextVariableResourceType = rt({
  name: "Context Variable",
  id: "context-variable",
  parentTypeId: "context",
  description:
    "An environment variable or mounted file in a context. Plain values are shown and can be referenced; secret ones are write-only. Create, replace or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("value", "Value", {
      required: false,
      description: "For a secret, type a new value to replace it.",
    }),
    f("type", "Type", ro),
    f("writeOnly", "Secret", bool),
    f("description", "Description", { required: false }),
    f("checksum", "Checksum", ro),
    f("contextName", "Context", ro),
    f("contextId", "Context ID", ro),
  ],
  outputs: [
    o("name", "Name"),
    o("value", "Value", { description: "Only for non-secret variables." }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "key",
  pinnable: false,
});

export const PolicyResourceType = rt({
  name: "Policy",
  id: "policy",
  description:
    "A Rego policy (plan, approval, trigger, push, login and more). Edit its body in the Policy tab, its name, description and labels under Edit, attach it to a stack or detach it, create or delete one.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("labels", "Labels", { required: false }),
    f("type", "Type", ro),
    f("space", "Space ID", ro),
    f("lines", "Lines", num),
    f("body", "Body", ro),
    f("attachedStacks", "Attached To", ro),
    f("updatedAt", "Updated", ro),
    f("policyId", "Policy ID", ro),
  ],
  outputs: [o("policyId", "Policy ID")],
  dependsOn: [{ fieldKey: "space", targetTypeId: "space", label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const ModuleResourceType = rt({
  name: "Module",
  id: "module",
  description:
    "A module in Spacelift's private registry: its repository, provider and branch. Edit its description, labels and branch, enable or disable it, or delete it.",
  fields: [
    f("name", "Name", ro),
    f("description", "Description", { required: false }),
    f("branch", "Branch"),
    f("labels", "Labels", { required: false }),
    f("terraformProvider", "Provider", ro),
    f("namespace", "Namespace", ro),
    f("repository", "Repository", ro),
    f("provider", "VCS", ro),
    f("administrative", "Administrative", bool),
    f("space", "Space ID", ro),
    f("moduleId", "Module ID", ro),
  ],
  outputs: [o("moduleId", "Module ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "package",
});

export const WorkerPoolResourceType = rt({
  name: "Worker Pool",
  id: "worker-pool",
  description:
    "A private worker pool and its workers. Edit its name, description and labels, cycle its workers, drain or undrain a worker, or delete it.",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("labels", "Labels", { required: false }),
    f("space", "Space ID", ro),
    f("workers", "Workers", num),
    f("busyWorkers", "Busy Workers", num),
    f("workerPoolId", "Worker Pool ID", ro),
  ],
  outputs: [o("workerPoolId", "Worker pool ID")],
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "server",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  SpaceResourceType,
  StackResourceType,
  StackOutputResourceType,
  RunResourceType,
  ContextResourceType,
  ContextVariableResourceType,
  PolicyResourceType,
  ModuleResourceType,
  WorkerPoolResourceType,
];
