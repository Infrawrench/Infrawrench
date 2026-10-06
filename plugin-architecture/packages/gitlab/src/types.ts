/**
 * The GitLab REST v4 response fields this plugin reads (see `doc/api/*.md`
 * on gitlab-org/gitlab, 2026-10). Everything is optional on purpose: fields
 * vary by tier, role and instance version, and a missing one must read as
 * "unknown", never crash a listing.
 */

export interface GlUserRef {
  id?: number;
  username?: string;
  name?: string;
  state?: string;
  web_url?: string;
}

export interface GlGroup {
  id: number;
  name: string;
  path?: string;
  full_name?: string;
  full_path: string;
  description?: string | null;
  visibility?: string;
  web_url?: string;
  parent_id?: number | null;
  created_at?: string;
  default_branch?: string | null;
  shared_runners_setting?: string;
  marked_for_deletion_on?: string | null;
  archived?: boolean;
}

export interface GlNamespace {
  id: number;
  name?: string;
  full_path?: string;
  kind?: string;
  plan?: string;
  trial?: boolean;
  trial_ends_on?: string | null;
  end_date?: string | null;
  billable_members_count?: number;
  seats_in_use?: number;
  max_seats_used?: number;
  projects_count?: number;
  members_count_with_descendants?: number;
  root_repository_size?: number;
  ci_minutes_usage?: {
    total_minutes_used?: number;
    monthly_minutes_used?: number;
    purchased_minutes_used?: number;
  };
  shared_runners_minutes_limit?: number | null;
  extra_shared_runners_minutes_limit?: number | null;
}

export interface GlAccess {
  access_level?: number;
}

export interface GlProject {
  id: number;
  name: string;
  name_with_namespace?: string;
  path?: string;
  path_with_namespace: string;
  description?: string | null;
  default_branch?: string | null;
  visibility?: string;
  web_url?: string;
  http_url_to_repo?: string;
  ssh_url_to_repo?: string;
  archived?: boolean;
  created_at?: string;
  last_activity_at?: string;
  star_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  topics?: string[];
  namespace?: { id?: number; full_path?: string; kind?: string; name?: string };
  builds_access_level?: string;
  jobs_enabled?: boolean;
  environments_access_level?: string;
  container_registry_access_level?: string;
  container_registry_enabled?: boolean;
  packages_enabled?: boolean;
  releases_access_level?: string;
  ci_config_path?: string | null;
  marked_for_deletion_on?: string | null;
  empty_repo?: boolean;
  statistics?: {
    commit_count?: number;
    storage_size?: number;
    repository_size?: number;
    job_artifacts_size?: number;
    packages_size?: number;
    container_registry_size?: number;
    lfs_objects_size?: number;
  };
  permissions?: { project_access?: GlAccess | null; group_access?: GlAccess | null };
}

export interface GlPipeline {
  id: number;
  iid?: number;
  project_id?: number;
  sha?: string;
  ref?: string;
  status: string;
  source?: string;
  name?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string;
  duration?: number | null;
  queued_duration?: number | null;
  coverage?: string | null;
  tag?: boolean;
  user?: GlUserRef;
  yaml_errors?: string | null;
  detailed_status?: { text?: string; label?: string };
}

export interface GlJob {
  id: number;
  name: string;
  stage?: string;
  status: string;
  ref?: string;
  tag?: boolean;
  allow_failure?: boolean;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  duration?: number | null;
  queued_duration?: number | null;
  failure_reason?: string;
  web_url?: string;
  user?: GlUserRef;
  pipeline?: { id?: number; project_id?: number; ref?: string; status?: string };
  runner?: { id?: number; description?: string; runner_type?: string } | null;
  project?: { id?: number; path_with_namespace?: string; name?: string };
}

export interface GlRunner {
  id: number;
  description?: string | null;
  name?: string | null;
  paused?: boolean;
  active?: boolean;
  is_shared?: boolean;
  runner_type?: string;
  online?: boolean | null;
  status?: string;
  job_execution_status?: string;
  contacted_at?: string | null;
  created_at?: string;
  tag_list?: string[];
  run_untagged?: boolean;
  locked?: boolean;
  access_level?: string;
  maximum_timeout?: number | null;
  maintenance_note?: string | null;
  version?: string | null;
  platform?: string | null;
  architecture?: string | null;
  projects?: Array<{ id: number; path_with_namespace?: string }>;
  groups?: Array<{ id: number; name?: string; web_url?: string }>;
}

export interface GlDeployment {
  id: number;
  iid?: number;
  ref?: string;
  sha?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  finished_at?: string | null;
  user?: GlUserRef;
  environment?: { id?: number; name?: string };
  deployable?: { id?: number; name?: string; status?: string; pipeline?: { id?: number } } | null;
  pending_approval_count?: number;
}

