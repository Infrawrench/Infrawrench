import type { SettingDescriptor } from "@infrawrench/plugin-base";

/**
 * Settings-editor rows for the project ("Configuration" tab) and Auth
 * ("Auth Settings" tab). The host renders a form from `{settings}` returned by
 * `getManifest`, and posts back the changed `{id, value}` pairs to
 * `applyManifest`. Ids are `{section}.{api key}` so a single apply can fan out
 * to the five config endpoints a project has.
 *
 * Only keys the PATCH/PUT bodies accept are listed (Postgres config has many
 * read-only GUCs in its GET; those are omitted rather than shown as editable).
 */

type Kind = "toggle" | "number" | "text" | { select: Array<[string, string]> };

interface Spec {
  key: string;
  label: string;
  kind: Kind;
  description?: string;
  group: string;
}

/** Postgres GUCs `PUT /config/database/postgres` accepts. */
const POSTGRES: Spec[] = [
  ["max_connections", "Max connections", "number", "Changing this restarts Postgres."],
  ["statement_timeout", "Statement timeout", "text", "e.g. 8s or 120000 (ms)."],
  ["max_locks_per_transaction", "Max locks per transaction", "number"],
  ["max_worker_processes", "Max worker processes", "number"],
  ["max_parallel_workers", "Max parallel workers", "number"],
  ["max_parallel_workers_per_gather", "Max parallel workers per gather", "number"],
  ["max_parallel_maintenance_workers", "Max parallel maintenance workers", "number"],
  ["max_logical_replication_workers", "Max logical replication workers", "number"],
  ["max_sync_workers_per_subscription", "Max sync workers per subscription", "number"],
  ["max_replication_slots", "Max replication slots", "number"],
  ["max_wal_senders", "Max WAL senders", "number"],
  ["wal_sender_timeout", "WAL sender timeout", "text", "Default unit: ms."],
  ["checkpoint_timeout", "Checkpoint timeout", "text", "Default unit: s."],
  ["log_autovacuum_min_duration", "Log autovacuum min duration", "text", "Default unit: ms."],
  ["log_startup_progress_interval", "Log startup progress interval", "text"],
].map(([key, label, kind, description]) => ({
  key: key!,
  label: label!,
  kind: kind as Kind,
  group: "Postgres",
  ...(description ? { description } : {}),
}));

const SESSION_ROLE: Spec = {
  key: "session_replication_role",
  label: "Session replication role",
  kind: {
    select: [
      ["origin", "origin"],
      ["replica", "replica"],
      ["local", "local"],
    ],
  },
  group: "Postgres",
};

const POOLER: Spec[] = [
  {
    key: "default_pool_size",
    label: "Pool size",
    kind: "number",
    group: "Connection pooler",
    description: "Server connections per user/database pair (0-3000).",
  },
  {
    key: "pool_mode",
    label: "Dedicated pooler mode",
    kind: {
      select: [
        ["transaction", "Transaction"],
        ["session", "Session"],
      ],
    },
    group: "Connection pooler",
  },
];

const POSTGREST: Spec[] = [
  {
    key: "db_schema",
    label: "Exposed schemas",
    kind: "text",
    group: "Data API",
    description: "Comma-separated schemas the REST/GraphQL API exposes.",
  },
  {
    key: "db_extra_search_path",
    label: "Extra search path",
    kind: "text",
    group: "Data API",
  },
  { key: "max_rows", label: "Max rows", kind: "number", group: "Data API" },
  {
    key: "db_pool",
    label: "Pool size",
    kind: "number",
    group: "Data API",
    description: "Empty sizes the pool from the compute size.",
  },
  {
    key: "db_pool_acquisition_timeout",
    label: "Pool acquisition timeout (s)",
    kind: "number",
    group: "Data API",
  },
];

const STORAGE: Spec[] = [
  {
    key: "fileSizeLimit",
    label: "Upload file size limit (bytes)",
    kind: "number",
    group: "Storage",
  },
  {
    key: "features.imageTransformation.enabled",
    label: "Image transformations",
    kind: "toggle",
    group: "Storage",
  },
  { key: "features.s3Protocol.enabled", label: "S3 protocol", kind: "toggle", group: "Storage" },
];

