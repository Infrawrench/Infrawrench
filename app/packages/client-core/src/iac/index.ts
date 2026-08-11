import type { OwnerSummary } from "../ownership";
import type { IacReconciledResource, IacResourceStatus, IacStateOnlyResource } from "./reconcile";
import type { IacStateFormat } from "./state";
import type { UnderivableTerraformType } from "./type-map";

/**
 * Wire contract for **IaC reconciliation** — the ClickOps detector.
 *
 * Four features in this repo have "Terraform" in the name; this is the one
 * that reads a state document the org already has and classifies synced
 * resources as managed / drifted / unmanaged. See `state.ts` for the naming
 * note and `reconcile.ts` for the classification itself.
 */

export * from "./state";
export * from "./type-map";
export * from "./reconcile";

/** Labels used by every surface, so the three words mean one thing. */
export const IAC_STATUS_LABELS: Record<IacResourceStatus, string> = {
  managed: "Managed",
  drifted: "Drifted",
  unmanaged: "Unmanaged",
};

export const IAC_LIMITS = {
  /** Longest label accepted for an uploaded state. */
  maxLabelChars: 120,
  /** Resources one import-plan request may ask for. */
  maxImportPlanResources: 500,
} as const;

/** A stored state document, as the API reports it (never its attributes). */
export interface IacStateSummary {
  id: string;
  /** User-supplied name, e.g. "prod / us-east-1". */
  label: string;
  /** `null` when the state covers the whole org rather than one account. */
  accountId: string | null;
  accountName: string | null;
  format: IacStateFormat;
  formatVersion: string;
  terraformVersion: string | null;
  serial: number | null;
  lineage: string | null;
  /** Managed resource instances recorded from the document. */
  resourceCount: number;
  dataSourceCount: number;
  redactedAttributeCount: number;
  uploadedByUserId: string | null;
  uploadedByName: string | null;
  parseWarnings: string[];
  createdAt: string;
}

/**
 * "Who made this by hand, and when" — the drift-feed and ownership join that
 * turns a list of unmanaged resources into a list of conversations.
 */
export interface IacResourceAttribution {
  owner: OwnerSummary | null;
  /** When the change timeline first recorded this resource appearing. */
  firstSeenAt: string | null;
}

export type IacReconciliationEntry = IacReconciledResource & IacResourceAttribution;

export interface IacReconciliationResponse {
  state: IacStateSummary;
  resources: IacReconciliationEntry[];
  stateOnly: IacStateOnlyResource[];
  summary: {
    inventoryTotal: number;
    managed: number;
    drifted: number;
    unmanaged: number;
    stateOnly: number;
    undiffable: number;
    stateResources: number;
    dataSourcesIgnored: number;
  };
  /**
   * Plugin resource types whose Terraform type could not be derived from the
   * export mapper. Reported rather than guessed — see `type-map.ts`.
   */
  underivable: UnderivableTerraformType[];
}

export interface IacStateListResponse {
  states: IacStateSummary[];
}

export interface IacStateUploadRequest {
  label: string;
  accountId?: string | null;
  /** The raw state document, as text. */
  document: string;
}

export interface IacImportPlanRequest {
  stateId: string;
  resourceIds: string[];
}

export interface IacImportPlanResponse {
  /** `import` blocks followed by the generated resource stanzas. */
  hcl: string;
  /** Resources that made it into the document. */
  exported: { resourceId: string; address: string; importId: string | null }[];
  /** Resources that could not be expressed, each with a reason. */
  unsupported: { resourceId: string; displayName: string; reason: string }[];
}

/** The managed/unmanaged badge shown on a resource detail page. */
export interface IacResourceStatusResponse {
  status: IacResourceStatus | null;
  stateId: string | null;
  stateLabel: string | null;
  terraformAddress: string | null;
  driftFieldCount: number;
}
