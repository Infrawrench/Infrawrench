/**
 * Lending a PostgreSQL connection to a CI job (`manifest.ciCredential`):
 * what libpq and most drivers read, so `psql` and a migration tool connect
 * as written. Verified 2026-11 against the libpq environment variables and
 * connection service file chapters of the PostgreSQL manual.
 *
 * - `DATABASE_URL` is the connection string as stored, secret as a whole.
 * - `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and
 *   `PGSSLMODE` are its parts, for `psql` with no arguments. Two databases
 *   lent to one job share these names, and the last one named wins.
 * - So each also gets a section named after it in `~/.pg_service.conf`, which
 *   libpq reads by default: `psql service=<alias>` picks one out.
 * - A CA certificate the connection holds is written beside it and named by
 *   `PGSSLROOTCERT` and the service's `sslrootcert`.
 *
 * Nothing is minted: a connection string carries a password that lasts as
 * long as the database user does.
 */
import type {
  CiCredentialDeclaration,
  CiCredentialRequest,
  CiLentFile,
  CiLentMaterial,
  CiLentValue,
} from "@infrawrench/plugin-base";

export const POSTGRES_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    "The connection string as DATABASE_URL, its parts as PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD for psql, and a section named after it in ~/.pg_service.conf, which psql picks with its service= option.",
  shortLived: false,
};

/** The parts of a `postgres://` or `postgresql://` URL, or null for another form. */
export function postgresUrlParts(connectionString: string): {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  sslmode: string;
} | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  return {
    host: decode(url.hostname).replace(/^\[|\]$/g, ""),
    port: url.port || "5432",
    database: decode(url.pathname.replace(/^\//, "")),
    user: decode(url.username),
    password: decode(url.password),
    sslmode: url.searchParams.get("sslmode") ?? "",
  };
}

/** A service file value: one line, as libpq reads it. */
const oneLine = (v: string) => !/[\r\n]/.test(v);

export function lendPostgres(
  connectionString: string,
  caCert: string | undefined,
  request: Pick<CiCredentialRequest, "alias">,
): CiLentMaterial {
  if (!connectionString) {
    throw new Error("The database has no connection string to lend yet.");
  }
  const env: Record<string, CiLentValue> = { DATABASE_URL: connectionString };
  const files: CiLentFile[] = [];
  const ca = caCert?.trim();
  const caPath = `/root/.postgresql/${request.alias}-root.crt`;
  if (ca) {
    files.push({ path: caPath, mode: "644", content: [{ text: `${ca}\n` }] });
    env["PGSSLROOTCERT"] = [{ text: caPath }];
  }
  const parts = postgresUrlParts(connectionString);
  if (parts) {
    if (parts.host) env["PGHOST"] = [{ text: parts.host }];
    env["PGPORT"] = [{ text: parts.port }];
    if (parts.database) env["PGDATABASE"] = [{ text: parts.database }];
    if (parts.user) env["PGUSER"] = [{ text: parts.user }];
    if (parts.password) env["PGPASSWORD"] = parts.password;
    if (parts.sslmode) env["PGSSLMODE"] = [{ text: parts.sslmode }];
    const lines: Array<{ text: string } | { secret: string }> = [{ text: `[${request.alias}]\n` }];
    const line = (key: string, value: string) => {
      if (value && oneLine(value)) lines.push({ text: `${key}=${value}\n` });
    };
    line("host", parts.host);
    line("port", parts.port);
    line("dbname", parts.database);
    line("user", parts.user);
    if (parts.password && oneLine(parts.password)) {
      lines.push({ text: "password=" }, { secret: parts.password }, { text: "\n" });
    }
    line("sslmode", parts.sslmode);
    if (ca) line("sslrootcert", caPath);
    files.push({ path: "/root/.pg_service.conf", mode: "600", content: lines });
  }
  return {
    env,
    files,
    summary: parts?.user ? `the connection string for user ${parts.user}` : "the connection string",
  };
}