const REALTIME: Spec[] = [
  ["suspend", "Realtime suspended", "toggle"],
  ["private_only", "Private channels only", "toggle"],
  ["presence_enabled", "Presence", "toggle"],
  ["max_concurrent_users", "Max concurrent users", "number"],
  ["max_events_per_second", "Max events per second", "number"],
  ["max_bytes_per_second", "Max bytes per second", "number"],
  ["max_channels_per_client", "Max channels per client", "number"],
  ["max_joins_per_second", "Max joins per second", "number"],
  ["max_presence_events_per_second", "Max presence events per second", "number"],
  ["max_payload_size_in_kb", "Max payload size (KB)", "number"],
  ["connection_pool", "Authorization pool size", "number"],
  ["postgres_changes_pool", "Postgres Changes pool size", "number"],
].map(([key, label, kind]) => ({
  key: key!,
  label: label!,
  kind: kind as Kind,
  group: "Realtime",
}));

export const PROJECT_SECTIONS: Record<string, Spec[]> = {
  postgres: [...POSTGRES, SESSION_ROLE],
  pooler: POOLER,
  postgrest: POSTGREST,
  storage: STORAGE,
  realtime: REALTIME,
};

const PROVIDERS: Array<[string, string]> = [
  ["email", "Email"],
  ["phone", "Phone"],
  ["anonymous_users", "Anonymous sign-ins"],
  ["apple", "Apple"],
  ["azure", "Azure"],
  ["bitbucket", "Bitbucket"],
  ["discord", "Discord"],
  ["facebook", "Facebook"],
  ["figma", "Figma"],
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["google", "Google"],
  ["kakao", "Kakao"],
  ["keycloak", "Keycloak"],
  ["linkedin_oidc", "LinkedIn (OIDC)"],
  ["notion", "Notion"],
  ["slack_oidc", "Slack (OIDC)"],
  ["spotify", "Spotify"],
  ["twitch", "Twitch"],
  ["x", "X / Twitter (OAuth 2.0)"],
  ["workos", "WorkOS"],
  ["web3_solana", "Solana wallets"],
  ["web3_ethereum", "Ethereum wallets"],
  ["zoom", "Zoom"],
];

/** Providers that take an OAuth client id (the secret is write-only and omitted). */
const OAUTH_PROVIDERS = new Set([
  "apple",
  "azure",
  "bitbucket",
  "discord",
  "facebook",
  "figma",
  "github",
  "gitlab",
  "google",
  "kakao",
  "keycloak",
  "linkedin_oidc",
  "notion",
  "slack_oidc",
  "spotify",
  "twitch",
  "x",
  "workos",
  "zoom",
]);

export const PASSWORD_CHARACTER_OPTIONS: Array<[string, string]> = [
  ["", "No requirement"],
  ["abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789", "Letters and digits"],
  [
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    "Lowercase, uppercase and digits",
  ],
  [
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
    "Lowercase, uppercase, digits and symbols",
  ],
];

