---
title: HashiCorp Vault
description: Manage a self-hosted or HCP Vault cluster - secrets engines, KV v2 secrets with versions, auth methods, ACL policies, PKI roles and certificates, leases, tokens and audit devices - and chart its seal state, leases, tokens and monthly clients.
sidebar_order: 50
---

Connect a Vault cluster, self-hosted or HCP Vault Dedicated, to browse and manage its secrets and the configuration around them.

## What you can manage

- **Cluster**: the account opens on the cluster itself, with its version, seal state and type, unseal threshold, storage, HA leader, standby state and replication modes. **Step down** hands leadership to another node, and **Seal** seals Vault in an emergency. The Metrics tab charts seal and standby state, clock skew, leases, tokens, KV secrets and memory from Vault's telemetry, and the last twelve months of client counts.
- **Secrets engines**: every mount with its type (KV v1 and v2 told apart), TTLs, visibility and plugin version. **Enable** an engine (KV, PKI, Transit, databases, cloud credentials, SSH and more), **Edit** its description, TTLs and UI visibility, or **disable** it, which deletes its data. Deprecated engine plugins are flagged.
- **KV secrets**: every secret in each KV version 2 engine, under its engine. The **Versions** tab lists every version, reveals one, adds a new version (a JSON object or `KEY=value` lines, typed or uploaded), and soft-deletes, restores or destroys versions. **Edit** the number of versions kept, check-and-set, automatic version deletion and custom metadata, or delete the secret with all its versions. **Create** a secret by picking its engine.
- **Auth methods**: path, type, token TTLs and token type. Enable one (AppRole, OIDC, JWT, Kubernetes, userpass, LDAP, GitHub, cloud IAM, TLS certificates…), tune it, or disable it.
- **Policies**: every ACL policy with its HCL. **Edit policy** opens it in a code editor; create policies from a starter template or delete them (root and default are built in).
- **PKI roles**: allowed domains and name rules, key type and TTLs. Create, edit or delete. A role that may issue certificates for any name is flagged.
- **PKI certificates**: the certificates each PKI engine stored (up to 200 per engine), with common name, issuer and validity read from the certificate itself. They appear on the expiry radar. **Revoke** a certificate.
- **Leases**: up to 300 leases on dynamic secrets, with issue and expiry times. **Renew** or revoke.
- **Tokens**: up to 200 tokens by accessor, with policies, the auth path that issued them and expiry. **Renew** or revoke. Root tokens are flagged as a critical posture finding.
- **Audit devices**: file, syslog and socket devices. Enable or disable.

## Credentials

1. Enter the **Vault address** with its port, for example `https://vault.example.com:8200`. For HCP Vault Dedicated, copy the public (or private) cluster address from the cluster's Overview page in the HCP portal.
2. On Vault Enterprise or HCP Vault, enter the **Namespace** (`admin` on HCP Vault).
3. Paste a **Token**, or fill in **AppRole Role ID** and **AppRole Secret ID** instead and Infrawrench logs in and renews the login itself. A periodic token (`vault token create -policy=<policy> -period=768h`) suits a long-lived connection. Listing tokens, leases and audit devices needs a policy with `sudo` on those paths.
4. If Vault's certificate is signed by a private CA, paste the CA certificate under **Advanced options**.

<insert [HashiCorp Vault Add-account form with the address, namespace and token filled in] here>

**Check credentials** probes secrets engines and auth methods, policies, tokens, leases and audit devices separately, and lists the policy path each missing capability needs.

<insert [Vault KV secret detail page with the Versions tab listing versions and the Add version form] here>

<insert [Vault policy Edit policy dialog showing the HCL editor] here>

## Tips & limits

- KV version 1 engines are listed as engines, but only KV version 2 secrets are browsed, because version 1 keeps no versions or metadata.
- Up to 500 secrets per KV engine are listed, and metadata is loaded for the first 200; open a secret to load the rest.
- Vault's telemetry endpoint needs a token allowed to read `sys/metrics` (or unauthenticated metrics access); without it the Metrics tab shows only seal and standby state and client counts.
- Client counts need Vault 1.6 or later; on Vault Community they are tracked once client counting is enabled.
- Provider status comes from HashiCorp's status page and only concerns HCP Vault. A self-hosted cluster is never affected by those incidents.
- Bastion egress has no fixed host list for Vault, because the address is yours; a cluster reachable only through a bastion is not supported yet.
- [Export to Terraform](../features/terraform-export.md) writes secrets engines, auth methods, policies, audit devices and PKI roles for the `hashicorp/vault` provider, with import ids. Secret values are never exported.
