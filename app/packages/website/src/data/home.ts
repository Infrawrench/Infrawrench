/**
 * Copy and data for the home page (`src/pages/index.astro`).
 *
 * `PROVIDER_COUNT` is the exact number of plugins in the registry
 * (`server-core/src/plugin-loader.ts`). Marketing copy shows it rounded down
 * as "N+"; the logo strip's "and N more" is exact, so it sums with the named
 * logos to the total.
 */
const PROVIDER_COUNT = 152;
export const PROVIDER_COUNT_COPY = `${Math.floor(PROVIDER_COUNT / 10) * 10}+`;

/** Logos in the strip under the hero; each has an SVG in `public/providers/`. */
export const stripProviders = [
  { id: "aws", name: "AWS" },
  { id: "gcp", name: "Google Cloud" },
  { id: "azure", name: "Azure" },
  { id: "kubernetes", name: "Kubernetes" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "hetzner", name: "Hetzner" },
  { id: "digitalocean", name: "DigitalOcean" },
  { id: "vercel", name: "Vercel" },
  { id: "supabase", name: "Supabase" },
  { id: "neon", name: "Neon" },
  { id: "github", name: "GitHub" },
  { id: "datadog", name: "Datadog" },
];

export const STRIP_MORE = PROVIDER_COUNT - stripProviders.length;

/** The tabs above the hero shot. `shot` names a pair in `public/screenshots/app/`. */
export const heroViews = [
  { id: "aws", shot: "ec2", label: "AWS", title: "Production · EC2 instances" },
  { id: "kubernetes", shot: "k8s", label: "Kubernetes", title: "prod-eu · Pods" },
  { id: "hetzner", shot: "hetzner", label: "Hetzner", title: "EU compute · Servers" },
  { id: "cloudflare", shot: "cf", label: "Cloudflare", title: "acme.dev · Workers" },
];

export const teamBenefits = [
  {
    title: "One workspace for the team",
    body: "Invite teammates and share every account, dashboard and budget. Roles decide who can read, who can act and who holds the credentials.",
  },
  {
    title: "Terminals in the browser",
    body: "SSH into servers, exec into pods and tunnel to a database through a bastion, with no VPN, local client or kubeconfig.",
  },
  {
    title: "Alerts that find you",
    body: "Budget and resource alerts go to Slack, Microsoft Teams and the mobile app, not to a laptop that is closed.",
  },
  {
    title: "AI chat and workflows",
    body: "Chat history follows you everywhere you sign in, and workflows run on a schedule, on a push or when a budget trips.",
  },
  {
    title: "Audit log, API keys and SDKs",
    body: "Every action is recorded against a person or agent. Drive the same API from scoped keys and nine generated SDKs.",
  },
  {
    title: "On call from your phone",
    body: "The iOS and Android app has dashboards, resources, chat and terminals for when you are away from your desk.",
  },
];

export const nibbletsPoints = [
  {
    title: "A key of its own",
    body: "Each nibblet you switch on gets its own Infrawrench identity. What it does shows under its name in the audit log, and revoking one leaves the rest alone.",
  },
  {
    title: "Only the scopes you tick",
    body: "Choose what each nibblet may do, from reading resources to running commands, and which providers it may touch. It never gets more than you have.",
  },
  {
    title: "Runs on your own machine",
    body: "Open source and self-hosted. Each nibblet lives in its own container, remembers between conversations and wakes on schedules and heartbeats.",
  },
];

/**
 * The apps Infrawrench is made of, for the explorer on the home page: a grid
 * of them beside a panel that says what the selected one holds. The same
 * seven the product shows on its own Home, plus the two things that sit
 * across all of them. The website cannot import the app's registry
 * (`ui/src/products/`), so the tool names here are kept in step by hand; a
 * tool added to an app there is added here too.
 */
export interface HomeApp {
  id: string;
  name: string;
  summary: string;
  /** `doc` is the tool's page under `/docs/features/`, when it has one. */
  tools: { name: string; body: string; doc?: string }[];
  /** What the app covers, for its own page (`/apps/<id>`). */
  points: string[];
  /** What the app's own page shows under its heading, when there is something real to show. */
  visual?: { kind: "shot"; shot: string; title: string; alt: string } | { kind: "cost" };
}

