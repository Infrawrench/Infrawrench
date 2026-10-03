/**
 * What a MongoDB connection string may ask for when the driver runs in the
 * shared cloud pods rather than on the user's own machine.
 *
 * The Node driver happily acts on the host's behalf when a URI asks it to:
 * `MONGODB-OIDC` with an `ENVIRONMENT` fetches a token from the pod's
 * metadata server or service-account token file, `MONGODB-AWS` pulls
 * ambient AWS credentials, `GSSAPI` uses the host's Kerberos state, and the
 * `tls*File` options read local paths. Whatever it obtains is then presented
 * to a server the tenant controls. On the desktop all of that is the user's
 * own, so the desktop driver keeps full support; the server driver refuses
 * these URIs before a connection is attempted.
 *
 * The check runs against the driver's own parsed options (`client.options`)
 * rather than the raw URI, so case-insensitive keys, aliases (`tlsCAFile` vs
 * `sslCA`) and percent-encoding are already resolved.
 */

/**
 * Mechanisms that authenticate with only what the URI itself carries.
 * `DEFAULT` negotiates between the SCRAM variants.
 */
const SERVER_SAFE_AUTH_MECHANISMS = new Set(["DEFAULT", "SCRAM-SHA-1", "SCRAM-SHA-256", "PLAIN"]);

/** The subset of the driver's `MongoOptions` the policy reads. */
export interface MongoOptionsLike {
  credentials?: { mechanism?: string } | null | undefined;
  [key: string]: unknown;
}

function mechanismReason(mechanism: string): string {
  switch (mechanism) {
    case "MONGODB-OIDC":
      return "authMechanism=MONGODB-OIDC is not supported in the cloud app, because it would authenticate with the Infrawrench server's own identity. Use a database user and password, or connect from the desktop app.";
    case "MONGODB-AWS":
      return "authMechanism=MONGODB-AWS is not supported in the cloud app, because it would use the Infrawrench server's AWS credentials. Use a database user and password, or connect from the desktop app.";
    case "MONGODB-X509":
      return "authMechanism=MONGODB-X509 is not supported in the cloud app, because it needs a client certificate file on the server. Use a database user and password, or connect from the desktop app.";
    case "GSSAPI":
      return "authMechanism=GSSAPI (Kerberos) is not supported in the cloud app. Use a database user and password, or connect from the desktop app.";
    default:
      return `authMechanism=${mechanism} is not supported in the cloud app. Use a database user and password, or connect from the desktop app.`;
  }
}

/**
 * Every reason the parsed options are unsafe on the server, as user-facing
 * sentences. Empty when the connection string is acceptable.
 */
export function findServerUnsafeMongoOptions(options: MongoOptionsLike): string[] {
  const reasons: string[] = [];
  const mechanism = options.credentials?.mechanism;
  if (mechanism && !SERVER_SAFE_AUTH_MECHANISMS.has(mechanism)) {
    reasons.push(mechanismReason(mechanism));
  }
  // tlsCAFile, tlsCertificateKeyFile, tlsCRLFile and anything the driver adds
  // later under the same naming convention: each is a path the driver reads.
  const fileOptions = Object.keys(options)
    .filter((key) => /File$/.test(key) && typeof options[key] === "string" && options[key] !== "")
    .sort();
  if (fileOptions.length > 0) {
    reasons.push(
      `${fileOptions.join(", ")} ${fileOptions.length === 1 ? "reads a file" : "read files"} on the Infrawrench server and ${fileOptions.length === 1 ? "is" : "are"} not supported in the cloud app. Remove ${fileOptions.length === 1 ? "it" : "them"} from the connection string, or connect from the desktop app.`,
    );
  }
  return reasons;
}

/** One user-facing message for a refused connection string, or null. */
export function mongoRejectionMessage(reasons: string[]): string | null {
  return reasons.length > 0 ? `MongoDB connection string rejected: ${reasons.join(" ")}` : null;
}

/**
 * The driver's mechanism list in its own order (`AuthMechanism` in
 * `mongodb/lib/cmap/auth/providers`). The driver resolves `authMechanism`
 * to the first entry the value matches as a whole word, case-insensitively,
 * so `authMechanism=oidc` means MONGODB-OIDC.
 */
const DRIVER_AUTH_MECHANISMS = [
  "MONGODB-AWS",
  "DEFAULT",
  "GSSAPI",
  "PLAIN",
  "SCRAM-SHA-1",
  "SCRAM-SHA-256",
  "MONGODB-X509",
  "MONGODB-OIDC",
];

/** The file options the driver knows, keyed by lower-cased URI spelling. */
const DRIVER_FILE_OPTIONS = new Map(
  ["tlsCAFile", "tlsCRLFile", "tlsCertificateKeyFile"].map((key) => [key.toLowerCase(), key]),
);

function resolveMechanism(value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(String.raw`\b${escaped}\b`, "i");
  // No match is a parse error in the driver; keep the raw value so the
  // allowlist refuses it rather than guessing.
  return DRIVER_AUTH_MECHANISMS.find((m) => pattern.test(m)) ?? value.toUpperCase();
}

/**
 * The options the policy reads, taken from the raw URI without the driver,
 * for callers that cannot load it (the plugin entry is also bundled into
 * the desktop renderer). Mirrors the driver's case-insensitive keys and its
 * mechanism matching, and errs toward refusing: every value of a repeated
 * key is checked, not only the one the driver would use. The driver-backed
 * check in `./driver.ts` stays the authority at connect time.
 */
export function parseMongoUriOptions(connectionString: string): MongoOptionsLike {
  const queryStart = connectionString.indexOf("?");
  if (queryStart === -1) return {};
  const hashStart = connectionString.indexOf("#", queryStart);
  const query = connectionString.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const options: MongoOptionsLike = {};
  let unsafeMechanism: string | undefined;
  for (const [rawKey, value] of new URLSearchParams(query)) {
    const key = rawKey.toLowerCase();
    if (key === "authmechanism" && value !== "") {
      const mechanism = resolveMechanism(value);
      options.credentials ??= { mechanism };
      if (!SERVER_SAFE_AUTH_MECHANISMS.has(mechanism)) unsafeMechanism ??= mechanism;
    } else if (key.endsWith("file") && value !== "") {
      options[DRIVER_FILE_OPTIONS.get(key) ?? rawKey] = value;
    }
  }
  if (unsafeMechanism) options.credentials = { mechanism: unsafeMechanism };
  return options;
}

/**
 * The server policy as a save-time credential check that does not load the
 * driver: a user-facing message when the connection string is refused, or
 * null. Wired into `Plugin.validateServerCredentials`.
 */
export function serverMongoUriError(connectionString: string): string | null {
  return mongoRejectionMessage(
    findServerUnsafeMongoOptions(parseMongoUriOptions(connectionString)),
  );
}
