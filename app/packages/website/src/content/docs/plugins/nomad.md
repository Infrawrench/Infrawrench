---
title: HashiCorp Nomad
description: Manage a self-hosted Nomad cluster - run, stop, scale, dispatch and revert jobs, read allocation logs, promote deployments, drain nodes, and manage namespaces, node pools, variables, ACL policies and tokens, volumes and services.
sidebar_order: 50
---

Connect a Nomad cluster through its HTTP API to run and operate jobs and look after the nodes they run on.

## What you can manage

- **Cluster**: the account opens on the cluster, with its version, region and datacenter, the leader and Raft peers, servers, federated regions, ACL status and how many nodes and jobs it has. The Metrics tab records scheduler gauges (ready, unacknowledged and blocked evaluations, plan queue depth, heartbeats) and the agent's memory and goroutines.
- **Jobs**: every job in every namespace, with type, status, priority, datacenters, node pool, version and running, queued, failed and lost counts.
  - **Create** runs a job from HCL (a starter job is filled in); the server parses it and the source is stored with the job.
  - The **Specification** tab shows the registered job as JSON; edit it and save to submit a new version. The **Describe** tab shows the source as it was submitted.
  - **Stop** and **Start**, **Scale** a task group, **Dispatch** a parameterized job with a payload and metadata, **Run now** for a periodic job, **Revert** to an earlier version, and **Reschedule failed** allocations. **Delete** stops and purges the job.
- **Allocations**: under their job, with task group, node, client and desired status, task states, restarts and deployment health. The **Logs** tab tails each task's stdout or stderr, and the **Describe** tab lists the recent task events. **Restart** its tasks, **Send signal**, or **Stop** it so the scheduler places a replacement. The Metrics tab records its CPU and memory.
- **Deployments**: under their job, with status and desired, placed, healthy and unhealthy counts. **Promote** canaries, **Pause** or **Resume**, or **Fail** it (which rolls back when auto-revert is set).
- **Nodes**: datacenter, class, pool, status, drain and eligibility, healthy drivers and resources. **Drain** with a deadline (or force), **Cancel drain**, mark it **eligible** or **ineligible**, or delete (purge) a node that is down. A down node is suggested for cleanup. The Metrics tab records CPU, memory and allocation-directory use.
- **Namespaces** and **node pools**: create, edit the description, metadata and (for pools) scheduler algorithm, or delete.
- **Variables**: every variable path with its item keys. The **Items** tab reveals and edits the items (saved with check-and-set, so a concurrent change is not overwritten). Create a variable from `KEY=value` lines or JSON, or delete it.
- **ACL policies**: create, **Edit rules** in an HCL editor, or delete.
- **ACL tokens**: name, type, policies, roles, whether global, and expiry (shown on the expiry radar; management tokens are flagged). Create a client or management token, change its name and policies, or revoke it. The secret ID is available as a sensitive output.
- **Volumes**: CSI volumes and dynamic host volumes with their plugin, modes, capacity and health. Deregister a CSI volume or delete a host volume. **CSI plugins** show the health of their controllers and nodes.
- **Services**: services in Nomad's native service discovery, with tags and every registered instance.

## Credentials

1. Enter the **Nomad Address** of any server or client agent, with its port, for example `https://nomad.example.com:4646` (the value you use for `NOMAD_ADDR`).
2. If ACLs are enabled, paste an **ACL Token** secret ID. A management token can do everything; a client token can do what its policies allow. Leave it empty if ACLs are off.
3. For federated clusters, set the **Region** under **Advanced options** to manage a region other than the agent's own.
4. If the agent's certificate is signed by a private CA, paste the CA certificate under **Advanced options**. Nomad's mutual TLS (`verify_https_client`) is not supported.

<insert [Nomad Add-account form with the address and ACL token filled in] here>

**Check credentials** probes jobs, nodes, variables, ACLs and the agent separately, and lists the policy each missing capability needs.

<insert [Nomad job detail page with the Scale dialog open over the task group counts] here>

<insert [Nomad allocation Logs tab showing a task's stderr] here>

## Tips & limits

- **Private clusters**: the desktop app connects directly. The cloud app reaches a private cluster through an [SSH tunnel](../features/ssh-tunnels.md) on the account; through a tunnel the connection goes to `127.0.0.1`, so an HTTPS certificate must also cover that address.
- Up to 3,000 jobs, 3,000 allocations (running ones first) and 500 deployments are listed.
- Logs and allocation and node metrics are fetched through the server from the client node, so the node must be reachable from the servers.
- Metrics are point-in-time readings; Nomad keeps no metric history, so the charts fill in as Infrawrench records them.
- Enterprise features (quotas, Sentinel policies, multi-region deployments) are not managed here.
- [Export to Terraform](../features/terraform-export.md) writes namespaces, node pools, ACL policies, jobs and variables for the `hashicorp/nomad` provider, with import ids. Each job's specification is read from a file you save next to the configuration, and variable items become a sensitive variable written without entering the state.
