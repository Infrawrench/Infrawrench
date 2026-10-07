import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

const ro = { required: false, editable: false } as const;
const num = (key: string, label: string) => f(key, label, { ...ro, kind: "number" });
const bool = (key: string, label: string) => f(key, label, { ...ro, kind: "boolean" });

export const ServerResourceType = rt({
  name: "Server",
  id: "prometheus-server",
  accountRoot: true,
  description:
    "The Prometheus-compatible server this connection queries (Prometheus, Thanos Query, Mimir, Cortex or VictoriaMetrics): version, retention, head series, target health, rules and firing alerts. Run PromQL in the Query tab, read the loaded configuration, reload it, and use the TSDB admin tools. The Metrics tab charts ingestion, series and target health.",
  fields: [
    f("url", "URL", ro),
    f("version", "Version", ro),
    f("revision", "Revision", ro),
    f("goVersion", "Go Version", ro),
    f("startTime", "Started", ro),
    f("storageRetention", "Retention", ro),
    bool("reloadConfigSuccess", "Last Reload Succeeded"),
    f("lastConfigTime", "Config Loaded", ro),
    num("headSeries", "Head Series"),
    num("headChunks", "Head Chunks"),
    f("oldestHeadSample", "Oldest Head Sample", ro),
    num("targetsUp", "Targets Up"),
    num("targetsDown", "Targets Down"),
    num("scrapePools", "Scrape Pools"),
    num("ruleGroups", "Rule Groups"),
    num("rules", "Rules"),
    num("rulesUnhealthy", "Unhealthy Rules"),
    num("alertsFiring", "Firing Alerts"),
    num("alertsPending", "Pending Alerts"),
    f("alertmanagers", "Alertmanagers", ro),
    num("corruptionCount", "Corruptions"),
  ],
  outputs: [
    o("url", "Prometheus URL"),
    o("config", "Loaded configuration (YAML)", { hidden: true }),
  ],
  postureChecks: [
    {
      id: "prometheus-reload-failed",
      title: "Last configuration reload failed",
      severity: "high",
      category: "other",
      conditions: [{ fieldKey: "reloadConfigSuccess", when: "equals", value: "false" }],
      reason:
        "Prometheus is still running the previous configuration; the file on disk has an error.",
    },
  ],
  supportsRestQuery: true,
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "chart",
});

export const ScrapePoolResourceType = rt({
  name: "Scrape Pool",
  id: "prometheus-scrape-pool",
  description:
    "A scrape job and the targets it discovered, with how many are up. Read its effective configuration with secrets redacted.",
  fields: [
    f("name", "Name", ro),
    num("targets", "Targets"),
    num("up", "Up"),
    num("down", "Down"),
    num("dropped", "Dropped By Relabelling"),
    f("scrapeInterval", "Interval", ro),
    f("scrapeTimeout", "Timeout", ro),
  ],
  outputs: [o("name", "Job name")],
  supportsMetrics: true,
  iconKey: "layers",
});

export const TargetResourceType = rt({
  name: "Target",
  id: "prometheus-target",
  parentTypeId: "prometheus-scrape-pool",
  showInSidebar: true,
  description:
    "A scrape target: its labels, scrape URL, health, last error and scrape duration. The Metrics tab charts up, scrape duration and samples scraped.",
  fields: [
    f("scrapePool", "Scrape Pool", ro),
    f("instance", "Instance", ro),
    f("job", "Job", ro),
    f("scrapeUrl", "Scrape URL", ro),
    f("health", "Health", ro),
    f("lastError", "Last Error", ro),
    f("lastScrape", "Last Scrape", ro),
    num("lastScrapeDuration", "Scrape Duration (s)"),
    f("scrapeInterval", "Interval", ro),
    f("scrapeTimeout", "Timeout", ro),
    f("labels", "Labels", ro),
  ],
  outputs: [o("scrapeUrl", "Scrape URL"), o("instance", "Instance")],
  dependsOn: [
    {
      fieldKey: "scrapePool",
      targetTypeId: "prometheus-scrape-pool",
      targetKey: "name",
      label: "in",
    },
  ],
  supportsMetrics: true,
  pinnable: false,
  iconKey: "target",
});

export const RuleGroupResourceType = rt({
  name: "Rule Group",
  id: "prometheus-rule-group",
  description:
    "A group of recording and alerting rules from a rule file: interval, evaluation time and the health of its rules. Rules are defined in files on the server, so they are read only here.",
  fields: [
    f("name", "Name", ro),
    f("file", "File", ro),
    num("interval", "Interval (s)"),
    num("rules", "Rules"),
    num("alertingRules", "Alerting Rules"),
    num("recordingRules", "Recording Rules"),
    num("unhealthy", "Unhealthy"),
    num("firing", "Firing"),
    num("evaluationTime", "Evaluation Time (s)"),
    f("lastEvaluation", "Last Evaluation", ro),
  ],
  iconKey: "list",
});

