interface Screenshot {
  label: string;
  tall: boolean;
  filename: string;
}

interface FeatureSection {
  id: string;
  label: string;
  icon: string;
  heading: string;
  description: string;
  bullets: string[];
  screenshots: Screenshot[];
}

export const featureSections: FeatureSection[] = [
  {
    id: "overview",
    label: "Multi-Cloud Overview",
    icon: "Globe",
    heading: "Manage everything from one place",
    description:
      "Connect to 45+ cloud providers and manage hundreds of resource types from a single unified interface. Infrawrench discovers your infrastructure automatically and keeps it in sync every 30 seconds.",
    bullets: [
      "AWS, GCP, Azure, Cloudflare, DigitalOcean, Hetzner, Scaleway, OVH, and 40 more",
      "Automatic resource discovery with background sync, no manual refresh",
      "Right-click context menus with provider-specific actions per resource type",
      "Drag-and-drop to attach disks, volumes, and Elastic IPs to compute resources",
      "Spotlight search (⌘K) across all accounts and resource types at once",
    ],
    screenshots: [
      {
        label: "Account overview showing resource groups and types",
        tall: false,
        filename: "overview-accounts.png",
      },
    ],
  },
  {
    id: "ssh",
    label: "SSH Terminals",
    icon: "Terminal",
    heading: "SSH into anything, anywhere",
    description:
      "Launch full SSH terminals to any server directly from Infrawrench. No external client needed. On desktop, connections run locally. In the cloud web app, sessions are proxied securely through our WebSocket server.",
    bullets: [
      "Full terminal with resize, 256-color, and clipboard support",
      "Reads keys from ~/.ssh/ or your saved in-app key store",
      "One-click SSH from any VM resource (EC2, GCE, Droplet, Hetzner, and more)",
      "SSH tunnels: proxy a database port through a bastion host with service presets",
      "Windows Pageant SSH agent support on desktop",
    ],
    screenshots: [
      {
        label: "SSH terminal embedded in a resource detail tab",
        tall: true,
        filename: "ssh-terminal.png",
      },
    ],
  },
  {
    id: "kubernetes",
    label: "Kubernetes",
    icon: "Layers",
    heading: "Full Kubernetes management",
    description:
      "Browse, inspect, and manage your Kubernetes clusters. Exec into pods, stream logs, import YAML manifests, and edit live configs. The web app proxies exec sessions so nothing runs locally.",
    bullets: [
      "Supports any kubeconfig cluster: EKS, GKE, AKS, self-hosted",
      "Pod exec / interactive shell (cloud-proxied via WebSocket in the web app)",
      "Log streaming for pods, deployments, statefulsets, services, and jobs",
      "YAML import (kubectl apply -f equivalent) with multi-document support",
      "Monaco manifest editor for live resource config editing",
      "Ephemeral scratch pods with configurable TTL (auto-terminated by the cluster)",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "Kubernetes pod list with exec and logs buttons", tall: false, filename: "k8s-pods.png" },
      // { label: "Pod log stream in the web browser", tall: true, filename: "k8s-logs.png" },
    ],
  },
  {
    id: "sql",
    label: "SQL Editor",
    icon: "Database",
    heading: "Query your databases in context",
    description:
      "A built-in SQL editor with schema autocomplete, per-resource connection management, and support for a wide range of databases: from traditional PostgreSQL to serverless edge databases.",
    bullets: [
      "Schema-aware autocomplete via INFORMATION_SCHEMA introspection",
      "Per-resource SQL: connect directly to a specific RDS instance, Neon db, or Turso group",
      "Supports PostgreSQL, MySQL, Turso/libsql, Databricks, ClickHouse, Cloudflare D1, Spanner",
      "Query cost estimation for BigQuery (dry-run API, no quota consumed)",
      "Connection strings resolved automatically from resource outputs",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "SQL editor with schema autocomplete active", tall: true, filename: "sql-editor.png" },
      // { label: "Database resource detail with embedded SQL tab", tall: false, filename: "sql-detail.png" },
    ],
  },
  {
    id: "storage",
    label: "Storage Browser",
    icon: "FolderOpen",
    heading: "Browse and manage object storage",
    description:
      "A built-in object storage file browser for S3, GCS, Cloudflare R2, Azure Blob Storage, and DigitalOcean Spaces. Upload, download, create folders, and delete, without leaving the app.",
    bullets: [
      "Prefix-based folder navigation with breadcrumbs",
      "File upload with progress tracking",
      "Batch download of multiple objects (desktop)",
      "Storage stats: object count and total size on the dashboard card",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "S3 bucket file browser with upload panel open", tall: false, filename: "storage-browser.png" },
    ],
  },
  {
    id: "dashboards",
    label: "Dashboards",
    icon: "LayoutDashboard",
    heading: "Pin and monitor your key resources",
    description:
      "Build custom dashboards by pinning any resource from any provider. Cards show live stats and status. Set metric thresholds and get native OS notifications when something goes out of range.",
    bullets: [
      "Drag-and-drop grid layout: pin resources from multiple providers on one dashboard",
      "Live stats auto-refresh: table counts, container counts, storage size, and more",
      "Metric ping alerts: native OS notification when a metric leaves a min/max range",
      "Multiple named dashboards with a configurable default",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "Dashboard with pinned resource cards from multiple providers", tall: false, filename: "dashboards.png" },
    ],
  },
  {
    id: "secrets",
    label: "Secret Management",
    icon: "KeyRound",
    heading: "Manage and export secrets safely",
    description:
      "View, rotate, and export secrets from AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, and more. Credentials are encrypted at rest and only decrypted on demand.",
    bullets: [
      "Secret versions: list, reveal, add, enable, disable, and destroy with one click",
      "Credential export: IAM access keys, GCP service account JSON, Azure client secrets, Cloudflare tunnel tokens",
      "Kubernetes-ready secret export templates on S3, R2, Cloudflare Tunnel, and more",
      "Credentials encrypted at rest. Keys never leave the device (desktop)",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "Secret version manager for AWS Secrets Manager", tall: false, filename: "secrets-versions.png" },
    ],
  },
  {
    id: "create",
    label: "Resource Creation",
    icon: "PlusCircle",
    heading: "Provision resources without leaving the app",
    description:
      "Provision VMs, Kubernetes clusters, databases, queues, and buckets with a guided form backed by live data from the provider API. Includes real-time cost estimation, region and size pickers, and SSH key selection.",
    bullets: [
      "Live cost estimates for EC2, GCE, AKS, Azure VMs, RDS, EBS, and more",
      "Region picker: searchable by zone ID, flag, or human-readable location name",
      "SSH key picker reads from ~/.ssh/ and your saved key store",
      "IAM policy picker with live search and categorised results",
      "Supported across AWS, GCP, Azure, DigitalOcean, Hetzner, Kubernetes, and more",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "VM creation form with real-time cost estimate badge", tall: true, filename: "create-vm.png" },
      // { label: "Region picker with search and flag display", tall: false, filename: "create-region.png" },
    ],
  },
  {
    id: "sync",
    label: "Desktop + Cloud",
    icon: "CloudUpload",
    heading: "Start local, go cloud",
    description:
      "Use the desktop app fully offline. Sign in to sync your accounts, resources, dashboards, and credentials to the cloud, kept in sync bidirectionally.",
    bullets: [
      "Secure sign-in, no passwords stored or transmitted",
      "Bidirectional sync every 60 seconds: desktop ↔ cloud",
      "API keys for programmatic and CI pipeline access",
      "Team management with per-seat billing ($20/seat/month)",
      "Full audit trail for all mutations in the cloud app",
    ],
    // TODO: add screenshots
    screenshots: [
      // { label: "Cloud sync status and team management panel", tall: false, filename: "sync-cloud.png" },
    ],
  },
];
