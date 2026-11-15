/**
 * Lending a MongoDB connection to a CI job (`manifest.ciCredential`): the
 * connection string as `MONGODB_URI`, which `mongosh "$MONGODB_URI"` and
 * every driver take, and its user and password as `MONGODB_USERNAME` and
 * `MONGODB_PASSWORD`, so the bare password is masked wherever a job prints
 * it, not only inside the string. Nothing is minted: the password lasts as
 * long as the database user does.
 */
import type {
  CiCredentialDeclaration,
  CiLentMaterial,
  CiLentValue,
} from "@infrawrench/plugin-base";

export const MONGODB_CI_CREDENTIAL: CiCredentialDeclaration = {
  description:
    'The connection string as MONGODB_URI (mongosh "$MONGODB_URI"), and its user and password as MONGODB_USERNAME and MONGODB_PASSWORD.',
  shortLived: false,
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function lendMongo(connectionString: string): CiLentMaterial {
  if (!connectionString) throw new Error("The database has no connection string to lend yet.");
  const env: Record<string, CiLentValue> = { MONGODB_URI: connectionString };
  try {
    // `mongodb+srv://` parses like any URL; a host list (`h1,h2:27017`) does too.
    const url = new URL(connectionString);
    const user = decode(url.username);
    const password = decode(url.password);
    if (user) env["MONGODB_USERNAME"] = [{ text: user }];
    if (password) env["MONGODB_PASSWORD"] = password;
  } catch {
    // Not a URL: lent as it is, masked as a whole.
  }
  return { env, files: [], summary: "the connection string" };
}
