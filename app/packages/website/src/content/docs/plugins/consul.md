---
title: HashiCorp Consul
description: Manage a self-hosted Consul cluster, with catalog services and nodes and their health, a KV browser with editing, intentions, config entries, ACL policies, roles and tokens, sessions, cluster peering, and Enterprise namespaces and admin partitions.
sidebar_order: 50
---

Connect a Consul datacenter through any agent's HTTP API. You can see what is registered and healthy, edit the KV store, and manage the service mesh and ACLs.

## What you can manage

- **Cluster**: the account opens on the datacenter, with its version, leader, Raft servers and voters, autopilot health and failure tolerance, federated datacenters, members, and how many nodes, services and failing checks there are. The **Keys** tab browses the KV store by prefix and lets you read, add, change and delete values. The Metrics tab records Raft, autopilot and runtime gauges.
- **Services**: every service in the catalog with its tags, instance count and passing, warning and critical checks, plus a table of instances with node, address, port and health. A service with a critical check shows red.
- **Nodes**: address, datacenter, metadata, the services each node runs and its check counts. Deregister a node that is gone (a running agent registers itself again).
- **Health checks**: every check with its status, type, output and notes.
- **Intentions**: whether a source service may connect to a destination. **Create** one by picking both services and allow or deny, change its action or description, or delete it. Intentions with L7 permissions keep their permissions when you edit them here.
- **Config entries**: service defaults, proxy defaults, routers, splitters, resolvers, service intentions, ingress, terminating and API gateways and routes, mesh, exported services, sameness groups, JWT providers and request limits, each with a one-line summary. Edit the entry as JSON on the **Entry** tab. If someone else changed it in the meantime, your save won't overwrite their change. **Create** an entry from a starter document, or delete one.
- **ACL policies**: rules, description and datacenters. Create, **Edit rules** in an HCL editor, change the description, or delete. Built-in policies are read only.
- **ACL roles**: policies and service identities. Create, edit or delete.
- **ACL tokens**: description, policies, roles, identities, whether local, the auth method that issued it, and expiry (shown on the expiry radar; tokens carrying global-management are flagged). Create a token, change its policies and roles, or delete it. The secret ID is available as a sensitive output.
- **Sessions**: node, checks, TTL, behaviour and lock delay. **Renew** a TTL session or destroy it.
- **Cluster peerings**: state, the peer's servers, and how many services are imported and exported. **Create** either generates a peering token for the other cluster (saved as a sensitive output) or sets up a peering from a token the other cluster gave you. Delete ends the peering.
- **Namespaces** and **admin partitions** (Consul Enterprise): create, edit the description and metadata, or delete. On Community Edition these lists stay empty.

## Connect a datacenter

1. Enter the **Consul Address** of any agent, with its port, for example `http://consul.internal:8500` or `https://consul.example.com:8501` (the value you use for `CONSUL_HTTP_ADDR`).
2. If ACLs are enabled, paste an **ACL Token** secret ID. A token with the `global-management` policy can do everything. Otherwise the token's policies decide what you can see and change.
3. Under **Advanced options**, set a **Datacenter** to manage a WAN-federated datacenter other than the agent's own. On Consul Enterprise, you can also set a **Namespace** and **Admin Partition**.
4. If the agent's certificate is signed by a private CA, paste the CA certificate under **Advanced options**. Agents that require client certificates (`verify_incoming` on the HTTPS port) aren't supported.

<insert [Consul Add-account form with the address and ACL token filled in] here>

**Check credentials** tests the catalog, the KV store, intentions, ACLs and operator access separately, and tells you the ACL rule each missing capability needs.

<insert [Consul cluster page with the Keys tab browsing a KV prefix] here>

<insert [Consul service detail page with the instances table showing health] here>

## Tips & limits

- **Private clusters**: the desktop app connects directly. The cloud app reaches a private cluster through an [SSH tunnel](../features/ssh-tunnels.md) on the account. Through a tunnel the connection goes to `127.0.0.1`, so an HTTPS certificate must also cover that address.
- Up to 3,000 health checks are listed.
- KV values are read and written as text. A write to a key locked by a session is refused.
- Metrics are point-in-time readings, so the charts fill in over time.
- Prepared queries, the Connect CA, auth methods and binding rules, and snapshots aren't managed here.
- [Export to Terraform](../features/terraform-export.md) writes ACL policies, config entries (including service intentions), namespaces and admin partitions for the `hashicorp/consul` provider, with import ids.
