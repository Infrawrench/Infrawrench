---
title: HashiCorp Nomad
description: Manage a self-hosted Nomad cluster. Run, stop, scale, dispatch and revert jobs, read allocation logs, promote deployments, drain nodes, and manage namespaces, node pools, variables, ACL policies and tokens, volumes and services.
sidebar_order: 50
---

Connect a Nomad cluster to run and operate jobs and look after the nodes they run on.

## What you can manage

- **Cluster**: the account opens on the cluster, with its version, region and datacenter, the leader and Raft peers, servers, federated regions, ACL status and how many nodes and jobs it has. The Metrics tab records scheduler gauges (ready, unacknowledged and blocked evaluations, plan queue depth, heartbeats) and the agent's memory and goroutines.
- **Jobs**: every job in every namespace, with type, status, priority, datacenters, node pool, version and running, queued, failed and lost counts.
  - **Create** runs a job from HCL. A starter job is filled in for you, and the source is saved with the job.
  - The **Specification** tab shows the registered job as JSON. Edit it and save to submit a new version. The **Describe** tab shows the source as it was submitted.
  - **Stop** and **Start**, **Scale** a task group, **Dispatch** a parameterized job with a payload and metadata, **Run now** for a periodic job, **Revert** to an earlier version, and **Reschedule failed** allocations. **Delete** stops and purges the job.
- **Allocations**: under their job, with task group, node, client and desired status, task states, restarts and deployment health. The **Logs** tab tails each task's stdout or stderr, and the **Describe** tab lists recent task events. **Restart** its tasks, **Send signal**, or **Stop** it so Nomad places a replacement. The Metrics tab records its CPU and memory.
- **Deployments**: under their job, with status and desired, placed, healthy and unhealthy counts. **Promote** canaries, **Pause** or **Resume**, or **Fail** it (which rolls back when auto-revert is set).
- **Nodes**: datacenter, class, pool, status, drain and eligibility, healthy drivers and resources. **Drain** with a deadline (or force), **Cancel drain**, mark it **eligible** or **ineligible**, or delete (purge) a node that's down. Down nodes are suggested for cleanup. The Metrics tab records CPU, memory and allocation-directory use.
- **Namespaces** and **node pools**: create, edit the description, metadata and (for pools) scheduler algorithm, or delete.
- **Variables**: every variable path with its item keys. The **Items** tab reveals and edits the items. If someone else changes them at the same time, your save won't overwrite their change. Create a variable from `KEY=value` lines or JSON, or delete it.
- **ACL policies**: create, **Edit rules** in an HCL editor, or delete.
- **ACL tokens**: name, type, policies, roles, whether global, and expiry (shown on the expiry radar, with management tokens flagged). Create a client or management token, change its name and policies, or revoke it. The secret ID is available as a sensitive output.
- **Volumes**: CSI volumes and dynamic host volumes with their plugin, modes, capacity and health. Deregister a CSI volume or delete a host volume. **CSI plugins** show the health of their controllers and nodes.
- **Services**: services registered in Nomad's native service discovery, with tags and every instance.

## Connect your cluster

1. Enter the **Nomad Address** of any server or client agent, with its port, for example `https://nomad.example.com:4646` (the value you use for `NOMAD_ADDR`).
2. If ACLs are on, paste an **ACL Token** secret ID. A management token can do everything. A client token can do what its policies allow. Leave it empty if ACLs are off.
3. For federated clusters, set the **Region** under **Advanced options** to manage a region other than the agent's own.
4. If the agent's certificate is signed by a private CA, paste the CA certificate under **Advanced options**. Nomad's mutual TLS (`verify_https_client`) isn't supported.

<insert [Nomad Add-account form with the address and ACL token filled in] here>

**Check credentials** tests jobs, nodes, variables, ACLs and the agent one by one, and lists the policy each missing capability needs.

<insert [Nomad job detail page with the Scale dialog open over the task group counts] here>

<insert [Nomad allocation Logs tab showing a task's stderr] here>

## CI jobs

A Nomad cluster can run [cloud jobs](../features/ci.md#cloud-jobs) of kind `cluster`: each job is a batch job with one task on the `docker` driver, stopped and purged when the job ends.

- `region` is the Nomad namespace (default `default`). The connection's own region is used.
- `machine` is CPUs and memory, like `2vcpu-4gb` (the default); a CPU counts as 1000 MHz.
- `gpu: nvidia:1` (or `a100:2`, or a full device name such as `nvidia/gpu/a100`) asks for GPU devices.
- The job never restarts or reschedules, and gets no Nomad token, no Vault or Consul access, no host volumes and no Docker socket.
- Nomad has no run-time limit for a job, so a watchdog in the task stops the job once its time is up.
- The token needs `list-jobs`, `read-job` and `submit-job` in the namespace (on Nomad 1.11.2 and later, `register-job` and `purge-job` also do). **Check permissions** tests each without starting anything, and says when no client has a healthy docker driver.

## Tips and limits

- **Private clusters**: the desktop app connects directly. The cloud app reaches a private cluster through an [SSH tunnel](../features/ssh-tunnels.md) on the account. Through a tunnel the connection goes to `127.0.0.1`, so an HTTPS certificate must also cover that address.
- Up to 50,000 jobs, 50,000 allocations (running and pending ones first), 50,000 deployments and 1,000 ACL policies are listed. A longer list [keeps the rows it already has and says why](../core-concepts/resources-and-accounts.md#when-a-list-cant-be-read-whole).
- Logs and allocation and node metrics need the client node to be reachable from the Nomad servers.
- Nomad keeps no metric history, so charts fill in from the moment you connect.
- Enterprise features (quotas, Sentinel policies, multi-region deployments) aren't managed here.
- [Export to Terraform](../features/terraform-export.md) writes namespaces, node pools, ACL policies, jobs and variables for the `hashicorp/nomad` provider, with import ids. Each job's specification is read from a file you save next to the configuration, and variable items become a sensitive variable that isn't written to the state.
