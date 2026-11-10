import { useMemo } from "react";
import { useGT } from "gt-react";
import type { ProductId } from "./registry.js";

export interface ProductCopy {
  name: string;
  /** One line, shown on the Home card. */
  tagline: string;
  /** A paragraph, shown at the top of the product's page. */
  description: string;
  /** What the product does, as short statements. */
  offers: string[];
  /** How this product uses each product it works with, keyed by the other. */
  worksWith: Partial<Record<ProductId, string>>;
}

/**
 * The translated copy for every product. A hook rather than data because
 * every string here is a `gt("literal")`: the gt CLI extracts literals only,
 * so the copy cannot live in `registry.ts` and be passed through a variable.
 */
export function useProductCopy(): Record<ProductId, ProductCopy> {
  const gt = useGT();
  return useMemo(
    () => ({
      infrastructure: {
        name: gt("Infrastructure"),
        tagline: gt("Everything you run, across every provider, in one inventory."),
        description: gt(
          "A live inventory of every connected account. See how resources are wired together, group them into the services you run, and follow what changed, what drifted from Terraform and what is close to a limit.",
        ),
        offers: [
          gt("One inventory across all your providers, searchable and always synced"),
          gt("A dependency graph that shows what breaks if a resource goes down"),
          gt("A timeline of every resource that appeared, changed or disappeared"),
          gt("Terraform state sorted into managed, drifted and unmanaged resources"),
          gt("One command run across many hosts at once"),
        ],
        worksWith: {
          costs: gt("Every resource and service carries what it costs."),
          security: gt("Findings land on the resource they belong to."),
          delivery: gt("Environments are captured from, and compared across, your accounts."),
        },
      },
      costs: {
        name: gt("Costs"),
        tagline: gt("See what you spend, why it moved, and where to cut it."),
        description: gt(
          "Spend from every connected account in one place. Graph it, budget it, save the views you keep coming back to, and invoice your customers for the spend that is theirs.",
        ),
        offers: [
          gt("Cost graphs, budgets and overspend alerts across every account"),
          gt("Saved reports you can run by name and show on any dashboard"),
          gt("Canvases the assistant builds from a description in plain words"),
          gt("Kubernetes cost split by cluster, namespace, workload and label"),
          gt("Published list prices compared across providers"),
        ],
        worksWith: {
          infrastructure: gt(
            "Costs are broken down by the resources and services in your inventory.",
          ),
          delivery: gt("See what a change or a deployment did to your bill."),
          observability: gt(
            "Budgets and anomalies alert through the same routing as your metrics.",
          ),
        },
      },
      observability: {
        name: gt("Observability"),
        tagline: gt("Logs, metrics, uptime and objectives for what you run."),
        description: gt(
          "Watch your infrastructure from the same place you manage it. Tail logs across resources, alert on metrics, check endpoints from outside, and track the error budget each service has left.",
        ),
        offers: [
          gt("Logs from several resources in one pane, searchable and saveable"),
          gt("Threshold alerts on collected metrics, covering resources by query"),
          gt("Uptime and latency checks run from outside your infrastructure"),
          gt("Service-level objectives with burn-rate alerts"),
          gt("Scheduled SQL queries that alert on what no metric shows"),
          gt("A wallboard of everything that is wrong right now"),
        ],
        worksWith: {
          incidents: gt(
            "Alerts reach whoever is on call, and a down probe can declare an incident.",
          ),
          infrastructure: gt("Alerts and probes are attached to the resources they watch."),
          delivery: gt("An objective that runs out of budget can freeze changes."),
        },
      },
      incidents: {
        name: gt("Incident response"),
        tagline: gt("Declare it, run it, tell people, and learn from it."),
        description: gt(
          "Everything for the moment something breaks. Declare an incident to freeze changes and notify your organization, work through the runbook, keep a public status page current, and get the timeline assembled for the postmortem.",
        ),
        offers: [
          gt("Incidents that freeze changes, notify your team and pre-fill the postmortem"),
          gt("Public status pages built from the probes you already run"),
          gt("Runbooks you run step by step, with a record of who did what"),
          gt("One calendar of freezes, expiries, scheduled runs and incidents"),
        ],
        worksWith: {
          observability: gt(
            "Probes drive your status pages, and a down probe can declare an incident.",
          ),
          delivery: gt("An incident freezes deploys and counts towards time to restore."),
          automation: gt("A runbook step can start a workflow."),
        },
      },
      security: {
        name: gt("Security"),
        tagline: gt("Find what is exposed, prove what is covered, control who gets in."),
        description: gt(
          "Security checks across every connected account, ranked by what matters. Map the evidence to compliance controls, review who has access, grant roles for a set time, and see what is about to expire or has no backup.",
        ),
        offers: [
          gt("Posture checks such as public buckets and world-open firewall rules"),
          gt("Vulnerability findings shown next to what is actually running"),
          gt("Evidence mapped to SOC 2 and ISO 27001 controls"),
          gt("Every principal in your clouds in one list, with stale access flagged"),
          gt("Time-boxed roles that are removed again when the time is up"),
          gt("One countdown for certificates, domains, tokens and passwords"),
          gt("Backup coverage across every provider"),
        ],
        worksWith: {
          infrastructure: gt("Every finding is tied to a resource in your inventory."),
          incidents: gt("Expiries and access windows appear on the operations calendar."),
          observability: gt("The worst findings alert through the same routing as your metrics."),
        },
      },
      delivery: {
        name: gt("Delivery"),
        tagline: gt("Build, ship and measure every change."),
        description: gt(
          "From a push to production. Run pipelines, deploy your repositories, stamp out short-lived environments, compare two environments side by side, and measure how fast and how safely you ship.",
        ),
        offers: [
          gt("Deploys from your repositories, with history per service"),
          gt("Pipelines on every push and pull request, each job in its own sandbox"),
          gt("Deployment frequency, lead time, failure rate and time to restore"),
          gt("Environments from a template that delete themselves when time runs out"),
          gt("A side by side comparison of two accounts"),
        ],
        worksWith: {
          infrastructure: gt("Environments are captured from the accounts in your inventory."),
          costs: gt("Each deployment shows what it did to your daily spend."),
          observability: gt("Change freezes from incidents and objectives hold deploys back."),
        },
      },
      automation: {
        name: gt("Automation"),
        tagline: gt("Hand work to agents and workflows."),
        description: gt(
          "Let the routine work run itself. Start coding agents on a cloud machine and bring their branch back, and write workflows that act across all your accounts on a schedule, on a push or when a budget is crossed.",
        ),
        offers: [
          gt("Coding agents started on a cloud machine from any account that can run one"),
          gt("TypeScript workflows across all your connected accounts"),
          gt("Runs by hand, on a schedule, from a git push or from a budget"),
        ],
        worksWith: {
          delivery: gt("Git pushes and deploys can start workflows."),
          costs: gt("A budget being crossed can start a workflow."),
          incidents: gt("Scheduled runs show on the operations calendar."),
        },
      },
    }),
    [gt],
  );
}

