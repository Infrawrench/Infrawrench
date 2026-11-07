import type { components } from "./api-types.gen.js";

/**
 * The Bitbucket Cloud 2.0 response fields this plugin reads, from the generated
 * types. Bitbucket omits what the token cannot see, so almost nothing is promised.
 * The additions are what the API returns beyond the published schema: states and
 * targets it only documents on subtypes behind a discriminator, and fields on
 * environments, steps and deployments it does not document at all.
 */
type Schemas = components["schemas"];

export type BbAccount = Schemas["account"];
export type BbWorkspace = Schemas["workspace"];
export type BbProject = Schemas["project"];
export type BbRepository = Schemas["repository"];

export interface BbState {
  name?: string;
  result?: { name?: string };
  stage?: { name?: string };
}

export type BbPipeline = Schemas["pipeline"] & {
  target?: {
    ref_type?: string;
    ref_name?: string;
    destination?: string;
    source?: string;
    commit?: { hash?: string };
    selector?: { type?: string; pattern?: string };
  };
  trigger?: { name?: string };
  state?: BbState;
  duration_in_seconds?: number;
};

/**
 * One run of a schedule. The document puts the run under `pipeline`, or a failure
 * to start under `error`, on subtypes behind a discriminator. Run fields at the top
 * level are how this page was read before; no live answer has said they never occur.
 */
export type BbScheduleExecution = Partial<BbPipeline> & {
  pipeline?: BbPipeline;
  error?: { key?: string; message?: string };
};

export type BbStep = Schemas["pipeline_step"] & {
  name?: string;
  state?: BbState;
  duration_in_seconds?: number;
  build_seconds_used?: number;
};

export type BbVariable = Schemas["pipeline_variable"] | Schemas["deployment_variable"];

export type BbEnvironment = Schemas["deployment_environment"] & {
  hidden?: boolean;
  environment_type?: { name?: string };
  restrictions?: { admin_only?: boolean };
  lock?: { name?: string; type?: string };
};

export type BbDeployment = Schemas["deployment"] & {
  state?: {
    name?: string;
    status?: { name?: string };
    start_date?: string;
    completion_date?: string;
    deployer?: BbAccount;
  };
  last_update_time?: string;
};

export type BbBranchRestriction = Schemas["branchrestriction"];
export type BbWebhook = Schemas["webhook_subscription"];
export type BbDeployKey = Schemas["deploy_key"] | Schemas["project_deploy_key"];
export type BbRunner = Schemas["pipeline_runner"];
export type BbSchedule = Schemas["pipeline_schedule"];
export type BbCache = Schemas["pipeline_cache"];
