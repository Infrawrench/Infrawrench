/**
 * Account identifier parsing.
 *
 * Snowflake accepts several spellings of the same account, and users copy
 * whichever one their browser shows them. Verified against "Account
 * identifiers" (docs.snowflake.com/en/user-guide/admin-account-identifier,
 * 2026-10):
 *
 * - `orgname-accountname` is the preferred identifier, and the host is
 *   `orgname-accountname.snowflakecomputing.com`. Account names may contain
 *   underscores; the URL also accepts the same name with hyphens, which is the
 *   form used here because underscores are not valid in DNS host names.
 * - `orgname.accountname` is the SQL and connector spelling of the same thing.
 * - Snowsight shows `https://app.snowflake.com/<orgname>/<accountname>/...`.
 * - Legacy account locators carry the region and cloud
 *   (`xy12345.us-east-2.aws`), and the host is the locator plus the
 *   snowflakecomputing.com suffix.
 * - Private connectivity adds `.privatelink` before the suffix.
 *
 * The key-pair JWT wants the account identifier *without* region
 * information, upper-cased, with any period replaced by a hyphen (SQL API
 * "Authenticating to the server": periods invalidate the JWT).
 */

export interface SnowflakeAccount {
  /** Host name the SQL API is served from, without scheme. */
  host: string;
  /** Account identifier for the JWT `iss`/`sub` claims, upper-case. */
  jwtAccount: string;
  /** Human form shown in the UI, e.g. `myorg-myaccount`. */
  display: string;
}

const SUFFIX = ".snowflakecomputing.com";

/**
 * Accepts every form above and returns the host and JWT account. Throws a
 * user-facing error when nothing usable remains.
 */
export function parseAccount(input: string): SnowflakeAccount {
  let raw = (input ?? "").trim();
  if (!raw) throw new Error("Enter your Snowflake account identifier or URL.");

  // Snowsight: https://app.snowflake.com/<org>/<account>/...
  const snowsight = raw.match(/app\.snowflake\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (snowsight) {
    const org = snowsight[1]!;
    const acct = snowsight[2]!;
    // Snowsight also has a legacy `/<region>/<locator>/` shape; a region has
    // a hyphen or a dot-separated cloud, an organization name never does.
    if (/^[a-z]+-[a-z]+-\d|\./i.test(org)) {
      return fromLocator(`${acct}.${org}`);
    }
    return fromOrgAccount(org, acct, false);
  }

  raw = raw.replace(/^[a-z]+:\/\//i, "");
  raw = raw.split(/[/?#]/)[0] ?? "";
  if (raw.toLowerCase().endsWith(SUFFIX)) raw = raw.slice(0, -SUFFIX.length);
  raw = raw.replace(/\.+$/, "");
  if (!raw) throw new Error("Enter your Snowflake account identifier or URL.");

  let privatelink = false;
  if (/\.privatelink$/i.test(raw)) {
    privatelink = true;
    raw = raw.replace(/\.privatelink$/i, "");
  }

  // orgname.accountname (connector spelling): exactly two parts with no
  // cloud suffix and no region-looking first part.
  const parts = raw.split(".");
  if (parts.length === 2 && !isLocatorRegion(parts[1]!)) {
    return fromOrgAccount(parts[0]!, parts[1]!, privatelink);
  }
  if (parts.length >= 2) return fromLocator(raw, privatelink);

  const dash = raw.indexOf("-");
  if (dash > 0 && dash < raw.length - 1) {
    return fromOrgAccount(raw.slice(0, dash), raw.slice(dash + 1), privatelink);
  }
  // A bare locator (AWS US West, Oregon has no region segment).
  return fromLocator(raw, privatelink);
}

function isLocatorRegion(segment: string): boolean {
  return /^[a-z]+(-[a-z0-9]+)+$/i.test(segment) && /\d/.test(segment);
}

function fromOrgAccount(org: string, acct: string, privatelink: boolean): SnowflakeAccount {
  const o = org.trim();
  const a = acct.trim();
  if (!/^[A-Za-z0-9_]+$/.test(o) || !/^[A-Za-z0-9_-]+$/.test(a)) {
    throw new Error(`"${o}-${a}" does not look like a Snowflake account identifier.`);
  }
  const hostAccount = `${o}-${a.replace(/_/g, "-")}`.toLowerCase();
  return {
    host: `${hostAccount}${privatelink ? ".privatelink" : ""}${SUFFIX}`,
    jwtAccount: `${o}-${a}`.toUpperCase(),
    display: `${o}-${a}`.toLowerCase(),
  };
}

function fromLocator(raw: string, privatelink = false): SnowflakeAccount {
  const locator = raw.split(".")[0] ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(locator)) {
    throw new Error(`"${raw}" does not look like a Snowflake account identifier.`);
  }
  return {
    host: `${raw.toLowerCase()}${privatelink ? ".privatelink" : ""}${SUFFIX}`,
    jwtAccount: locator.toUpperCase().replace(/\./g, "-"),
    display: raw.toLowerCase(),
  };
}

/** `https://app.snowflake.com/` deep link for the account, when the identifier is org-account. */
export function snowsightUrl(account: SnowflakeAccount): string {
  const m = account.display.match(/^([a-z0-9_]+)-([a-z0-9_-]+)$/);
  return m ? `https://app.snowflake.com/${m[1]}/${m[2]}/` : "https://app.snowflake.com/";
}
