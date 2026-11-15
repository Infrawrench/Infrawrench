/**
 * Lending a MongoDB connection to a CI job (`manifest.ciCredential`): the
 * connection string as `MONGODB_URI`, which `mongosh "$MONGODB_URI"` and
 * every driver take. Nothing is minted: the string's password lasts as long
 * as the database user does.
 */
import type { CiCredentialDeclaration, CiLentMaterial } from "@infrawrench/plugin-base";

export const MONGODB_CI_CREDENTIAL: CiCredentialDeclaration = {
  description: 'The connection string as MONGODB_URI (mongosh "$MONGODB_URI").',
  shortLived: false,
};

export function lendMongo(connectionString: string): CiLentMaterial {
  if (!connectionString) throw new Error("The database has no connection string to lend yet.");
  return { env: { MONGODB_URI: connectionString }, files: [], summary: "the connection string" };
}
