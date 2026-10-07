/** Clerk Backend API shapes (only the fields this plugin reads). Timestamps are Unix ms. */

export interface CkInstance {
  id?: string;
  environment_type?: string;
  allowed_origins?: string[];
}

export interface CkRestrictions {
  allowlist?: boolean;
  blocklist?: boolean;
  allowlist_blocklist_disabled_on_sign_in?: boolean;
  block_email_subaddresses?: boolean;
  block_disposable_email_domains?: boolean;
}

export interface CkOrgSettings {
  enabled?: boolean;
  max_allowed_memberships?: number;
  admin_delete_enabled?: boolean;
  domains_enabled?: boolean;
}

export interface CkProtect {
  rules_enabled?: boolean;
  specter_enabled?: boolean;
}

export interface CkUser {
  id?: string;
  external_id?: string | null;
  primary_email_address_id?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email_addresses?: Array<{ id?: string; email_address?: string }>;
  external_accounts?: Array<{ provider?: string }>;
  enterprise_accounts?: Array<{ id?: string }>;
  passkeys?: Array<{ id?: string }>;
  organization_memberships?: Array<{ organization?: { name?: string } }>;
  password_enabled?: boolean;
  two_factor_enabled?: boolean;
  banned?: boolean;
  locked?: boolean;
  last_sign_in_at?: number | null;
  last_active_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export interface CkOrganization {
  id?: string;
  name?: string;
  slug?: string;
  members_count?: number;
  pending_invitations_count?: number;
  max_allowed_memberships?: number;
  admin_delete_enabled?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface CkMembership {
  id?: string;
  role?: string;
  organization?: { id?: string; name?: string };
  public_user_data?: { user_id?: string; identifier?: string };
}

export interface CkOrgRole {
  id?: string;
  key?: string;
  name?: string;
  description?: string;
}

export interface CkDomain {
  id?: string;
  name?: string;
  is_satellite?: boolean;
  frontend_api_url?: string;
  accounts_portal_url?: string | null;
  proxy_url?: string | null;
  cname_targets?: Array<{ host?: string; value?: string; required?: boolean }> | null;
  dns_targets?: Array<{
    host?: string;
    value?: string;
    record_type?: string;
    required?: boolean;
  }> | null;
}

export interface CkJwtTemplate {
  id?: string;
  name?: string;
  claims?: Record<string, unknown>;
  lifetime?: number;
  allowed_clock_skew?: number;
  custom_signing_key?: boolean;
  signing_algorithm?: string;
  created_at?: number;
  updated_at?: number;
}

export interface CkOAuthApp {
  id?: string;
  name?: string;
  client_id?: string;
  public?: boolean;
  scopes?: string;
  redirect_uris?: string[];
  callback_url?: string;
  consent_screen_enabled?: boolean;
  pkce_required?: boolean;
  discovery_url?: string;
  created_at?: number;
  updated_at?: number;
}

export interface CkEnterpriseConnection {
  id?: string;
  name?: string;
  provider?: string;
  active?: boolean;
  domains?: string[];
  organization_id?: string | null;
  sync_user_attributes?: boolean;
  saml_connection?: {
    acs_url?: string;
    sp_entity_id?: string;
    sp_metadata_url?: string;
    idp_certificate_expires_at?: number | null;
  } | null;
  created_at?: number;
  updated_at?: number;
}

export interface CkMachine {
  id?: string;
  name?: string;
  default_token_ttl?: number;
  scoped_machines?: Array<{ id?: string; name?: string }>;
  created_at?: number;
  updated_at?: number;
}

export interface CkIdentifier {
  id?: string;
  identifier?: string;
  identifier_type?: string;
  created_at?: number;
  updated_at?: number;
}

export interface CkInvitation {
  id?: string;
  email_address?: string;
  status?: string;
  role?: string;
  url?: string | null;
  expires_at?: number | null;
  created_at?: number;
  updated_at?: number;
}

export interface CkRedirectUrl {
  id?: string;
  url?: string;
  created_at?: number;
  updated_at?: number;
}

export interface CkSession {
  id?: string;
  client_id?: string;
  status?: string;
  last_active_at?: number;
  expire_at?: number;
}