export const RuleResourceType = rt({
  name: "Rule",
  id: "prometheus-rule",
  parentTypeId: "prometheus-rule-group",
  showInSidebar: true,
  description:
    "A recording or alerting rule: its expression, for duration, labels and annotations, health and last error, and for alerting rules its state and active alerts. The Metrics tab charts the expression.",
  fields: [
    f("group", "Group", ro),
    f("file", "File", ro),
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("query", "Expression", ro),
    num("duration", "For (s)"),
    num("keepFiringFor", "Keep Firing For (s)"),
    f("state", "State", ro),
    num("activeAlerts", "Active Alerts"),
    f("health", "Health", ro),
    f("lastError", "Last Error", ro),
    f("labels", "Labels", ro),
    f("annotations", "Annotations", ro),
    num("evaluationTime", "Evaluation Time (s)"),
    f("lastEvaluation", "Last Evaluation", ro),
  ],
  outputs: [o("query", "PromQL expression")],
  supportsMetrics: true,
  pinnable: false,
  iconKey: "bell",
});

export const AlertResourceType = rt({
  name: "Alert",
  id: "prometheus-alert",
  description:
    "An active alert in Prometheus (pending or firing), with its labels, annotations, value and since when. Silence it when an Alertmanager is connected.",
  fields: [
    f("alertname", "Alert", ro),
    f("state", "State", ro),
    f("severity", "Severity", ro),
    f("activeAt", "Active Since", ro),
    f("value", "Value", ro),
    f("labels", "Labels", ro),
    f("summary", "Summary", ro),
    f("description", "Description", ro),
  ],
  pinnable: false,
  iconKey: "alert",
});

export const AlertmanagerResourceType = rt({
  name: "Alertmanager",
  id: "prometheus-alertmanager",
  description:
    "The Alertmanager connected to this account: version, cluster state and peers, uptime and its configuration (read only). Silences, alerts and receivers live under it.",
  fields: [
    f("url", "URL", ro),
    f("version", "Version", ro),
    f("clusterStatus", "Cluster", ro),
    f("clusterName", "Cluster Name", ro),
    num("peers", "Peers"),
    f("uptime", "Up Since", ro),
    num("receivers", "Receivers"),
    num("activeSilences", "Active Silences"),
    num("alerts", "Alerts"),
  ],
  outputs: [o("url", "Alertmanager URL")],
  supportsMetrics: false,
  iconKey: "bell",
});

export const SilenceResourceType = rt({
  name: "Silence",
  id: "prometheus-silence",
  parentTypeId: "prometheus-alertmanager",
  showInSidebar: true,
  description:
    "An Alertmanager silence: the label matchers it mutes, when it starts and ends, who created it and why. Create one, extend it or change its comment, or expire it.",
  fields: [
    f("matchers", "Matchers", {
      required: false,
      description: 'Comma-separated, e.g. alertname="DiskFull", instance=~"db-.*".',
    }),
    f("state", "State", ro),
    f("startsAt", "Starts", ro),
    f("endsAt", "Ends", {
      required: false,
      description: "An ISO time, or a duration from now such as 2h or 3d.",
    }),
    f("createdBy", "Created By", { required: false }),
    f("comment", "Comment", { required: false }),
    f("updatedAt", "Updated", ro),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "bell-off",
});

export const AmAlertResourceType = rt({
  name: "Notified Alert",
  id: "prometheus-am-alert",
  parentTypeId: "prometheus-alertmanager",
  showInSidebar: true,
  description:
    "An alert as Alertmanager sees it: which receivers it routes to and whether a silence or an inhibition mutes it. Silence it from its page.",
  fields: [
    f("alertname", "Alert", ro),
    f("state", "State", ro),
    f("severity", "Severity", ro),
    f("receivers", "Receivers", ro),
    f("silencedBy", "Silenced By", ro),
    f("inhibitedBy", "Inhibited By", ro),
    f("startsAt", "Started", ro),
    f("endsAt", "Ends", ro),
    f("labels", "Labels", ro),
    f("summary", "Summary", ro),
    f("generatorUrl", "Source", ro),
  ],
  pinnable: false,
  iconKey: "alert",
});

export const ReceiverResourceType = rt({
  name: "Receiver",
  id: "prometheus-receiver",
  parentTypeId: "prometheus-alertmanager",
  description: "A notification receiver defined in the Alertmanager configuration.",
  fields: [f("name", "Name", ro), num("alerts", "Alerts Routed")],
  pinnable: false,
  iconKey: "send",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ServerResourceType,
  ScrapePoolResourceType,
  TargetResourceType,
  RuleGroupResourceType,
  RuleResourceType,
  AlertResourceType,
  AlertmanagerResourceType,
  SilenceResourceType,
  AmAlertResourceType,
  ReceiverResourceType,
];
