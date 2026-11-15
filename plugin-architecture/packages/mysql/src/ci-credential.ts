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
 *
 * Verified 2026-11 against the MySQL 8.4 manual (environment variables,
 * option files and `--defaults-group-suffix`).
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
    "The connection string as DATABASE_URL, and an option group named after it in ~/.my.cnf that MYSQL_GROUP_SUFFIX selects, so mysql connects with no arguments.",
  shortLived: false,
};

/** An option file value, quoted the way MySQL reads one. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
      if (value && !/[\r\n]/.test(value)) parts.push({ text: `${key}=${quoted(value)}\n` });
    };
    user = decode(url.username);
    line("host", decode(url.hostname).replace(/^\[|\]$/g, ""));
    line("port", url.port || "3306");
    line("user", user);
    const password = decode(url.password);
    if (password && !/[\r\n]/.test(password)) {
      // The password itself is the masked part where quoting leaves it as
      // it is, so a job that prints it bare is masked too.
      parts.push(
        { text: "password=" },
        ...(/["\\]/.test(password)
          ? [{ secret: quoted(password) }]
          : [{ text: '"' }, { secret: password }, { text: '"' }]),
        { text: "\n" },
      );
    }
    line("database", decode(url.pathname.replace(/^\//, "")));
    const ca = caCert?.trim();
    if (ca) {
      const caPath = `/root/.mysql/${request.alias}-ca.pem`;
      files.push({ path: caPath, mode: "644", content: [{ text: `${ca}\n` }] });
      line("ssl-ca", caPath);
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
