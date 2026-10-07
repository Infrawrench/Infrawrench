/** Auth0 Management API shapes (only the fields this plugin reads). */

export interface A0TenantSettings {
  friendly_name?: string;
  support_email?: string;
  support_url?: string;
  picture_url?: string;
  default_audience?: string;
  default_directory?: string;
  session_lifetime?: number;
  idle_session_lifetime?: number;
  enabled_locales?: string[];
  sandbox_version?: string;
  flags?: Record<string, boolean>;
}

export interface A0Branding {
  colors?: { primary?: string; page_background?: string | Record<string, unknown> };
  logo_url?: string;
  favicon_url?: string;
}

export interface A0Client {
  client_id?: string;
  name?: string;
  description?: string;
  app_type?: string;
  client_secret?: string;
  callbacks?: string[];
  allowed_logout_urls?: string[];
  web_origins?: string[];
  allowed_origins?: string[];
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  is_first_party?: boolean;
  initiate_login_uri?: string;
  logo_uri?: string;
  created_at?: string;
  updated_at?: string;
}

export interface A0ResourceServer {
  id?: string;
  name?: string;
  identifier?: string;
  is_system?: boolean;
  scopes?: Array<{ value?: string; description?: string }>;
  signing_alg?: string;
  token_lifetime?: number;
  token_lifetime_for_web?: number;
  allow_offline_access?: boolean;
  skip_consent_for_verifiable_first_party_clients?: boolean;
  enforce_policies?: boolean;
  token_dialect?: string;
}

export interface A0Connection {
  id?: string;
  name?: string;
  display_name?: string;
  strategy?: string;
  enabled_clients?: string[];
  is_domain_connection?: boolean;
  show_as_button?: boolean;
  realms?: string[];
}

export interface A0User {
  user_id?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nickname?: string;
  blocked?: boolean;
  logins_count?: number;
  last_login?: string;
  last_ip?: string;
  created_at?: string;
  updated_at?: string;
  identities?: Array<{ connection?: string; provider?: string }>;
}

export interface A0Role {
  id?: string;
  name?: string;
  description?: string;
}

export interface A0Organization {
  id?: string;
  name?: string;
  display_name?: string;
  branding?: { logo_url?: string; colors?: { primary?: string; page_background?: string } };
}

export interface A0Trigger {
  id?: string;
  version?: string;
  status?: string;
}

export interface A0Action {
  id?: string;
  name?: string;
  supported_triggers?: Array<{ id?: string; version?: string }>;
  code?: string;
  runtime?: string;
  status?: string;
  all_changes_deployed?: boolean;
  deployed_version?: { id?: string; number?: number } | null;
  dependencies?: Array<{ name?: string; version?: string }>;
  secrets?: Array<{ name?: string }>;
  created_at?: string;
  updated_at?: string;
}

export interface A0Binding {
  id?: string;
  display_name?: string;
  action?: { id?: string; name?: string };
}

export interface A0LogStream {
  id?: string;
  name?: string;
  type?: string;
  status?: string;
  isPriority?: boolean;
  filters?: Array<{ type?: string; name?: string }>;
  sink?: Record<string, unknown>;
}

export interface A0CustomDomain {
  custom_domain_id?: string;
  domain?: string;
  primary?: boolean;
  status?: string;
  type?: string;
  origin_domain_name?: string;
  tls_policy?: string;
  custom_client_ip_header?: string | null;
  verification?: {
    methods?: Array<{ name?: string; record?: string; domain?: string }>;
    status?: string;
    error_msg?: string;
  };
  certificate?: { status?: string; error_msg?: string; renews_before?: string };
}

export interface A0DailyStat {
  date?: string;
  logins?: number;
  signups?: number;
  leaked_passwords?: number;
}

export interface A0Log {
  date?: string | Record<string, unknown>;
  type?: string;
  description?: string | null;
  client_name?: string;
  connection?: string;
  user_name?: string;
  ip?: string;
  log_id?: string;
}
