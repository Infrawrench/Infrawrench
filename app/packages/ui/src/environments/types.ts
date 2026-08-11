import type {
  CaptureDraft,
  EnvironmentCostEstimate,
  EnvironmentInstance,
  EnvironmentInstantiateInput,
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentTemplateInput,
} from "@infrawrench/client-core";

/**
 * The environments contract lives in client-core so the CLI and any future
 * host share one definition; re-exported here because web and desktop import
 * shared pieces from this package.
 */
export type {
  CaptureDraft,
  CaptureDraftMember,
  EnvironmentCostEstimate,
  EnvironmentInstance,
  EnvironmentInstanceMember,
  EnvironmentInstanceStatus,
  EnvironmentInstantiateInput,
  EnvironmentMemberStatus,
  EnvironmentParameter,
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentTemplateInput,
  EnvironmentTemplateMember,
  TemplateFieldValue,
} from "@infrawrench/client-core";

/** One account as the capture picker needs it. */
export interface EnvironmentAccount {
  id: string;
  displayName: string;
  pluginId: string;
}

/** What the capture form asks the server to look at. */
export interface EnvironmentCaptureSelector {
  resourceIds?: string[];
  accountId?: string;
  tagKey?: string;
  tagValue?: string;
}

/**
 * Host-injected data access, the `ProbesClient` convention: the write methods
 * are optional and their absence renders the panel read-only, so a member who
 * can see the environments but not spend money gets a page that simply has no
 * buttons rather than buttons that 403.
 */
export interface EnvironmentsClient {
  listTemplates(): Promise<EnvironmentTemplate[]>;
  listInstances(): Promise<EnvironmentInstance[]>;
  getSettings(): Promise<EnvironmentSettings>;
  /** Populates the capture picker. */
  listAccounts(): Promise<EnvironmentAccount[]>;
  /** Preview a capture. Persists nothing. */
  captureDraft(selector: EnvironmentCaptureSelector): Promise<CaptureDraft>;

  createTemplate?(input: EnvironmentTemplateInput): Promise<EnvironmentTemplate | null>;
  deleteTemplate?(templateId: string): Promise<void>;
  /** Forward-looking cost of an instantiation, before it runs. */
  estimate?(
    templateId: string,
    body: { parameters?: Record<string, string> },
  ): Promise<EnvironmentCostEstimate | null>;
  instantiate?(
    templateId: string,
    body: EnvironmentInstantiateInput,
  ): Promise<EnvironmentInstance | null>;
  teardown?(instanceId: string): Promise<EnvironmentInstance | null>;
  forget?(instanceId: string): Promise<void>;
  updateSettings?(settings: EnvironmentSettings): Promise<EnvironmentSettings | null>;

  /** Open one of an instance's resources in the host's own resource surface. */
  openResource?(target: {
    accountId: string;
    resourceId: string;
    pluginId: string;
    resourceTypeId: string;
  }): void;
}
