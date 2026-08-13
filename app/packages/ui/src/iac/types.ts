import type {
  IacImportPlanResponse,
  IacReconciliationResponse,
  IacStateSummary,
} from "@infrawrench/client-core";

/**
 * The IaC reconciliation contract lives in client-core so mobile shares one
 * definition; re-exported here the way the change-timeline types are.
 */
export type {
  IacImportPlanResponse,
  IacReconciliationEntry,
  IacReconciliationResponse,
  IacStateSummary,
} from "@infrawrench/client-core";

/** One account as the upload form's scope picker needs it. */
export interface IacAccountOption {
  id: string;
  displayName: string;
}

export interface IacStateUpload {
  label: string;
  /** Null scopes the state to the whole org. */
  accountId: string | null;
  document: string;
}

/**
 * Host-injected data access. Web wraps `apiGet`/`apiPost`; desktop (cloud
 * mode) wraps its cloud IPC — the panel stays platform-agnostic, the same
 * arrangement as `ChangesClient` and `OrphansClient`.
 */
export interface IacClient {
  listStates(): Promise<IacStateSummary[]>;
  uploadState(upload: IacStateUpload): Promise<IacStateSummary>;
  deleteState(stateId: string): Promise<void>;
  reconcile(stateId: string): Promise<IacReconciliationResponse>;
  buildImportPlan(resourceIds: string[]): Promise<IacImportPlanResponse>;
  /** Populates the scope picker. A failure leaves it empty, never blocks the page. */
  listAccounts(): Promise<IacAccountOption[]>;
}