/**
 * One line per org tool, keyed by the tool's `key`. A tool with no entry
 * still shows on its product's page, with its name only.
 */
export function useToolDescriptions(): Record<string, string> {
  const gt = useGT();
  return useMemo(
    () => ({
      graph: gt("How your resources are wired together, and what depends on what."),
      services: gt("Resources grouped into the services you run, graded against your own bar."),
      changes: gt("Every resource that appeared, changed or disappeared."),
      iac: gt("What Terraform manages, what drifted and what it does not know about."),
      "resource-reports": gt("Saved tables of resources with the columns you choose."),
      dns: gt("Every DNS zone and record, with takeover risks flagged."),
      quotas: gt("How close each account is to its provider limits."),
      "ssh-fanout": gt("One command across many hosts, with the odd one out diffed."),
      costs: gt("Graphs, budgets and savings for your cloud spend."),
      "cost-reports": gt("Cost graphs saved by name."),
      "cost-canvases": gt("Cost reports the assistant builds from a description."),
      "k8s-efficiency": gt("How much of your clusters' cost bought capacity you used."),
      invoices: gt("Invoices for the cloud spend you bill on to customers."),
      "price-catalog": gt("Instance types and list prices compared across providers."),
      logs: gt("Logs from several resources in one searchable pane."),
      "metric-alerts": gt("Threshold rules on the metrics we collect."),
      probes: gt("Uptime and latency checks from outside your infrastructure."),
      slos: gt("Objectives, error budgets and burn-rate alerts."),
      "query-monitors": gt("Scheduled SQL queries with a threshold and an alert."),
      wallboard: gt("Everything that is wrong right now, readable from across the room."),
      incidents: gt("Declare an incident, follow its timeline and write the postmortem."),
      "status-pages": gt("Public pages that show the state of your probes."),
      runbooks: gt("Checklists you run step by step."),
      calendar: gt("Freezes, expiries, scheduled runs and incidents on one calendar."),
      posture: gt("Security checks across your accounts, ranked by severity."),
      vulnerabilities: gt("Known vulnerabilities, next to what is running them."),
      compliance: gt("Controls, the evidence for them and the gaps."),
      "access-review": gt("Who has access to what, with stale and unowned access flagged."),
      "jit-access": gt("Roles granted for a set time, with an approver."),
      expiring: gt("Certificates, domains, tokens and passwords that are running out."),
      backups: gt("What is recoverable, and how old the newest backup is."),
      deploy: gt("Deploy your repositories and see what shipped."),
      ci: gt("Pipelines on every push and pull request."),
      delivery: gt("How often, how fast and how safely you ship."),
      environments: gt("Short-lived copies of an environment, made from a template."),
      "environment-diff": gt("Two accounts compared side by side."),
      agents: gt("Coding agents running on cloud machines."),
      workflows: gt("Scripts that act across all your accounts."),
    }),
    [gt],
  );
}