export const AUTH_SETTINGS: Spec[] = [
  { key: "site_url", label: "Site URL", kind: "text", group: "URLs" },
  {
    key: "uri_allow_list",
    label: "Redirect URLs",
    kind: "text",
    group: "URLs",
    description: "Comma-separated URLs (wildcards allowed) auth may redirect to.",
  },
  { key: "disable_signup", label: "Disable new sign-ups", kind: "toggle", group: "Sign-ups" },
  {
    key: "mailer_autoconfirm",
    label: "Skip email confirmation",
    kind: "toggle",
    group: "Sign-ups",
  },
  {
    key: "security_manual_linking_enabled",
    label: "Manual identity linking",
    kind: "toggle",
    group: "Sign-ups",
  },
  ...PROVIDERS.map(([id, label]): Spec => ({
    key: `external_${id}_enabled`,
    label,
    kind: "toggle",
    group: "Providers",
  })),
  ...PROVIDERS.filter(([id]) => OAUTH_PROVIDERS.has(id)).map(([id, label]): Spec => ({
    key: `external_${id}_client_id`,
    label: `${label} client ID`,
    kind: "text",
    group: "Provider client IDs",
  })),
  {
    key: "password_min_length",
    label: "Minimum password length",
    kind: "number",
    group: "Passwords",
  },
  {
    key: "password_required_characters",
    label: "Required characters",
    kind: { select: PASSWORD_CHARACTER_OPTIONS },
    group: "Passwords",
  },
  {
    key: "password_hibp_enabled",
    label: "Leaked password protection",
    kind: "toggle",
    group: "Passwords",
  },
  {
    key: "security_update_password_require_reauthentication",
    label: "Require reauthentication to change password",
    kind: "toggle",
    group: "Passwords",
  },
  {
    key: "mailer_secure_email_change_enabled",
    label: "Secure email change (confirm both addresses)",
    kind: "toggle",
    group: "Email",
  },
  { key: "mailer_otp_exp", label: "Email OTP expiry (s)", kind: "number", group: "Email" },
  { key: "mailer_otp_length", label: "Email OTP length", kind: "number", group: "Email" },
  { key: "jwt_exp", label: "Access token expiry (s)", kind: "number", group: "Sessions" },
  {
    key: "refresh_token_rotation_enabled",
    label: "Refresh token rotation",
    kind: "toggle",
    group: "Sessions",
  },
  {
    key: "security_refresh_token_reuse_interval",
    label: "Refresh token reuse interval (s)",
    kind: "number",
    group: "Sessions",
  },
  {
    key: "sessions_timebox",
    label: "Session time-box (hours)",
    kind: "number",
    group: "Sessions",
  },
  {
    key: "sessions_inactivity_timeout",
    label: "Inactivity timeout (hours)",
    kind: "number",
    group: "Sessions",
  },
  {
    key: "sessions_single_per_user",
    label: "Single session per user",
    kind: "toggle",
    group: "Sessions",
  },
  { key: "mfa_max_enrolled_factors", label: "Max MFA factors", kind: "number", group: "MFA" },
  { key: "mfa_totp_enroll_enabled", label: "TOTP enrollment", kind: "toggle", group: "MFA" },
  { key: "mfa_totp_verify_enabled", label: "TOTP verification", kind: "toggle", group: "MFA" },
  { key: "mfa_phone_enroll_enabled", label: "Phone enrollment", kind: "toggle", group: "MFA" },
  { key: "mfa_phone_verify_enabled", label: "Phone verification", kind: "toggle", group: "MFA" },
  {
    key: "mfa_web_authn_enroll_enabled",
    label: "WebAuthn enrollment",
    kind: "toggle",
    group: "MFA",
  },
  {
    key: "mfa_web_authn_verify_enabled",
    label: "WebAuthn verification",
    kind: "toggle",
    group: "MFA",
  },
  { key: "passkey_enabled", label: "Passkeys", kind: "toggle", group: "MFA" },
  {
    key: "security_captcha_enabled",
    label: "CAPTCHA protection",
    kind: "toggle",
    group: "Bot protection",
  },
  {
    key: "security_captcha_provider",
    label: "CAPTCHA provider",
    kind: {
      select: [
        ["turnstile", "Cloudflare Turnstile"],
        ["hcaptcha", "hCaptcha"],
      ],
    },
    group: "Bot protection",
  },
  {
    key: "rate_limit_email_sent",
    label: "Emails sent per hour",
    kind: "number",
    group: "Rate limits",
  },
  { key: "rate_limit_sms_sent", label: "SMS sent per hour", kind: "number", group: "Rate limits" },
  {
    key: "rate_limit_verify",
    label: "Verifications per 5 min per IP",
    kind: "number",
    group: "Rate limits",
  },
  {
    key: "rate_limit_token_refresh",
    label: "Token refreshes per 5 min per IP",
    kind: "number",
    group: "Rate limits",
  },
  {
    key: "rate_limit_otp",
    label: "OTP requests per 5 min per IP",
    kind: "number",
    group: "Rate limits",
  },
  {
    key: "rate_limit_anonymous_users",
    label: "Anonymous sign-ins per hour per IP",
    kind: "number",
    group: "Rate limits",
  },
  {
    key: "rate_limit_web3",
    label: "Web3 sign-ins per 5 min per IP",
    kind: "number",
    group: "Rate limits",
  },
  { key: "smtp_admin_email", label: "Sender email", kind: "text", group: "Custom SMTP" },
  { key: "smtp_sender_name", label: "Sender name", kind: "text", group: "Custom SMTP" },
  { key: "smtp_host", label: "Host", kind: "text", group: "Custom SMTP" },
  { key: "smtp_port", label: "Port", kind: "text", group: "Custom SMTP" },
  { key: "smtp_user", label: "Username", kind: "text", group: "Custom SMTP" },
  {
    key: "smtp_max_frequency",
    label: "Min seconds between emails to a user",
    kind: "number",
    group: "Custom SMTP",
  },
];

