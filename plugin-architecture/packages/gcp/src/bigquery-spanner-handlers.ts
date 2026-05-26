import type { SqlTableMeta } from "@infrawrench/plugin-base";

export interface BigQuerySpannerContext {
  project: string;
  token: () => Promise<string>;
  get: <T>(url: string) => Promise<T>;
}

// Canonical BigQuery externalId formats:
//   bigquery-dataset: "{project}:{datasetId}"
//   bigquery-table:   "{project}:{datasetId}/{tableId}"
// Throws on legacy/malformed ids (e.g. slash-only "{project}/{zone}/{name}")
// instead of silently producing a 404-bound URL.
export function parseBigQueryDatasetExternalId(resourceId: string): {
  project: string;
  datasetId: string;
} {
  const externalId = resourceId.split(":").slice(2).join(":");
  const colonIdx = externalId.indexOf(":");
  if (colonIdx <= 0) {
    throw new Error(
      `BigQuery: malformed resourceId "${resourceId}" — expected externalId in "project:dataset" form, got "${externalId}"`,
    );
  }
  const project = externalId.slice(0, colonIdx);
  const datasetAndMaybeTable = externalId.slice(colonIdx + 1);
  const slashIdx = datasetAndMaybeTable.indexOf("/");
  const datasetId =
    slashIdx === -1 ? datasetAndMaybeTable : datasetAndMaybeTable.slice(0, slashIdx);
  return { project, datasetId };
}

export async function executeBigQueryQuery(
  ctx: BigQuerySpannerContext,
  resourceId: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const { project, datasetId } = parseBigQueryDatasetExternalId(resourceId);
  const tok = await ctx.token();
  const start = Date.now();

  // Submit query job
  const jobRes = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        configuration: {
          query: {
            query: sql,
            useLegacySql: false,
            defaultDataset: { projectId: project, datasetId },
          },
        },
      }),
    },
  );
  if (!jobRes.ok) throw new Error(`BigQuery error ${jobRes.status}: ${await jobRes.text()}`);
  const job = (await jobRes.json()) as Record<string, unknown>;
  const jobRef = job["jobReference"] as Record<string, string>;
  const jobId = jobRef["jobId"];
  const location = jobRef["location"];

  // Poll until complete (BigQuery Jobs.getQueryResults has built-in timeout)
  let data: Record<string, unknown>;
  for (;;) {
    const r = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${jobId}?location=${encodeURIComponent(location ?? "")}&maxResults=1000&timeoutMs=10000`,
      { headers: { Authorization: `Bearer ${tok}` } },
    );
    if (!r.ok) throw new Error(`BigQuery poll error ${r.status}: ${await r.text()}`);
    data = (await r.json()) as Record<string, unknown>;
    if (data["jobComplete"]) break;
  }

  // Parse schema + rows
  const schemaFields =
    ((data["schema"] as Record<string, unknown> | undefined)?.["fields"] as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
  const columns = schemaFields.map((f) => String(f["name"]));
  const rawRows = (data["rows"] as Array<{ f: Array<{ v: unknown }> }> | undefined) ?? [];
  const rows = rawRows.map((r) => {
    const obj: Record<string, unknown> = {};
    r.f.forEach((cell, i) => {
      obj[columns[i] ?? String(i)] = cell.v;
    });
    return obj;
  });

  return { rows, durationMs: Date.now() - start };
}

export async function introspectBigQueryDataset(
  ctx: BigQuerySpannerContext,
  resourceId: string,
): Promise<SqlTableMeta[]> {
  const { project, datasetId } = parseBigQueryDatasetExternalId(resourceId);

  const data = await ctx.get<{ tables?: Array<Record<string, unknown>> }>(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables?maxResults=200`,
  );

  const tableItems = data.tables ?? [];
  const metas = await Promise.all(
    tableItems.slice(0, 100).map(async (t): Promise<SqlTableMeta> => {
      const ref = t["tableReference"] as Record<string, string> | undefined;
      const tableId = ref?.["tableId"] ?? "";
      try {
        const td = await ctx.get<{ schema?: { fields: Array<Record<string, unknown>> } }>(
          `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables/${tableId}`,
        );
        return {
          name: tableId,
          columns: (td.schema?.fields ?? []).map((f) => ({
            name: String(f["name"]),
            type: String(f["type"]),
          })),
          pkColumns: [],
        };
      } catch {
        return { name: tableId, columns: [], pkColumns: [] };
      }
    }),
  );

  return metas;
}

function parseSpannerResourceId(resourceId: string): {
  instance: string;
  database: string;
} {
  const externalId = resourceId.split(":").slice(2).join(":");
  const [instance, database] = externalId.split("/");
  if (!instance || !database) {
    throw new Error(`Invalid Spanner database resourceId: ${resourceId}`);
  }
  return { instance, database };
}

