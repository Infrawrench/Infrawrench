---
title: Bastion VMs
description: Send a cloud account's API calls out through a bastion you run on your own infrastructure instead of through Infrawrench's IP.
sidebar_order: 9
---

A **bastion** is a small container you run on your own infrastructure. When you bind a cloud account to a bastion, that account's API calls (listing EC2 instances, creating an RDS database, deleting a Lambda function and so on) go out from the bastion's IP instead of Infrawrench's.

Use a bastion when:

- the cloud account only accepts API calls from an **allowlist of source IPs**
- you want your cloud provider's audit logs to show API calls coming from a host you control
- your network policy requires traffic to leave through a specific NAT gateway

The bastion only carries **cloud API traffic** (AWS API, GCP API, DigitalOcean API, …). SSH terminal sessions and database connections don't go through it. They keep using the normal [SSH tunnel](./ssh-terminal.md).

## What the bastion can see

- The bastion **connects out** to Infrawrench over a secure WebSocket. It works behind NAT and you don't need to open any inbound firewall ports.
- Traffic is encrypted end to end between Infrawrench and your cloud provider's API. The bastion only passes encrypted bytes along. It never holds or sees your cloud credentials.
- The bastion only connects to the API hostnames your bound accounts need (for example `*.amazonaws.com` for AWS or `*.googleapis.com` for GCP), and to the host an account was configured with, such as a self-hosted Vault's address or a self-managed GitLab's URL. It refuses any other destination.
- A configured host has to be public. The bastion looks up the name each time it connects and refuses if any address is loopback, link-local, private or otherwise not routable, so it can't be pointed at its own cloud metadata endpoint or at your internal network. A bastion is not a way into a private network: to reach a private host, use the desktop app from inside that network, or an [SSH tunnel](./ssh-tunnels.md) where the plugin supports one.
- One account's calls can only reach its own configured host, even if another account on the same bastion has a different one.

### Hosts the provider tells Infrawrench about

Some providers send part of the traffic to hosts that aren't in the account's URL. The bastion doesn't know those hosts until you pick them, so these accounts have an extra optional field under **Advanced options**. Each one is a picker of the account's other hosts, and each host has to be public, like any configured host:

- **OpenStack: Service Endpoint Hosts.** Needed when your service catalog puts Nova, Neutron or other services on hosts other than the Keystone URL's. See [OpenStack](../plugins/openstack.md).
- **Qdrant Cloud: Hybrid Cluster Endpoints.** Needed for hybrid cloud clusters, whose database endpoint is on your own infrastructure rather than `cloud.qdrant.io`. See [Qdrant Cloud](../plugins/qdrant-cloud.md).
- **Weaviate Cloud: Self-Hosted Cluster Hosts.** Needed for self-hosted clusters you added under **More Clusters**. Clusters on `weaviate.cloud` don't need it. See [Weaviate Cloud](../plugins/weaviate-cloud.md).

Leave these empty if the account doesn't use a bastion. Without them, the bastion refuses calls to those hosts.

## Register a bastion

1. Go to **Settings > Bastions > New Bastion**.
2. Give it a name, for example `prod-egress-eu-west-1`, and click **Create bastion**.
3. Copy the `docker run` command shown. It contains a one-time enrollment token that you can't get back later.

![Settings → Bastions page showing the list of registered bastions with status pills (connected / offline / awaiting first connect) and a "New Bastion" button in the top right.](https://agent-assets.infrawrench.com/docs-screenshots/features/bastion-vms/bastions-list.png)

![Bastion-created modal showing the `docker run` command with the enrollment token, a "Copy command to clipboard" button, and a follow-up tip pointing at the account add modal.](https://agent-assets.infrawrench.com/docs-screenshots/features/bastion-vms/bastion-created-modal.png)

## Start the bastion

Run the command on any Docker host: a Linux VM, your laptop for testing, a Fly Machine. Anywhere with outbound HTTPS to Infrawrench works.

```sh
docker run -d \
  --name infrawrench-bastion \
  --restart unless-stopped \
  -e BASTION_TOKEN=iwb_… \
  -e INFRAWRENCH_URL=wss://app.infrawrench.com/api/bastions/agent \
  registry.infrawrench.com/bastion-agent:latest
```

Within a few seconds its status in **Settings > Bastions** changes to **Connected**.

## Bind an account

When you add a new cloud account, pick the bastion in the **Egress via** dropdown.

![Add account modal in the credentials step with the "Egress via" dropdown expanded showing "Direct (no bastion)" and the user's registered bastions.](https://agent-assets.infrawrench.com/docs-screenshots/features/bastion-vms/egress-via-expanded.png)

For an existing account, use the same dropdown when you edit the account. The change applies to the next API call.

You can bind as many accounts as you like to one bastion.

## Current limitations

- **Background sync doesn't use the bastion yet.** Only actions you take in the web app do. If your account has a strict IP allowlist, background sync will fail. Refresh manually from the account detail page to get fresh data.
- **Some plugins ignore the bastion** (GCP, Azure, MongoDB, and database, Redis, Kafka and Kubernetes connections). They keep working over a direct connection, so in the web app they need public addresses.
- **One bastion connection per region.** For multi-region deployments, run one bastion per region you operate in.
- **Streaming responses** (very large CloudWatch log queries and similar) aren't supported through a bastion.
- **To rotate a token,** revoke the bastion and create a new one. Redeploy with the new `BASTION_TOKEN` and the bastion reconnects by itself.

## Troubleshooting

**Status stuck on "Offline" or "Awaiting first connect"**

Check the container logs with `docker logs infrawrench-bastion`. The usual causes:

- Wrong `INFRAWRENCH_URL`. It must start with `wss://` (not `https://`) and end in `/api/bastions/agent`.
- Outbound HTTPS is blocked on the bastion's host.
- A typo in the token. Copy it from the modal again. Tokens work once, so if you closed the modal without copying, revoke the bastion and create a new one.

**A self-hosted account fails with "Update the bastion agent"**

Bastion agents older than version 0.2.0 refuse hosts an account was configured with. Pull the latest image and start the container again:

```sh
docker pull registry.infrawrench.com/bastion-agent:latest
```

**A self-hosted account fails with "resolves to a non-public address"**

The bastion looked the host up and got a private, loopback or link-local address. A bastion doesn't connect to those. Use an [SSH tunnel](./ssh-tunnels.md) instead.

**API calls fail with `BastionDisconnectedError`**

The account is bound to a bastion that isn't connected right now. Start the bastion again, or switch the account's **Egress via** setting to **Direct** when you edit the account.
