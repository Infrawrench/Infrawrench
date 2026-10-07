/** Okta API shapes (only the fields this plugin reads). */

export interface OktaUser {
  id?: string;
  status?: string;
  created?: string;
  activated?: string | null;
  statusChanged?: string | null;
  lastLogin?: string | null;
  lastUpdated?: string;
  passwordChanged?: string | null;
  profile?: Record<string, unknown> & {
    login?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    displayName?: string;
    title?: string;
    department?: string;
    mobilePhone?: string;
  };
}

export interface OktaGroup {
  id?: string;
  type?: string;
  created?: string;
  lastUpdated?: string;
  lastMembershipUpdated?: string;
  profile?: { name?: string; description?: string | null };
  _embedded?: { stats?: { usersCount?: number; appsCount?: number } };
}

export interface OktaApp {
  id?: string;
  name?: string;
  label?: string;
  status?: string;
  signOnMode?: string;
  created?: string;
  lastUpdated?: string;
  features?: string[];
  credentials?: { oauthClient?: { client_id?: string } };
  _links?: { metadata?: { href?: string } };
  [key: string]: unknown;
}

export interface OktaAuthServer {
  id?: string;
  name?: string;
  description?: string;
  audiences?: string[];
  issuer?: string;
  issuerMode?: string;
  status?: string;
  created?: string;
  lastUpdated?: string;
  credentials?: {
    signing?: { rotationMode?: string; nextRotation?: string; lastRotated?: string };
  };
}

export interface OktaScope {
  id?: string;
  name?: string;
  description?: string;
  system?: boolean;
  default?: boolean;
}

export interface OktaPolicy {
  id?: string;
  type?: string;
  name?: string;
  description?: string | null;
  status?: string;
  priority?: number;
  system?: boolean;
  created?: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface OktaRule {
  id?: string;
  name?: string;
  status?: string;
  priority?: number;
  system?: boolean;
}

export interface OktaZoneAddress {
  type?: string;
  value?: string;
}

export interface OktaZone {
  id?: string;
  name?: string;
  type?: string;
  usage?: string;
  status?: string;
  system?: boolean;
  created?: string;
  lastUpdated?: string;
  gateways?: OktaZoneAddress[] | null;
  proxies?: OktaZoneAddress[] | null;
  locations?:
    | Array<{ country?: string; region?: string | null }>
    | { include?: Array<{ country?: string; region?: string | null }> }
    | null;
  asns?: string[] | { include?: string[] } | null;
  [key: string]: unknown;
}

export interface OktaApiToken {
  id?: string;
  name?: string;
  userId?: string;
  clientName?: string;
  created?: string;
  expiresAt?: string;
  lastUpdated?: string;
  tokenWindow?: string;
  network?: { connection?: string; include?: string[]; exclude?: string[] };
}

export interface OktaEventHook {
  id?: string;
  name?: string;
  description?: string | null;
  status?: string;
  verificationStatus?: string;
  created?: string;
  lastUpdated?: string;
  events?: { type?: string; items?: string[] };
  channel?: {
    type?: string;
    version?: string;
    config?: {
      uri?: string;
      headers?: Array<{ key?: string; value?: string }> | null;
      authScheme?: { type?: string; key?: string; value?: string } | null;
    };
  };
}

export interface OktaDomain {
  id?: string;
  domain?: string;
  brandId?: string;
  validationStatus?: string;
  certificateSourceType?: string;
  dnsRecords?: Array<{
    fqdn?: string;
    recordType?: string;
    values?: string[];
    expiration?: string;
  }>;
  publicCertificate?: { expiration?: string; subject?: string; fingerprint?: string } | null;
}

export interface OktaTrustedOrigin {
  id?: string;
  name?: string;
  origin?: string;
  status?: string;
  scopes?: Array<{ type?: string }>;
  created?: string;
  lastUpdated?: string;
}

export interface OktaOrg {
  id?: string;
  companyName?: string;
  subdomain?: string;
  website?: string;
  phoneNumber?: string;
  supportPhoneNumber?: string;
  endUserSupportHelpURL?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  status?: string;
  created?: string;
  lastUpdated?: string;
}

export interface OktaLogEvent {
  uuid?: string;
  published?: string;
  eventType?: string;
  displayMessage?: string;
  severity?: string;
  actor?: { id?: string; type?: string; alternateId?: string; displayName?: string };
  client?: { ipAddress?: string };
  outcome?: { result?: string; reason?: string | null };
  target?: Array<{ id?: string; type?: string; displayName?: string; alternateId?: string }> | null;
}