async function spannerRunSql(
  ctx: BigQuerySpannerContext,
  resourceId: string,
  sql: string,
): Promise<{
  rows: Record<string, unknown>[];
  columns: Array<{ name: string; type: string }>;
  durationMs: number;
}> {
  const { instance, database } = parseSpannerResourceId(resourceId);
  const p = ctx.project;
  const tok = await ctx.token();
  const start = Date.now();
  const dbPath = `projects/${p}/instances/${instance}/databases/${database}`;

  // 1. Create session
  const sessionRes = await fetch(`https://spanner.googleapis.com/v1/${dbPath}/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!sessionRes.ok) {
    throw new Error(`Spanner session error ${sessionRes.status}: ${await sessionRes.text()}`);
  }
  const session = (await sessionRes.json()) as { name: string };
  const sessionName = session.name;

  try {
    // 2. Execute SQL
    const execRes = await fetch(`https://spanner.googleapis.com/v1/${sessionName}:executeSql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
    });
    if (!execRes.ok) {
      throw new Error(`Spanner error ${execRes.status}: ${await execRes.text()}`);
    }
    const data = (await execRes.json()) as {
      metadata?: {
        rowType?: { fields?: Array<{ name?: string; type?: { code?: string } }> };
      };
      rows?: unknown[][];
    };

    const fields = data.metadata?.rowType?.fields ?? [];
    const columns = fields.map((f, i) => ({
      name: f.name ?? `col${i}`,
      type: f.type?.code ?? "UNKNOWN",
    }));
    const rawRows = data.rows ?? [];
    const rows = rawRows.map((r) => {
      const obj: Record<string, unknown> = {};
      r.forEach((cell, i) => {
        obj[columns[i]?.name ?? String(i)] = cell;
      });
      return obj;
    });

    return { rows, columns, durationMs: Date.now() - start };
  } finally {
    // 3. Delete session (fire-and-forget — don't block on cleanup)
    fetch(`https://spanner.googleapis.com/v1/${sessionName}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tok}` },
    }).catch((err: unknown) => {
      console.error(`[gcp/spanner] session cleanup failed for ${sessionName}:`, err);
    });
  }
}

export async function executeSpannerQuery(
  ctx: BigQuerySpannerContext,
  resourceId: string,
  _accountId: string,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number }> {
  const { rows, durationMs } = await spannerRunSql(ctx, resourceId, sql);
  return { rows, durationMs };
}

export async function introspectSpannerDatabase(
  ctx: BigQuerySpannerContext,
  resourceId: string,
  _accountId: string,
): Promise<SqlTableMeta[]> {
  const { instance, database } = parseSpannerResourceId(resourceId);
  const p = ctx.project;

  // Fetch the database to determine dialect
  let dialect = "GOOGLE_STANDARD_SQL";
  try {
    const db = await ctx.get<{ databaseDialect?: string }>(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases/${database}`,
    );
    if (db.databaseDialect) dialect = db.databaseDialect;
  } catch {
    /* fall back to GoogleSQL */
  }

  const schemaFilter = dialect === "POSTGRESQL" ? "'public'" : "''";
  // Note: Spanner INFORMATION_SCHEMA column names are case-sensitive. GoogleSQL
  // uses UPPER_SNAKE, PostgreSQL uses lower_snake. Queries below use the
  // appropriate form for each dialect.
  const tablesSql =
    dialect === "POSTGRESQL"
      ? `SELECT table_name FROM information_schema.tables WHERE table_schema = ${schemaFilter} AND table_type = 'BASE TABLE' ORDER BY table_name`
      : `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ${schemaFilter} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`;
  const columnsSql =
    dialect === "POSTGRESQL"
      ? `SELECT table_name, column_name, spanner_type FROM information_schema.columns WHERE table_schema = ${schemaFilter} ORDER BY table_name, ordinal_position`
      : `SELECT TABLE_NAME, COLUMN_NAME, SPANNER_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${schemaFilter} ORDER BY TABLE_NAME, ORDINAL_POSITION`;
  const pksSql =
    dialect === "POSTGRESQL"
      ? `SELECT kcu.table_name, kcu.column_name FROM information_schema.key_column_usage kcu JOIN information_schema.table_constraints tc ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ${schemaFilter}`
      : `SELECT KCU.TABLE_NAME, KCU.COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC ON KCU.CONSTRAINT_NAME = TC.CONSTRAINT_NAME AND KCU.TABLE_SCHEMA = TC.TABLE_SCHEMA WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY' AND TC.TABLE_SCHEMA = ${schemaFilter}`;

  try {
    const [tablesRes, columnsRes, pksRes] = await Promise.all([
      spannerRunSql(ctx, resourceId, tablesSql),
      spannerRunSql(ctx, resourceId, columnsSql),
      spannerRunSql(ctx, resourceId, pksSql),
    ]);

    const tableNameKey = dialect === "POSTGRESQL" ? "table_name" : "TABLE_NAME";
    const columnNameKey = dialect === "POSTGRESQL" ? "column_name" : "COLUMN_NAME";
    const spannerTypeKey = dialect === "POSTGRESQL" ? "spanner_type" : "SPANNER_TYPE";

    const tableNames = tablesRes.rows.map((r) => String(r[tableNameKey] ?? ""));
    return tableNames.map((name) => {
      const columns = columnsRes.rows
        .filter((r) => r[tableNameKey] === name)
        .map((r) => ({
          name: String(r[columnNameKey] ?? ""),
          type: String(r[spannerTypeKey] ?? ""),
        }));
      const pkColumns = pksRes.rows
        .filter((r) => r[tableNameKey] === name)
        .map((r) => String(r[columnNameKey] ?? ""));
      return { name, columns, pkColumns };
    });
  } catch {
    return [];
  }
}
