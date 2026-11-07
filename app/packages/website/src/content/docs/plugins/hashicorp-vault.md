---
title: HashiCorp Vault
description: Manage a self-hosted or HCP Vault cluster, including secrets engines, KV v2 secrets with versions, auth methods, ACL policies, PKI roles and certificates, leases, tokens and audit devices, and chart its seal state, leases, tokens and monthly clients.
sidebar_order: 50
---

Connect a Vault cluster, self-hosted or HCP Vault Dedicated, to browse and manage its secrets and everything around them.

## What you can manage

- **Cluster**: the account opens on the cluster, with its version, seal state and type, unseal threshold, storage, HA leader, standby state and replication modes. **Step down** hands leadership to another node, and **Seal** seals Vault in an emergency. The Metrics tab charts seal and standby state, clock skew, leases, tokens, KV secrets and memory, plus the last twelve months of client counts.
- **Secrets engines**: every mount with its type (KV v1 and v2 shown separately), TTLs, visibility and plugin version. **Enable** an engine (KV, PKI, Transit, databases, cloud credentials, SSH and more), **Edit** its description, TTLs and UI visibility, or **disable** it, which deletes its data. Deprecated engine plugins are flagged.
- **KV secrets**: every secret in each KV version 2 engine, listed under its engine.
  - The **Versions** tab lists every version. Reveal one, add a new version (a JSON object or `KEY=value` lines, typed or uploaded), and soft-delete, restore or destroy versions.
  - **Edit** the number of versions kept, check-and-set, automatic version deletion and custom metadata, or delete the secret with all its versions.
  - **Create** a secret by picking its engine.
- **Auth methods**: path, type, token TTLs and token type. Enable one (AppRole, OIDC, JWT, Kubernetes, userpass, LDAP, GitHub, cloud IAM, TLS certificates and more), tune it, or disable it.
- **Policies**: every ACL policy with its HCL. **Edit policy** opens it in a code editor. Create policies from a starter template or delete them (root and default are built in).
- **PKI roles**: allowed domains and name rules, key type and TTLs. Create, edit or delete. A role that can issue certificates for any name is flagged.
- **PKI certificates**: every certificate each PKI engine stored, with common name, issuer and validity. They show on the expiry radar. **Revoke** a certificate.
- **Leases**: every lease on dynamic secrets, with issue and expiry times. **Renew** or revoke.
- **Tokens**: every token by accessor, with policies, the auth path that issued them and expiry. **Renew** or revoke. Root tokens are flagged as a critical posture finding.
- **Audit devices**: file, syslog and socket devices. Enable or disable.

## Connect your cluster

1. Enter the **Vault address** with its port, for example `https://vault.example.com:8200`. For HCP Vault Dedicated, copy the public (or private) cluster address from the cluster's Overview page in the HCP portal.
2. On Vault Enterprise or HCP Vault, enter the **Namespace** (`admin` on HCP Vault).
3. Paste a **Token**. Or fill in **AppRole Role ID** and **AppRole Secret ID** instead, and Infrawrench logs in and renews the login for you. A periodic token (`vault token create -policy=<policy> -period=768h`) works well for a long-lived connection. Listing tokens, leases and audit devices needs a policy with `sudo` on those paths. Without it, those tabs keep what they last showed instead of failing on every refresh on the web, and show the refusal in the desktop app.
4. If Vault's certificate is signed by a private CA, paste the CA certificate under **Advanced options**.

<insert [HashiCorp Vault Add-account form with the address, namespace and token filled in] here>

**Check credentials** tests secrets engines and auth methods, policies, tokens, leases and audit devices one by one, and lists the policy path each missing capability needs.

<insert [Vault KV secret detail page with the Versions tab listing versions and the Add version form] here>

<insert [Vault policy Edit policy dialog showing the HCL editor] here>

## Tips and limits

- KV version 1 engines are listed, but you can only browse secrets in KV version 2 engines, since version 1 keeps no versions or metadata.
- Every secret in a KV engine is listed, with metadata for the first 200. Open a secret to load the rest.
- Vault has no paged listing, so each folder costs a request. A poll lists up to 1,000 folders and up to 100,000 secrets, leases, certificates or tokens. Past 100,000 the list fails with an error rather than showing part of it. Folders a poll doesn't reach, and folders the token may not list, keep what was last read.
- Certificates, leases and tokens each take a read to fill in, so a poll reads up to 2,000 of each. On a cluster with more, the rest keep their last values and are read on a later poll, starting from a different place each time.
- The full Metrics tab needs a token allowed to read `sys/metrics` (or unauthenticated metrics access). Without it, you only see seal and standby state and client counts.
- Client counts need Vault 1.6 or later. On Vault Community, they're tracked once client counting is enabled.
- Provider status comes from HashiCorp's status page and only covers HCP Vault. A self-hosted cluster is never affected by those incidents.
- A [bastion](../features/bastion-vms.md) can carry this account's calls to a public address. A cluster on a private address isn't reachable through one.
- [Export to Terraform](../features/terraform-export.md) writes secrets engines, auth methods, policies, audit devices and PKI roles for the `hashicorp/vault` provider, with import ids. Secret values are never exported.
