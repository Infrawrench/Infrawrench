export interface CloudSqlEngineInfo {
  /** URL scheme without "://" — postgres, mysql, sqlserver */
  scheme: string;
  /** Default admin username Cloud SQL provisions for the engine */
  username: string;
  /** Default port the engine listens on */
  port: string;
  /** Default database to include in the URL path (empty for engines without one) */
  database: string;
}

export function engineInfoFromVersion(databaseVersion: string): CloudSqlEngineInfo {
  if (databaseVersion.startsWith("MYSQL_")) {
    return { scheme: "mysql", username: "root", port: "3306", database: "" };
  }
  if (databaseVersion.startsWith("SQLSERVER_")) {
    return { scheme: "mssql", username: "sqlserver", port: "1433", database: "master" };
  }
  return { scheme: "postgres", username: "postgres", port: "5432", database: "postgres" };
}

export function buildConnectionUrl(
  databaseVersion: string,
  ipAddress: string,
  password: string,
): string {
  if (!ipAddress) return "";
  const { scheme, username, port, database } = engineInfoFromVersion(databaseVersion);
  const pw = encodeURIComponent(password);
  const path = database ? `/${database}` : "";
  // Cloud SQL SQL Server requires SSL; skip strict cert verification by default
  // since Cloud SQL terminates TLS with its own internal CA.
  const query = scheme === "mssql" ? "?encrypt=true&trustServerCertificate=true" : "";
  return `${scheme}://${username}:${pw}@${ipAddress}:${port}${path}${query}`;
}
