/**
 * Lending a MySQL connection to a CI job (`manifest.ciCredential`).
 *
 * - `DATABASE_URL` is the connection string as stored, secret as a whole.
 * - The `mysql` client reads no password from the environment that is not
 *   deprecated (`MYSQL_PWD` is, as of 8.4), so each connection gets an
 *   option group of its own in `~/.my.cnf`, `[client_<alias>]`, and
 *   `MYSQL_GROUP_SUFFIX` names it, so `mysql` with no arguments connects.
 *   Two databases lent to one job keep both groups; the last one named is
 *   the default, and `mysql --defaults-group-suffix=_<alias>` picks another.
 * - A CA certificate the connection holds is written beside it as `ssl-ca`.
 * - The password is also `MYSQL_PASSWORD`, raw, so it is masked bare as well.
 * - `MYSQL_ENDPOINT` (`host:port`) and `MYSQL_USERNAME` are, with
 *   `MYSQL_PASSWORD`, what Terraform's `petoju/mysql` provider reads for
 *   `endpoint`, `username` and `password`. A CA certificate is also named by
 *   `MYSQL_TLS_CA_CERT`, the default of the provider's `custom_tls.ca_cert`,
 *   so an empty `custom_tls {}` block trusts it. The provider's `tls` stays
 *   its own default (`false`) otherwise: the connection string does not say
 *   whether the server wants TLS, so a configuration sets `tls` itself.
 *
 * Verified 2026-11 against the MySQL 8.4 manual (environment variables,
 * option files and `--defaults-group-suffix`) and the provider's
 * documentation and `mysql/provider.go`.
 */
import type {
  CiCredentialDeclaration,
  CiCredentialRequest,
  CiLentFile,
  CiLentMaterial,
  CiLentValue,
} from "@infrawrench/plugin-base";

export const MYSQL_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    "The connection string as DATABASE_URL, its password as MYSQL_PASSWORD, and an option group named after it in ~/.my.cnf that MYSQL_GROUP_SUFFIX selects, so mysql connects with no arguments.",
  shortLived: false,
};

/**
 * An option file value as MySQL's reader (`mysys/my_default.cc`) gives it
 * back, or null when no quoting can: the reader drops a quote of the same
 * kind at both ends and nothing else, ends the line at a `#` outside quotes
 * (a `"` inside `'...'` does not count as one), and turns `\\` into one
 * backslash (and `\s`, `\n` and so on into what they stand for). So a value
 * is quoted with a kind of quote it does not contain, and its backslashes
 * are doubled. One with both kinds of quote is left out.
 */
export function optionValue(value: string): string | null {
  if (/[\r\n]/.test(value)) return null;
  const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : null;
  if (!quote) return null;
  return `${quote}${value.replace(/\\/g, "\\\\")}${quote}`;
}

export function lendMysql(
  connectionString: string,
  caCert: string | undefined,
  request: Pick<CiCredentialRequest, "alias">,
): CiLentMaterial {
  if (!connectionString) throw new Error("The database has no connection string to lend yet.");
  const env: Record<string, CiLentValue> = { DATABASE_URL: connectionString };
  const files: CiLentFile[] = [];
  let user = "";
  let url: URL | null = null;
  try {
    url = new URL(connectionString);
  } catch {
    url = null;
  }
  if (url && /^mysql/.test(url.protocol)) {
    const decode = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    const suffix = `_${request.alias.replace(/-/g, "_")}`;
    const parts: Array<{ text: string } | { secret: string }> = [{ text: `[client${suffix}]\n` }];
    const line = (key: string, value: string) => {
      const quoted = value ? optionValue(value) : null;
      if (quoted) parts.push({ text: `${key}=${quoted}\n` });
    };
    user = decode(url.username);
    const host = decode(url.hostname).replace(/^\[|\]$/g, "");
    const port = url.port || "3306";
    line("host", host);
    line("port", port);
    line("user", user);
    // Go's `host:port`, which wants an IPv6 address in brackets.
    if (host)
      env["MYSQL_ENDPOINT"] = [{ text: `${host.includes(":") ? `[${host}]` : host}:${port}` }];
    if (user) env["MYSQL_USERNAME"] = [{ text: user }];
    const password = decode(url.password);
    const quoted = password ? optionValue(password) : null;
    if (password) {
      // The raw password, so a job that prints it bare is masked too; a
      // client other than mysql reads it from here.
      env["MYSQL_PASSWORD"] = password;
    }
    if (quoted) {
      // The quoted body is the password with its backslashes doubled: where
      // there are none, that is the password itself.
      parts.push(
        { text: `password=${quoted[0]}` },
        { secret: quoted.slice(1, -1) },
        { text: `${quoted[0]}\n` },
      );
    }
    line("database", decode(url.pathname.replace(/^\//, "")));
    const ca = caCert?.trim();
    if (ca) {
      const caPath = `/root/.mysql/${request.alias}-ca.pem`;
      files.push({ path: caPath, mode: "644", content: [{ text: `${ca}\n` }] });
      line("ssl-ca", caPath);
      env["MYSQL_TLS_CA_CERT"] = [{ text: caPath }];
    }
    files.push({ path: "/root/.my.cnf", mode: "600", content: parts });
    env["MYSQL_GROUP_SUFFIX"] = [{ text: suffix }];
  }
  return {
    env,
    files,
    summary: user ? `the connection string for user ${user}` : "the connection string",
  };
}
