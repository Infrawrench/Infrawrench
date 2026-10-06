import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { IncidentIoClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { verifyWebhook } from "./paging.js";
import { RESOURCE_TYPES } from "./resource-types.js";
import { parseStatusFeed, statusFeed } from "./status-feed.js";
import { incidentIoTerraformExport } from "./terraform.js";

const manifest: PluginManifest = {
  id: "incident-io",
  version: "0.1.0",
  displayName: "incident.io",
  description:
    "Incident response and on-call. Declare and update incidents, change status and severity, acknowledge and cancel escalations, see who is on call and add schedule overrides, and browse alert sources, alert routes, escalation paths, severities, statuses, catalog types, workflows, status pages and maintenance windows. Alert routing rules can send Infrawrench alerts to an HTTP alert source and page whoever is on call, and incident.io incidents show up in Infrawrench.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "apiKey",
      label: "API Key",
      description:
        "In incident.io, open Settings, then API keys, and create a key. Give it: View data (incidents, catalog, workflows, status pages), Create incidents, Edit incidents (status, severity, updates), View and Manage on-call (schedules, overrides, escalations), and View and Manage alert sources (to read the HTTP source token Infrawrench sends alerts with). Add Manage severities to edit severities, and private incident access to see private incidents.",
      sensitive: true,
      placeholder: "inc_live_xxxxxxxxxxxxxxxxxxxxxxxx",
      helpLink: { label: "incident.io API keys", url: "https://app.incident.io/settings/api-keys" },
    },
    caCertCredentialField,
  ],
  statusFeed,
  paging: {
    targetLabel: "Alert source",
    targetDescription:
      "An HTTP alert source in incident.io. Create one under Alerts, then Sources, and its alert routes decide which escalation path and incident it opens.",
    supportsAcknowledgeEvent: false,
    onCall: { sourceLabel: "Schedule or escalation path" },
    incidents: { label: "Incidents", canAcknowledge: true, canResolve: true },
    webhook: {
      mode: "manual",
      setupHelp:
        "In incident.io, open Settings, then Webhooks, add an endpoint with this URL, subscribe it to the incident, escalation and alert events, then paste its signing secret here.",
    },
  },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new IncidentIoClient(credentials, services),
  parseStatusFeed,
  terraformExport: incidentIoTerraformExport,
  verifyPagingWebhook: verifyWebhook,
};
