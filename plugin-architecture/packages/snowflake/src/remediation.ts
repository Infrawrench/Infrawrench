import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationResource,
} from "@infrawrench/plugin-base";
import { qualified } from "./api.js";
import { TYPE } from "./resource-types.js";

/**
 * Ready-to-run SQL for Snowflake savings findings, wrapped in the Snowflake
 * CLI's `snow sql -q` so it runs from a terminal against the default
 * connection in `config.toml` (the statement itself can also be pasted into
 * a worksheet). Identifiers are double-quoted for Snowflake and the whole
 * statement is shell-quoted, so a name with quotes or semicolons stays one
 * identifier.
 *
 * References:
 * https://docs.snowflake.com/en/developer-guide/snowflake-cli/command-reference/sql-commands/sql
 * https://docs.snowflake.com/en/sql-reference/sql/alter-warehouse
 * https://docs.snowflake.com/en/sql-reference/sql/alter-task
 */
export function snowflakeRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;

  if (finding.kind === "orphan") {
    if (resource.resourceTypeId !== TYPE.warehouse) return [];
    const wh = warehouseIdent(resource);
    if (!wh) return [];
    return [
      sql(
        `ALTER WAREHOUSE ${wh} SET AUTO_SUSPEND = 60`,
        "Turn auto-suspend on, so the warehouse suspends after 60 idle seconds instead of billing forever.",
      ),
      sql(
        `ALTER WAREHOUSE ${wh} SUSPEND`,
        "Suspend it now; with auto-resume on, the next query starts it again.",
      ),
    ];
  }

  // sleep-schedule
  if (resource.resourceTypeId === TYPE.warehouse) {
    const wh = warehouseIdent(resource);
    if (!wh) return [];
    return [
      sql(
        `ALTER WAREHOUSE ${wh} SUSPEND`,
        "Suspend the warehouse; it stops billing credits until resumed.",
      ),
      sql(
        `ALTER WAREHOUSE ${wh} RESUME IF SUSPENDED`,
        "Resume the warehouse, doing nothing if it is already running.",
      ),
    ];
  }
  if (resource.resourceTypeId === TYPE.task) {
    const name = remediationField(resource, "name");
    const database = remediationField(resource, "database");
    const schema = remediationField(resource, "schema");
    if (!name || !database || !schema) return [];
    const task = qualified(database, schema, name);
    return [
      sql(`ALTER TASK ${task} SUSPEND`, "Suspend the task so its schedule stops running."),
      sql(`ALTER TASK ${task} RESUME`, "Resume the task's schedule."),
    ];
  }
  return [];
}

function warehouseIdent(resource: RemediationResource): string {
  const name = remediationField(resource, "name");
  return name ? qualified(name) : "";
}

function sql(statement: string, description: string): RemediationCommand {
  return {
    tool: "snowflake-sql",
    command: `snow sql -q ${shellQuote(statement)}`,
    description,
    destructive: false,
  };
}
