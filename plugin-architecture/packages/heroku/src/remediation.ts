import {
  remediationField,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for Heroku savings findings, written for the official `heroku`
 * CLI.
 *
 * - A process type on a sleep schedule is scaled to 0 dynos and back up to its
 *   stored quantity (1 when it was synced while already stopped), the same
 *   formation PATCH the plugin's stop/start actions send.
 * - An add-on with no app is destroyed, after a `pg:backups:capture` for a
 *   Heroku Postgres database whose app is known. Add-on names are globally unique, so
 *   the CLI resolves it without an app; when the row does name one, it is
 *   passed as `--app` and `--confirm` so the command runs unattended.
 *
 * Reference: https://devcenter.heroku.com/articles/heroku-cli-commands
 * (`ps:scale`, `addons:destroy`) and
 * https://devcenter.heroku.com/articles/heroku-postgres-backups.
 */
export function herokuRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  const { kind } = finding;
  if (kind === "sleep-schedule") {
    const { resource } = finding;
    if (resource.resourceTypeId !== "formation") return [];
    const [scopeApp = "", scopeType = ""] = splitScoped(resource.externalId);
    const app =
      remediationField(resource, "appName") || remediationField(resource, "appId") || scopeApp;
    const type = remediationField(resource, "type") || scopeType;
    if (!app || !type) return [];
    const stored = Number(resource.fields["quantity"]);
    const quantity = Number.isInteger(stored) && stored > 0 ? stored : 1;
    return [
      {
        tool: "heroku",
        command: `heroku ps:scale ${shellQuote(`${type}=0`)} --app ${shellQuote(app)}`,
        description: `Scale the ${type} process type to 0 dynos; it stops billing for dyno hours.`,
        destructive: false,
      },
      {
        tool: "heroku",
        command: `heroku ps:scale ${shellQuote(`${type}=${quantity}`)} --app ${shellQuote(app)}`,
        description: `Scale it back up to ${quantity} dyno${quantity === 1 ? "" : "s"}.`,
        destructive: false,
      },
    ];
  }
  if (kind === "orphan") {
    const { resource } = finding;
    if (resource.resourceTypeId !== "add-on") return [];
    const addon = remediationField(resource, "name") || (resource.externalId ?? "").trim();
    if (!addon) return [];
    const app = remediationField(resource, "appName");
    const appFlags = app ? ` --app ${shellQuote(app)} --confirm ${shellQuote(app)}` : "";
    const commands: RemediationCommand[] = [];
    if (app && remediationField(resource, "service") === "heroku-postgresql") {
      commands.push({
        tool: "heroku",
        command: `heroku pg:backups:capture ${shellQuote(addon)} --app ${shellQuote(app)}`,
        description: "Capture a backup of the database first; it stays with the app.",
        destructive: false,
      });
    }
    commands.push({
      tool: "heroku",
      command: `heroku addons:destroy ${shellQuote(addon)}${appFlags}`,
      description: "Permanently destroy the add-on and its data; it stops billing immediately.",
      destructive: true,
    });
    return commands;
  }
  return [];
}

function splitScoped(externalId: string | null): [string, string] {
  const id = (externalId ?? "").trim();
  const slash = id.indexOf("/");
  return slash < 0 ? ["", ""] : [id.slice(0, slash), id.slice(slash + 1)];
}