/** Read a dotted path (`features.s3Protocol.enabled`) out of a config object. */
export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Write a dotted path into a (possibly nested) body object. */
export function writePath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (typeof next !== "object" || next === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function display(value: unknown, kind: Kind): string {
  if (kind === "toggle") return value === true ? "on" : "off";
  if (value === undefined || value === null) return "";
  return String(value);
}

export function descriptors(specs: Spec[], config: unknown, idPrefix: string): SettingDescriptor[] {
  return specs.map((spec) => {
    const value = readPath(config, spec.key);
    const base = {
      id: `${idPrefix}${spec.key}`,
      label: spec.label,
      value: display(value, spec.kind),
      group: spec.group,
      ...(spec.description ? { description: spec.description } : {}),
    };
    if (typeof spec.kind === "object") {
      return {
        ...base,
        control: "select" as const,
        options: spec.kind.select.map(([v, label]) => ({ value: v, label })),
      };
    }
    return { ...base, control: spec.kind };
  });
}

/** Coerce a form value back to what the API expects for the spec's control. */
export function coerce(spec: Spec, value: string): unknown {
  if (spec.kind === "toggle") return value === "on" || value === "true";
  if (spec.kind === "number") {
    if (value.trim() === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`"${spec.label}" must be a number.`);
    return n;
  }
  if (typeof spec.kind === "object" && value === "") return null;
  return value;
}

export function findSpec(specs: Spec[], key: string): Spec | undefined {
  return specs.find((s) => s.key === key);
}

/** Group changed `{id, value}` pairs from the project settings form by section. */
export function groupProjectChanges(
  changes: Array<{ id: string; value: string }>,
): Map<string, Record<string, unknown>> {
  const bodies = new Map<string, Record<string, unknown>>();
  for (const change of changes) {
    const dot = change.id.indexOf(".");
    const section = dot > 0 ? change.id.slice(0, dot) : "";
    const key = change.id.slice(dot + 1);
    const specs = PROJECT_SECTIONS[section];
    const spec = specs ? findSpec(specs, key) : undefined;
    if (!spec) throw new Error(`Unknown Supabase setting "${change.id}".`);
    const body = bodies.get(section) ?? {};
    writePath(body, key, coerce(spec, change.value));
    bodies.set(section, body);
  }
  return bodies;
}

/** Build the PATCH body for changed auth settings. */
export function authChangesBody(
  changes: Array<{ id: string; value: string }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const change of changes) {
    const spec = findSpec(AUTH_SETTINGS, change.id);
    if (!spec) throw new Error(`Unknown Supabase Auth setting "${change.id}".`);
    body[spec.key] = coerce(spec, change.value);
  }
  return body;
}

/** Names of the sign-in methods an auth config has switched on. */
export function enabledProviders(config: Record<string, unknown>): string[] {
  return PROVIDERS.filter(([id]) => config[`external_${id}_enabled`] === true).map(
    ([, label]) => label,
  );
}
