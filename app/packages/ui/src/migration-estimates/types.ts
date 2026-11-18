import type {
  MigrationEstimate,
  MigrationEstimateInput,
  MigrationEstimateResult,
  MigrationTargetProvider,
  MigrationTerraformResult,
} from "@infrawrench/client-core";

/** What turning an estimate into a scenario model returns. */
export interface MigrationScenarioCreated {
  scenarioModelId: string;
  name: string;
  currency: string;
  monthlyDelta: number;
}

/**
 * Host-injected data access for migration estimates: web wraps `apiFetch`,
 * desktop its cloud transport. The writes are optional: a viewer without
 * `costs:write` gets a host that omits them and the panel is read-only.
 */
export interface MigrationEstimatesClient {
  targets(): Promise<MigrationTargetProvider[]>;
  list(): Promise<MigrationEstimate[]>;
  get(estimateId: string): Promise<MigrationEstimate>;
  result(estimateId: string): Promise<MigrationEstimateResult>;
  terraform(estimateId: string): Promise<MigrationTerraformResult>;
  /** The org's services, for a new estimate's source picker. */
  listServices(): Promise<Array<{ id: string; name: string }>>;
  create?(input: MigrationEstimateInput): Promise<MigrationEstimate>;
  update?(estimateId: string, input: MigrationEstimateInput): Promise<MigrationEstimate>;
  remove?(estimateId: string): Promise<void>;
  createScenario?(
    estimateId: string,
    input: { startDate: string; name?: string },
  ): Promise<MigrationScenarioCreated>;
}

/** What a row's name opens: the source resource's detail view. */
export interface MigrationResourceRef {
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
}
