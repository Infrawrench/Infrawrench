import type { CredentialFieldOption, Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { pdList } from "./api.js";
import { PagerDutyClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import type { PdUser } from "./mappers.js";
import { verifyWebhook } from "./paging.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { pagerdutyTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "pagerduty",
  version: "0.1.0",
  displayName: "PagerDuty",
  description:
    "Incident response and on-call. Manage services, escalation policies, schedules and overrides, teams, maintenance windows, business services and event orchestrations; acknowledge, resolve, reassign and annotate incidents; chart MTTA and MTTR. Alert routing rules can open PagerDuty incidents and page whoever is on call, and PagerDuty incidents show up in Infrawrench.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "REST API Key",
      description:
        "In PagerDuty, open Integrations, then API Access Keys, and create a key (an account admin or owner can). Use a full-access key: a read-only key can list everything but cannot acknowledge incidents, create overrides, subscribe the incident webhook or send alerts to new services.",
      sensitive: true,
      placeholder: "u+AbCdEfGhIjKlMnOpQr",
      helpLink: {
        label: "PagerDuty API access keys",
        url: "https://support.pagerduty.com/main/docs/api-access-keys",
      },
    },
    {
      key: "region",
      label: "Service Region",
      description:
        "Where your PagerDuty account lives. EU accounts sign in at a .eu.pagerduty.com address.",
      sensitive: false,
      optional: true,
      defaultValue: "us",
      regions: [
        { id: "us", label: "United States", location: "api.pagerduty.com" },
        { id: "eu", label: "European Union", location: "api.eu.pagerduty.com" },
      ],
    },
    {
      key: "fromEmail",
      label: "Default Acting User",
      description:
        "Acknowledging, resolving, snoozing and annotating incidents, opening incidents and scheduling maintenance must be done as a PagerDuty user. Infrawrench acts as the signed-in member when their email is a PagerDuty user, and as this user otherwise.",
      sensitive: false,
      optional: true,
      providerOptions: { dependsOn: ["apiKey"], emptyLabel: "Only act as the signed-in member" },
    },
    caCertCredentialField,
  ],
  paging: {
    targetLabel: "Service",
    targetDescription:
      "Alerts open on the service's Events API v2 integration; Infrawrench adds one named Infrawrench when the service has none.",
    supportsAcknowledgeEvent: true,
    onCall: { sourceLabel: "Schedule or escalation policy" },
    incidents: { label: "Incidents", canAcknowledge: true, canResolve: true },
    webhook: { mode: "managed" },
  },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PagerDutyClient(credentials, services),
  terraformExport: pagerdutyTerraformExport,
  verifyPagingWebhook: verifyWebhook,
  async listCredentialOptions(fieldKey, credentials, services): Promise<CredentialFieldOption[]> {
    if (fieldKey !== "fromEmail") return [];
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) return [];
    const users = await pdList<PdUser>(
      {
        apiKey,
        region: (credentials["region"] ?? "").trim() === "eu" ? "eu" : "us",
        ...(credentials["caCert"] ? { caCert: credentials["caCert"] } : {}),
        ...(services?.http ? { http: services.http } : {}),
      },
      "/users",
      "users",
    );
    return users
      .filter((u) => u.email)
      .map((u) => ({
        id: u.email ?? "",
        label: u.name ?? u.email ?? "",
        description: u.email ?? "",
      }));
  },
};
