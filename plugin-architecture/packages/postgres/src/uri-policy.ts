/**
 * What a PostgreSQL connection string may ask for when the driver runs in
 * the shared cloud pods rather than on the user's own machine.
 *
 * pg-connection-string copies every query parameter into the client config,
 * and for `sslcert`, `sslkey` and `sslrootcert` it then calls
 * `fs.readFileSync` on the value. On the desktop those paths are the user's
 * own files; on the server they would be the pod's, used as TLS material
 * toward a server the tenant controls. The desktop driver keeps full
 * support; the server driver refuses these before pg sees the string. A
 * vendor CA still works on the server through the account's CA certificate
 * field, which arrives inline rather than as a path.
 */

/** Query parameters pg-connection-string treats as local file paths. */
const FILE_PARAMS = ["sslcert", "sslkey", "sslrootcert"] as const;

/**
 * The query parameters exactly as pg-connection-string will see them: the
 * same space/percent pre-encoding and the same base-URL and dummy-host
 * fallbacks, so a spelling that slips past this parse also slips past pg's.
 */
function pgSearchParams(connectionString: string): URLSearchParams | null {
  // Unix-socket shorthand ("/var/run/postgresql dbname") carries no params.
  if (connectionString.charAt(0) === "/") return null;
  let str = connectionString;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
    str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
  }
  try {
    return new URL(str, "postgres://base").searchParams;
  } catch {
    try {
      return new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base").searchParams;
    } catch {
      // pg cannot parse it either and will fail before reading anything.
      return null;
    }
  }
}

/**
 * A user-facing message when the connection string is unsafe to use on the
 * server, or null when it is acceptable.
 */
export function serverPostgresConnectionStringError(connectionString: string): string | null {
  const params = pgSearchParams(connectionString);
  if (!params) return null;
  const found = FILE_PARAMS.filter((key) => params.has(key));
  if (found.length === 0) return null;
  const list = found.join(", ");
  return found.length === 1
    ? `PostgreSQL connection string rejected: ${list} is a path to a file on the Infrawrench server and is not supported in the cloud app. Remove it from the connection string and paste the CA certificate into the account's CA certificate field instead, or connect from the desktop app.`
    : `PostgreSQL connection string rejected: ${list} are paths to files on the Infrawrench server and are not supported in the cloud app. Remove them from the connection string and paste the CA certificate into the account's CA certificate field instead, or connect from the desktop app.`;
}
