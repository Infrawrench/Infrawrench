import type {
  CreateFieldConfig,
  CreateResourceConfig,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { BoatClient } from "./client.js";
import { WEBHOOK_EVENTS } from "./resource-types.js";
import { HOURS_PER_MONTH, SIZES, hourlyPrice, unavailableReason } from "./sizes.js";
import type { BEnvironment, BLimits, BSandbox, BSavedSnapshot } from "./types.js";

/**
 * Live create forms. Sizes carry the account's own price and are marked when
 * the plan cannot create them; environments, saved snapshots and sandboxes are
 * pickers.
 */

export const NONE = "none";
export const DEFAULT_TTL_SECONDS = 3600;

export const AUTO_STOP_OPTIONS: SelectOption[] = [
  { id: "900", label: "15 minutes" },
  { id: "3600", label: "1 hour" },
  { id: "14400", label: "4 hours" },
  { id: "28800", label: "8 hours" },
  { id: "86400", label: "1 day" },
  { id: "604800", label: "7 days" },
  { id: "2592000", label: "30 days" },
  { id: NONE, label: "Never", description: "Runs, and bills, until someone stops it" },
];

export function sizeOptions(limits: BLimits | undefined): SizeOption[] {
  return SIZES.map((s) => {
    const blocked = unavailableReason(s.id, limits);
    return {
      id: s.id,
      label: `${s.id}${blocked ? ` (${blocked})` : ""}`,
      vcpus: s.vcpus,
      memoryMb: s.memoryGb * 1024,
      diskGb: s.diskGb,
      priceMonthly: Math.round(hourlyPrice(s, limits) * HOURS_PER_MONTH * 100) / 100,
      category: "Sandbox",
    };
  });
}

export function environmentOptions(environments: BEnvironment[]): SelectOption[] {
  return [...environments]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
    .map((e) => ({
      id: e.name,
      label: e.isDefault ? `${e.name} (default)` : e.name,
      ...(e.safeForThirdParties ? { description: "None of your own logins pass in" } : {}),
    }));
}

export function snapshotOptions(snapshots: BSavedSnapshot[]): SelectOption[] {
  return [
    { id: NONE, label: "A fresh machine" },
    ...snapshots
      .filter((s) => s.status === "ready")
      .map((s) => ({
        id: s.name,
        label: s.name,
        description: `Saved from ${s.sourceSandboxId}${s.type ? ` on ${s.type}` : ""}`,
      })),
  ];
}

export function sandboxOptions(sandboxes: BSandbox[]): SelectOption[] {
  return sandboxes
    .filter((s) => s.snapshotAvailable || ["ready", "idle", "running"].includes(s.state))
    .map((s) => ({ id: s.id, label: s.name || s.id, description: `${s.id}, ${s.state}` }));
}

function text(
  key: string,
  label: string,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return { key, label, kind: "text", required: true, ...opts };
}

function select(
  key: string,
  label: string,
  options: SelectOption[],
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required: true,
    options,
    ...(options[0] ? { defaultValue: options[0].id } : {}),
    ...opts,
  };
}

export function autoStopField(defaultValue = String(DEFAULT_TTL_SECONDS)): CreateFieldConfig {
  return select("ttlSeconds", "Auto-stop", AUTO_STOP_OPTIONS, {
    defaultValue,
    description: "Stops the sandbox after this long without activity; a working agent resets it",
  });
}

export function sizeField(limits: BLimits | undefined, required = true): CreateFieldConfig {
  return {
    key: "size",
    label: "Size",
    kind: "size-picker",
    required,
    defaultValue: "default",
    description: "Billed per second while running, nothing while stopped",
    sizes: sizeOptions(limits),
  };
}

export async function buildCreateConfig(
  client: BoatClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "sandbox": {
      const [limits, environments, snapshots] = await Promise.all([
        client.limits().catch(() => undefined),
        client.raw.environments().catch(() => []),
        client.raw.savedSnapshots().catch(() => []),
      ]);
      const envs = environmentOptions(environments);
      return {
        fields: [
          text("name", "Name", { required: false, placeholder: "agent-run-42" }),
          sizeField(limits),
          select("from", "Start From", snapshotOptions(snapshots), {
            required: false,
            description: "A saved snapshot to restore, or a fresh Ubuntu machine",
          }),
          select("environment", "Environment", [{ id: NONE, label: "None" }, ...envs], {
            required: false,
            ...(envs[0] ? { defaultValue: envs[0].id } : {}),
            description:
              "Env vars, secret files, repositories and logins the sandbox starts with. None starts it with nothing of yours",
          }),
          autoStopField(),
          select(
            "visibility",
            "Visibility",
            [
              { id: NONE, label: "Organization default" },
              { id: "shared", label: "Shared", description: "Every member can use it" },
              { id: "private", label: "Private", description: "Only you can use it" },
            ],
            { required: false, description: "Organization sandboxes only" },
          ),
          text("labels", "Labels", { required: false, placeholder: "team=ml, run=nightly" }),
          text("env", "Env Vars", {
            required: false,
            multiline: true,
            placeholder: "API_URL=https://example.com\nDEBUG=1",
            description: "One KEY=value per line, on top of the environment's",
          }),
          {
            key: "setupScript",
            label: "Setup Script",
            kind: "code",
            codeLanguage: "shell",
            required: false,
            description: "Runs once in the background after the sandbox starts",
          },
          text("hostedPorts", "Hosted Ports", {
            required: false,
            placeholder: "3000, 8080",
            description:
              "Ports to serve at https://<subdomain>-<port>.on.boat.dev. Private URLs carry an access token",
          }),
        ],
      };
    }
    case "saved-snapshot": {
      const sandboxes = await client.raw.sandboxes().catch(() => []);
      return {
        fields: [
          text("name", "Name", {
            placeholder: "golden-image",
            description: "Lowercase letters, digits and dashes; up to 63",
          }),
          select("sandboxId", "Sandbox", sandboxOptions(sandboxes), {
            description: "The sandbox whose current state to freeze",
          }),
        ],
      };
    }
    case "environment":
      return {
        fields: [
          text("name", "Name", {
            placeholder: "customer-demos",
            description: "Letters, numbers, dot, dash and underscore; up to 64",
          }),
        ],
      };
    case "webhook":
      return {
        fields: [
          text("name", "Name", { required: false, placeholder: "Production automation" }),
          text("url", "URL", {
            placeholder: "https://example.com/hooks/boat",
            description: "Public HTTPS on port 443",
          }),
          text("events", "Events", {
            defaultValue: WEBHOOK_EVENTS.join(", "),
            description: `Comma-separated, any of ${WEBHOOK_EVENTS.join(", ")}`,
          }),
        ],
      };
    default:
      throw new Error(`boat plugin: "${typeId}" cannot be created`);
  }
}
