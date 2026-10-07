import type { Plugin, PluginManifest } from "@infrawrench/plugin-base";
import { caCertCredentialField } from "@infrawrench/plugin-base";
import { PROMETHEUS_BUSINESS_METRIC_SOURCE } from "./business-metric-source.js";
import { PROM_PREFLIGHT, PromClient } from "./client.js";
import { LOGO_SVG } from "./logo.js";
import { RESOURCE_TYPES } from "./resource-types.js";

const manifest: PluginManifest = {
  id: "prometheus",
  version: "0.1.0",
  displayName: "Prometheus",
  description:
    "Self-hosted Prometheus, or a compatible endpoint (Thanos, Mimir, Cortex, VictoriaMetrics): PromQL queries, scrape targets, rules and alerts, TSDB status and admin tools, and Alertmanager silences and alerts.",
  logoSvg: LOGO_SVG,
  author: "Infrawrench",
  minHostVersion: "0.1.0",
  credentialFields: [
    {
      key: "url",
      label: "Prometheus URL",
      description:
        "The server's base URL with its port: http://prometheus.internal:9090, a Thanos Query URL, Mimir or Cortex with its /prometheus prefix, or VictoriaMetrics (:8428, or vmselect's /select/0/prometheus). For a server on a private network, add an SSH tunnel to this account.",
      sensitive: false,
      placeholder: "http://prometheus.internal:9090",
    },
    {
      key: "username",
      label: "Username",
      description:
        "Only if the server or the proxy in front of it uses basic auth (web.config.yml basic_auth_users, an nginx or Grafana Cloud style gateway).",
      sensitive: false,
      optional: true,
    },
    { key: "password", label: "Password", sensitive: true, optional: true },
    {
      key: "token",
      label: "Bearer Token",
      description: "Instead of basic auth: a bearer token, sent as Authorization: Bearer.",
      sensitive: true,
      optional: true,
      advanced: true,
    },
    {
      key: "tenantId",
      label: "Tenant ID",
      description: "Multi-tenant Mimir or Cortex only: sent as X-Scope-OrgID on every request.",
      sensitive: false,
      optional: true,
      advanced: true,
      placeholder: "team-a",
    },
    {
      key: "alertmanagerUrl",
      label: "Alertmanager URL",
      description:
        "Optional. Adds silences, notified alerts and receivers: http://alertmanager.internal:9093, or Mimir's /alertmanager. Uses the same credentials.",
      sensitive: false,
      optional: true,
      placeholder: "http://alertmanager.internal:9093",
    },
    caCertCredentialField,
  ],
  preflight: PROM_PREFLIGHT,
  businessMetricSource: PROMETHEUS_BUSINESS_METRIC_SOURCE,
  rateLimit: { capacity: 20, refillPerSecond: 10 },
};

export const plugin: Plugin = {
  manifest,
  resourceTypes: RESOURCE_TYPES,
  createClient: (credentials, services) => new PromClient(credentials, services),
};
