/** Narrow shapes of the Heroku Platform API payloads this plugin reads (schema 2026-10). */

export interface Ref {
  id: string;
  name?: string;
}

export interface HkApp {
  id: string;
  name: string;
  acm?: boolean;
  archived_at?: string | null;
  build_stack?: Ref | null;
  stack?: Ref | null;
  generation?: Ref | null;
  created_at?: string;
  updated_at?: string;
  released_at?: string | null;
  git_url?: string;
  web_url?: string | null;
  internal_routing?: boolean | null;
  maintenance?: boolean;
  owner?: { id: string; email?: string } | null;
  team?: Ref | null;
  region?: Ref | null;
  space?: (Ref & { shield?: boolean }) | null;
  repo_size?: number | null;
  slug_size?: number | null;
  buildpack_provided_description?: string | null;
}

export interface HkFormation {
  id: string;
  app: Ref;
  type: string;
  command?: string;
  quantity: number;
  size?: string;
  dyno_size?: Ref | null;
  created_at?: string;
  updated_at?: string;
}

export interface HkDyno {
  id: string;
  name: string;
  type?: string;
  state?: string;
  size?: string;
  command?: string;
  app: Ref;
  release?: { id: string; version: number } | null;
  created_at?: string;
  updated_at?: string;
}

export interface HkRelease {
  id: string;
  version: number;
  status?: string;
  description?: string;
  current?: boolean;
  eligible_for_rollback?: boolean;
  user?: { id?: string; email?: string } | null;
  app?: Ref;
  addon_plan_names?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface HkAddon {
  id: string;
  name: string;
  app?: Ref | null;
  addon_service?: Ref | null;
  plan?: Ref | null;
  billed_price?: { cents?: number; contract?: boolean; unit?: string } | null;
  billing_entity?: { id: string; name?: string; type?: string } | null;
  config_vars?: string[];
  state?: string;
  web_url?: string | null;
  provider_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HkDomain {
  id: string;
  hostname: string;
  kind?: "heroku" | "custom";
  cname?: string | null;
  status?: string;
  acm_status?: string | null;
  acm_status_reason?: string | null;
  sni_endpoint?: Ref | null;
  app?: Ref;
  created_at?: string;
  updated_at?: string;
}

export interface HkSniEndpoint {
  id: string;
  name: string;
  display_name?: string | null;
  domains?: string[];
  app?: Ref;
  ssl_cert?: {
    expires_at?: string;
    starts_at?: string;
    issuer?: string;
    subject?: string;
    cert_domains?: string[];
    ca_signed?: boolean;
    self_signed?: boolean;
  };
  created_at?: string;
  updated_at?: string;
}

export interface HkLogDrain {
  id: string;
  url: string;
  token?: string;
  app?: Ref | null;
  addon?: Ref | null;
  created_at?: string;
}

export interface HkPipeline {
  id: string;
  name: string;
  owner?: { id: string; type: string } | null;
  generation?: Ref | null;
  created_at?: string;
  updated_at?: string;
}

export interface HkCoupling {
  id: string;
  app: { id: string };
  pipeline: { id: string };
  stage: string;
  created_at?: string;
}

export interface HkReviewApp {
  id: string;
  app?: { id: string } | null;
  branch?: string;
  pr_number?: number | null;
  status?: string;
  error_status?: string | null;
  message?: string | null;
  pipeline?: { id: string };
  created_at?: string;
}

export interface HkReviewAppConfig {
  automatic_review_apps?: boolean;
  destroy_stale_apps?: boolean;
  stale_days?: number;
  wait_for_ci?: boolean;
  base_name?: string | null;
  repo?: { id?: number };
}

export interface HkSpace {
  id: string;
  name: string;
  team?: Ref | null;
  region?: Ref | null;
  shield?: boolean;
  state?: string;
  cidr?: string;
  data_cidr?: string;
  generation?: Ref | null;
  created_at?: string;
}

export interface HkTeam {
  id: string;
  name: string;
  role?: string | null;
  type?: string;
  default?: boolean;
  enterprise_account?: Ref | null;
  created_at?: string;
}

export interface HkTeamMember {
  email: string;
  role?: string | null;
  two_factor_authentication?: boolean;
  user?: { name?: string | null };
}

export interface HkDynoSize {
  id: string;
  name: string;
  compute?: number;
  memory?: number;
  dedicated?: boolean;
  private_space_only?: boolean;
  cost?: { cents?: number; unit?: string } | null;
  generation?: Ref | null;
}

export interface HkRegion {
  id: string;
  name: string;
  description?: string;
  country?: string;
  locale?: string;
  private_capable?: boolean;
}

export interface HkStack {
  id: string;
  name: string;
  state?: string;
  default?: boolean;
}

export interface HkInvoice {
  id: string;
  number?: number;
  period_start: string;
  period_end?: string;
  charges_total?: number;
  credits_total?: number;
  total?: number;
  addons_total?: number;
  database_total?: number;
  platform_total?: number;
  state?: number;
  payment_status?: string;
}

export interface HkCredit {
  id: string;
  title?: string;
  amount?: number;
  balance?: number;
  expires_at?: string;
}

export interface HkAccount {
  id: string;
  email: string;
  name?: string | null;
  two_factor_authentication?: boolean;
}