export const homeApps: HomeApp[] = [
  {
    id: "infrastructure",
    name: "Infrastructure",
    points: [
      "One inventory across all your providers, searchable and always synced",
      "A dependency graph that shows what breaks if a resource goes down",
      "A timeline of every resource that appeared, changed or disappeared",
      "Terraform state sorted into managed, drifted and unmanaged resources",
      "One command run across many hosts at once",
    ],
    summary:
      "Connect an account and everything in it is listed: instances, clusters, databases, buckets, DNS, functions. Open any of them, get a shell, run a query.",
    tools: [
      {
        name: "Resources",
        body: "Every resource as a tile, with its status and the facts you check most.",
      },
      {
        name: "Terminals",
        doc: "ssh-terminal",
        body: "SSH into a server, exec into a pod, tunnel to a database.",
      },
      {
        name: "SQL and key-value consoles",
        doc: "sql-editor",
        body: "Query Postgres, MySQL or ClickHouse, read and write Redis keys.",
      },
      {
        name: "Graph",
        doc: "dependency-graph",
        body: "How your resources are wired together, and what depends on what.",
      },
      {
        name: "Services",
        doc: "services",
        body: "Resources grouped into the services you run, graded against your own bar.",
      },
      {
        name: "Changes",
        doc: "change-timeline",
        body: "Every resource that appeared, changed or disappeared.",
      },
      {
        name: "IaC",
        doc: "iac-reconciliation",
        body: "What Terraform manages, what drifted and what it does not know about.",
      },
      {
        name: "Domains",
        doc: "domains",
        body: "Every DNS zone and record, with takeover risks flagged.",
      },
      {
        name: "Quotas",
        doc: "quota-radar",
        body: "How close each account is to its provider limits.",
      },
      {
        name: "Fan-out",
        doc: "ssh-fanout",
        body: "One command across many hosts, with the odd one out diffed.",
      },
    ],
    visual: {
      kind: "shot",
      shot: "aws",
      title: "Production · Aurora clusters",
      alt: "An AWS account in Infrawrench, with Aurora clusters shown as tiles",
    },
  },
  {
    id: "costs",
    name: "Costs",
    points: [
      "Cost graphs, budgets and overspend alerts across every account",
      "Saved reports you can run by name and show on any dashboard",
      "Canvases the assistant builds from a description in plain words",
      "Kubernetes cost split by cluster, namespace, workload and label",
      "Published list prices compared across providers",
    ],
    summary:
      "Spend from every provider in one currency. Budgets, anomalies flagged the day they start, and reports you can save and share.",
    tools: [
      {
        name: "Costs",
        doc: "cloud-costs",
        body: "Graphs, budgets and savings for your cloud spend.",
      },
      { name: "Reports", doc: "cost-reports", body: "Cost graphs saved by name." },
      {
        name: "Canvases",
        doc: "ai-canvas",
        body: "Cost reports the assistant builds from a description.",
      },
      {
        name: "Kubernetes efficiency",
        doc: "kubernetes-efficiency",
        body: "How much of your clusters' cost bought capacity you used.",
      },
      { name: "Invoices", body: "Invoices for the cloud spend you bill on to customers." },
      {
        name: "Price catalog",
        doc: "price-catalog",
        body: "Instance types and list prices compared across providers.",
      },
    ],
    visual: { kind: "cost" },
  },
  {
    id: "observability",
    name: "Observability",
    points: [
      "Logs from several resources in one pane, searchable and saveable",
      "Threshold alerts on collected metrics, covering resources by query",
      "Uptime and latency checks run from outside your infrastructure",
      "Service-level objectives with burn-rate alerts",
      "Scheduled SQL queries that alert on what no metric shows",
      "A wallboard of everything that is wrong right now",
    ],
    summary: "Logs, metrics, uptime checks and objectives, next to the resources they are about.",
    tools: [
      {
        name: "Logs",
        doc: "log-workspace",
        body: "Logs from several resources in one searchable pane.",
      },
      { name: "Alerts", doc: "metric-alerts", body: "Threshold rules on the metrics we collect." },
      {
        name: "Probes",
        doc: "synthetic-probes",
        body: "Uptime and latency checks from outside your infrastructure.",
      },
      { name: "SLOs", doc: "slos", body: "Objectives, error budgets and burn-rate alerts." },
      {
        name: "Query monitors",
        doc: "query-monitors",
        body: "Scheduled SQL queries with a threshold and an alert.",
      },
      {
        name: "Wallboard",
        doc: "wallboard",
        body: "Everything that is wrong right now, readable from across the room.",
      },
    ],
  },
  {
    id: "incidents",
    name: "Incident response",
    points: [
      "Incidents that freeze changes, notify your team and pre-fill the postmortem",
      "Public status pages built from the probes you already run",
      "Runbooks you run step by step, with a record of who did what",
      "One calendar of freezes, expiries, scheduled runs and incidents",
    ],
    summary:
      "Declare an incident, freeze changes, keep people told, and get the timeline for the postmortem.",
    tools: [
      {
        name: "Incidents",
        doc: "incident-mode",
        body: "Declare an incident, follow its timeline and write the postmortem.",
      },
      {
        name: "Status pages",
        doc: "status-pages",
        body: "Public pages that show the state of your probes.",
      },
      { name: "Runbooks", doc: "runbooks", body: "Checklists you run step by step." },
      {
        name: "Calendar",
        doc: "ops-calendar",
        body: "Freezes, expiries, scheduled runs and incidents on one calendar.",
      },
      {
        name: "On-call",
        doc: "on-call",
        body: "Rotations and covers, so alerts reach whoever is on call.",
      },
    ],
  },
  {
    id: "security",
    name: "Security",
    points: [
      "Posture checks such as public buckets and world-open firewall rules",
      "Vulnerability findings shown next to what is actually running",
      "Evidence mapped to SOC 2 and ISO 27001 controls",
      "Every principal in your clouds in one list, with stale access flagged",
      "Time-boxed roles that are removed again when the time is up",
      "One countdown for certificates, domains, tokens and passwords",
      "Backup coverage across every provider",
    ],
    summary:
      "Checks across every account, the evidence mapped to controls, and access that expires on its own.",
    tools: [
      {
        name: "Posture",
        doc: "posture-checks",
        body: "Security checks across your accounts, ranked by severity.",
      },
      {
        name: "Vulnerabilities",
        doc: "vulnerabilities",
        body: "Known vulnerabilities, next to what is running them.",
      },
      {
        name: "Compliance",
        doc: "compliance",
        body: "SOC 2 and ISO 27001 controls, the evidence for them and the gaps.",
      },
      {
        name: "Access review",
        doc: "access-review",
        body: "Who has access to what, with stale and unowned access flagged.",
      },
      {
        name: "Just-in-time access",
        doc: "just-in-time-access",
        body: "Roles granted for a set time, with an approver.",
      },
      {
        name: "Expiring",
        doc: "expiry-radar",
        body: "Certificates, domains, tokens and passwords that are running out.",
      },
      {
        name: "Backups",
        doc: "backup-coverage",
        body: "What is recoverable, and how old the newest backup is.",
      },
    ],
  },
  {
    id: "delivery",
    name: "Delivery",
    points: [
      "Deploys from your repositories, with history per service",
      "Pipelines on every push and pull request, each job in its own sandbox",
      "Deployment frequency, lead time, failure rate and time to restore",
      "Environments from a template that delete themselves when time runs out",
      "A side by side comparison of two accounts",
    ],
    summary:
      "From a push to production: pipelines, deploys, short-lived environments and how fast you ship.",
    tools: [
      { name: "Deploy", body: "Deploy your repositories and see what shipped." },
      { name: "CI", doc: "ci", body: "Pipelines on every push and pull request." },
      {
        name: "Delivery",
        doc: "dora-metrics",
        body: "How often, how fast and how safely you ship.",
      },
      {
        name: "Environments",
        doc: "ephemeral-environments",
        body: "Short-lived copies of an environment, made from a template.",
      },
      { name: "Env diff", doc: "environment-diff", body: "Two accounts compared side by side." },
    ],
  },
  {
    id: "automation",
    name: "Automation",
    points: [
      "Coding agents started on a cloud machine from any account that can run one",
      "TypeScript workflows across all your connected accounts",
      "Runs by hand, on a schedule, from a git push or from a budget",
    ],
    summary:
      "Hand the routine work to coding agents and to workflows that run across every account.",
    tools: [
      { name: "Agents", doc: "agents", body: "Coding agents running on cloud machines." },
      {
        name: "Workflows",
        doc: "workflows",
        body: "TypeScript that acts across all your accounts, by hand, on a schedule or on a push.",
      },
    ],
  },
  {
    id: "dashboards",
    name: "Dashboards",
    points: [
      "A draggable grid of resource cards, cost graphs, budgets, KPIs and notes",
      "Live stats on every pinned resource",
      "A default dashboard per person, per role or for the organization",
      "Share a dashboard with a role or the whole organization",
    ],
    summary:
      "Pin resources, cost graphs, budgets and notes from any app to one grid, and share it with your team.",
    tools: [
      { name: "Pins", doc: "dashboard", body: "Any resource, with live stats on the card." },
      { name: "Cost widgets", body: "Graphs, budgets and KPIs from Costs." },
      {
        name: "Defaults",
        body: "A default dashboard per person, per role or for the organization.",
      },
    ],
  },
  {
    id: "chat",
    name: "Chat",
    points: [
      "Uses the same tools as the app, with your permissions",
      "Asks before anything destructive, and logs every action",
      "Works from Slack, from your editor over MCP and from the CLI",
      "Follows the apps your organization has turned on",
    ],
    summary:
      "One assistant that reads your resources and metrics with your permissions. Anything that would change something waits for you to approve it.",
    tools: [
      {
        name: "Every app's tools",
        doc: "ai-chat",
        body: "It can use what each app offers, and nothing an admin turned off.",
      },
      {
        name: "Approvals",
        body: "Changes wait for a yes, and every action lands in the audit log.",
      },
      {
        name: "MCP and CLI",
        doc: "mcp",
        body: "The same tools from your editor or your terminal.",
      },
    ],
    visual: {
      kind: "shot",
      shot: "chat",
      title: "Chat · CI jobs stuck on ci-runner-2",
      alt: "Infrawrench chat finding a stuck CI runner and asking for approval to reboot it",
    },
  },
];
