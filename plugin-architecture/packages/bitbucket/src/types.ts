/**
 * The Bitbucket Cloud 2.0 response fields this plugin reads (definitions in
 * https://api.bitbucket.org/swagger.json, 2026-10). Every field is optional:
 * Bitbucket omits what the token cannot see, and the API returns more than
 * the published schema in places (environment type, lock, restrictions).
 */

export interface BbLink {
  href?: string;
  name?: string;
}

export interface BbAccount {
  uuid?: string;
  display_name?: string;
  nickname?: string;
  account_id?: string;
}

export interface BbWorkspace {
  uuid?: string;
  slug: string;
  name?: string;
  is_private?: boolean;
  is_privacy_enforced?: boolean;
  forking_mode?: string;
  created_on?: string;
  links?: { html?: BbLink };
}

export interface BbProject {
  uuid?: string;
  key: string;
  name?: string;
  description?: string;
  is_private?: boolean;
  has_publicly_visible_repos?: boolean;
  created_on?: string;
  updated_on?: string;
  links?: { html?: BbLink };
}

export interface BbRepository {
  uuid?: string;
  slug?: string;
  name: string;
  full_name: string;
  description?: string;
  is_private?: boolean;
  language?: string;
  size?: number;
  fork_policy?: string;
  has_issues?: boolean;
  has_wiki?: boolean;
  created_on?: string;
  updated_on?: string;
  mainbranch?: { name?: string } | null;
  project?: { key?: string; name?: string; uuid?: string };
  links?: { html?: BbLink; clone?: BbLink[] };
}

export interface BbState {
  name?: string;
  type?: string;
  result?: { name?: string; type?: string };
  stage?: { name?: string; type?: string };
}

export interface BbPipeline {
  uuid: string;
  build_number?: number;
  creator?: BbAccount;
  target?: {
    type?: string;
    ref_type?: string;
    ref_name?: string;
    destination?: string;
    source?: string;
    commit?: { hash?: string };
    selector?: { type?: string; pattern?: string };
  };
  trigger?: { name?: string; type?: string };
  state?: BbState;
  created_on?: string;
  completed_on?: string | null;
  build_seconds_used?: number;
  duration_in_seconds?: number;
  first_successful?: boolean;
  links?: { html?: BbLink };
}

export interface BbStep {
  uuid: string;
  name?: string;
  started_on?: string | null;
  completed_on?: string | null;
  state?: BbState;
  duration_in_seconds?: number;
  build_seconds_used?: number;
  image?: { name?: string };
  run_number?: number;
}

export interface BbVariable {
  uuid: string;
  key: string;
  value?: string;
  secured?: boolean;
}

export interface BbEnvironment {
  uuid: string;
  name: string;
  slug?: string;
  rank?: number;
  hidden?: boolean;
  environment_type?: { name?: string; rank?: number };
  restrictions?: { admin_only?: boolean };
  lock?: { name?: string; type?: string };
  deployment_gate_enabled?: boolean;
}

export interface BbDeployment {
  uuid: string;
  number?: number;
  state?: {
    name?: string;
    status?: { name?: string };
    start_date?: string;
    completion_date?: string;
    deployer?: BbAccount;
    url?: string;
  };
  environment?: { uuid?: string; name?: string };
  release?: { name?: string; url?: string; commit?: { hash?: string }; created_on?: string };
  last_update_time?: string;
}

export interface BbBranchRestriction {
  id: number;
  kind: string;
  branch_match_kind?: string;
  branch_type?: string;
  pattern?: string;
  value?: number | null;
  users?: BbAccount[];
  groups?: Array<{ slug?: string; name?: string }>;
}

export interface BbWebhook {
  uuid: string;
  url: string;
  description?: string;
  subject_type?: string;
  active?: boolean;
  created_at?: string;
  events?: string[];
  secret_set?: boolean;
}

export interface BbDeployKey {
  id: number;
  key?: string;
  label?: string;
  comment?: string;
  added_on?: string;
  last_used?: string | null;
}

export interface BbRunner {
  uuid: string;
  name: string;
  labels?: string[];
  state?: {
    status?: string;
    version?: { version?: string; current?: string };
    updated_on?: string;
    cordoned?: boolean;
  };
  created_on?: string;
  updated_on?: string;
  oauth_client?: { id?: string; secret?: string; token_endpoint?: string; audience?: string };
}

export interface BbSchedule {
  uuid: string;
  enabled?: boolean;
  cron_pattern?: string;
  created_on?: string;
  updated_on?: string;
  target?: {
    ref_type?: string;
    ref_name?: string;
    selector?: { type?: string; pattern?: string };
  };
}

export interface BbCache {
  uuid: string;
  name?: string;
  path?: string;
  key_hash?: string;
  file_size_bytes?: number;
  created_on?: string;
  pipeline_uuid?: string;
}

export interface BbWorkspaceAccess {
  administrator?: boolean;
  workspace?: BbWorkspace;
}

export interface BbMembership {
  user?: BbAccount;
  permission?: string;
}