export interface GlEnvironment {
  id: number;
  name: string;
  slug?: string;
  description?: string | null;
  external_url?: string | null;
  state?: string;
  tier?: string;
  created_at?: string;
  updated_at?: string;
  auto_stop_at?: string | null;
  auto_stop_setting?: string | null;
  kubernetes_namespace?: string | null;
  last_deployment?: GlDeployment | null;
}

export interface GlAccessLevelEntry {
  id?: number;
  access_level?: number | null;
  access_level_description?: string;
  user_id?: number | null;
  group_id?: number | null;
  deploy_key_id?: number | null;
}

export interface GlProtectedBranch {
  id: number;
  name: string;
  push_access_levels?: GlAccessLevelEntry[];
  merge_access_levels?: GlAccessLevelEntry[];
  unprotect_access_levels?: GlAccessLevelEntry[];
  allow_force_push?: boolean;
  code_owner_approval_required?: boolean;
  inherited?: boolean;
}

export interface GlVariable {
  key: string;
  value?: string | null;
  variable_type?: string;
  protected?: boolean;
  masked?: boolean;
  hidden?: boolean;
  raw?: boolean;
  environment_scope?: string;
  description?: string | null;
}

export interface GlSchedule {
  id: number;
  description?: string;
  ref?: string;
  cron?: string;
  cron_timezone?: string;
  next_run_at?: string | null;
  active?: boolean;
  created_at?: string;
  updated_at?: string;
  owner?: GlUserRef | null;
  last_pipeline?: { id?: number; sha?: string; ref?: string; status?: string } | null;
  variables?: Array<{ key: string; variable_type?: string }>;
}

export interface GlRegistryRepository {
  id: number;
  name?: string;
  path?: string;
  location?: string;
  project_id?: number;
  created_at?: string;
  cleanup_policy_started_at?: string | null;
  tags_count?: number;
  size?: number;
  status?: string | null;
}

export interface GlRegistryTag {
  name: string;
  path?: string;
  location?: string;
  digest?: string;
  revision?: string;
  short_revision?: string;
  created_at?: string;
  total_size?: number;
}

export interface GlPackage {
  id: number;
  name: string;
  version?: string | null;
  package_type?: string;
  status?: string;
  created_at?: string;
  last_downloaded_at?: string | null;
  project_id?: number;
  project_path?: string;
  pipeline?: { id?: number; status?: string; ref?: string; web_url?: string } | null;
  tags?: Array<{ name?: string } | string>;
  _links?: { web_path?: string };
}

export interface GlPackageFile {
  id: number;
  file_name: string;
  size?: number;
  created_at?: string;
  file_sha256?: string | null;
}

export interface GlDeployKey {
  id: number;
  title: string;
  key?: string;
  fingerprint?: string;
  fingerprint_sha256?: string;
  created_at?: string;
  expires_at?: string | null;
  can_push?: boolean;
}

export interface GlDeployToken {
  id: number;
  name: string;
  username?: string;
  expires_at?: string | null;
  revoked?: boolean;
  expired?: boolean;
  scopes?: string[];
  token?: string;
}

export interface GlHook {
  id: number;
  url: string;
  name?: string | null;
  description?: string | null;
  project_id?: number;
  group_id?: number;
  created_at?: string;
  enable_ssl_verification?: boolean;
  push_events?: boolean;
  push_events_branch_filter?: string | null;
  branch_filter_strategy?: string;
  tag_push_events?: boolean;
  issues_events?: boolean;
  confidential_issues_events?: boolean;
  merge_requests_events?: boolean;
  note_events?: boolean;
  confidential_note_events?: boolean;
  job_events?: boolean;
  pipeline_events?: boolean;
  wiki_page_events?: boolean;
  deployment_events?: boolean;
  releases_events?: boolean;
  milestone_events?: boolean;
  feature_flag_events?: boolean;
  subgroup_events?: boolean;
  member_events?: boolean;
  project_events?: boolean;
  alert_status?: string;
  disabled_until?: string | null;
  token_present?: boolean;
  signing_token_present?: boolean;
}

export interface GlRelease {
  tag_name: string;
  name?: string | null;
  description?: string | null;
  created_at?: string;
  released_at?: string;
  upcoming_release?: boolean;
  author?: GlUserRef;
  commit?: { id?: string; short_id?: string; title?: string };
  milestones?: Array<{ title?: string }>;
  assets?: { count?: number; links?: Array<{ name?: string; url?: string }> };
  _links?: { self?: string };
}

export interface GlMember {
  id: number;
  username: string;
  name?: string;
  state?: string;
  access_level: number;
  expires_at?: string | null;
  created_at?: string;
  web_url?: string;
  membership_state?: string;
  member_role?: { id?: number; name?: string } | null;
  created_by?: GlUserRef;
}

export interface GlUser {
  id: number;
  username: string;
  name?: string;
  is_admin?: boolean;
  namespace_id?: number;
}
