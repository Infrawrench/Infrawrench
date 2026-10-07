import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Ready-to-run `astra` (Astra CLI) commands for savings findings. The CLI
 * authenticates from its `.astrarc` profile (`astra setup`) and addresses
 * databases and PCU groups by name or id; these use the id.
 *
 * - A hibernated database: resume it if it is still needed, else delete it.
 * - An active PCU group no database uses: park it, or delete it.
 * - A PCU group sleep schedule: park and unpark.
 *
 * Astra only parks flexible-capacity groups (zero reserved PCUs); a group with
 * a reserved commitment gets no park command, only the delete.
 * https://docs.datastax.com/en/astra-db-serverless/administration/park-pcu.html
 *
 * References:
 * https://docs.datastax.com/en/astra-cli/commands/astra-db-resume.html
 * https://docs.datastax.com/en/astra-cli/commands/astra-db-delete.html
 * https://docs.datastax.com/en/astra-cli/commands/astra-pcu-park.html
 * https://docs.datastax.com/en/astra-cli/commands/astra-pcu-unpark.html
 * https://docs.datastax.com/en/astra-cli/commands/astra-pcu-delete.html
 */
export function astraRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment" || finding.kind === "oversized") return [];
  const { resource } = finding;

  if (resource.resourceTypeId === T.database && finding.kind === "orphan") {
    const id = remediationId(resource, "databaseId");
    if (!id) return [];
    const q = shellQuote(id);
    return [
      astra(`astra db resume ${q}`, "Resume the database if it is still needed."),
      astra(
        `astra db delete ${q} --yes`,
        "Or terminate it, with all of its data, if it is not.",
        true,
      ),
    ];
  }

  if (resource.resourceTypeId === T.pcuGroup) {
    const id = remediationId(resource, "pcuGroupId");
    if (!id) return [];
    const q = shellQuote(id);
    const reserved = Number(remediationField(resource, "reserved") || 0);
    const parkable = !(reserved > 0);
    if (finding.kind === "sleep-schedule") {
      if (!parkable) return [];
      return [
        astra(`astra pcu park ${q}`, "Park the PCU group, releasing its provisioned capacity."),
        astra(`astra pcu unpark ${q}`, "Unpark it again."),
      ];
    }
    const del = astra(
      `astra pcu delete ${q} --yes`,
      parkable
        ? "Or delete the PCU group if no database will use it."
        : "Delete the PCU group if no database will use it; check your reserved-capacity commitment terms first.",
      true,
    );
    if (!parkable) return [del];
    return [
      astra(
        `astra pcu park ${q}`,
        "Park the PCU group so its hourly capacity stops billing while nothing runs on it.",
      ),
      del,
    ];
  }

  return [];
}

function astra(command: string, description: string, destructive = false): RemediationCommand {
  return { tool: "astra", command, description, destructive };
}
