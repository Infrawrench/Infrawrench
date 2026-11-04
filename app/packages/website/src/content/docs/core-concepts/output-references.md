---
title: Output references
description: Wire one resource's output into another resource's input instead of copy-pasting credentials.
sidebar_order: 2
---

Lots of resources need credentials from other resources. A Postgres client needs a connection string. A Kubernetes plugin needs a kubeconfig. Instead of copying those values by hand every time they change, you can reference them.

## Literal or reference

A credential field (API token, connection string, kubeconfig, password) can hold either:

- **A literal**: you paste the actual value.
- **An output reference**: the field points at another resource's output.

References stay current. If the upstream value changes (say a managed database rotates its password), the dependent resource picks up the new value the next time it connects.

## Where references come from

Credential forms are plain fields. There's no picker button on **Connection string** or **Kubeconfig**. You set up a reference from the resource that produces the value, or from a field that already holds one:

- **From the upstream resource's page.** A managed database or cluster has a tab for the plugin that uses it. A DigitalOcean Postgres database gets a **PostgreSQL** tab, and a DOKS or EKS cluster gets a **Kubernetes** tab. Open that tab and the connection string, CA certificate or kubeconfig is passed through as a reference. You type nothing and no second account is created. That's what a field's help text means when it says you can "link this to a DigitalOcean Managed Database after adding".
- **From a picker on the form.** DNS record content is the one create form with this today: a **Value source** select offering **Pick a resource** or **Use custom value**. See [DNS records](#dns-records) below.
- **From a field that already holds a secret or reference.** These show a **Reroll** link that lets you point them somewhere else. See [Secret rerolls](./secret-rerolls.md).

## Example: open a managed Postgres database in the SQL editor

You have a DigitalOcean managed Postgres database and want the [SQL editor](../features/sql-editor.md) connected to it.

1. Open the managed database resource.
2. Switch to its **PostgreSQL** tab.

That's it. The connection string and CA certificate come straight from the database, and the Postgres side follows whatever DigitalOcean returns.

<insert [A DigitalOcean managed Postgres database detail page with the PostgreSQL peer tab open and the SQL editor connected through it] here>

## Resources that expose outputs

Any resource that produces a credential-like value. Common ones:

- DigitalOcean managed databases: `connectionString`, `privateConnectionString`
- Neon branches: `connectionString`
- EKS / AKS / GKE clusters: `kubeconfig`
- PlanetScale branches: `connectionString`
- Turso databases: `url`, `authToken`

## DNS records

When you create an **A**, **AAAA** or **CNAME** record, a **Value source** select appears above the value, with **Pick a resource** (the default) or **Use custom value**.

Leave it on **Pick a resource** and the value field becomes a search across your accounts for resources that have an IP or hostname. Pick one and the record follows that resource's address, updating at the provider when it changes.

Other record types (MX, TXT, SRV, NS) don't have this select. Their value is plain text. See [DNS records](../features/dns-records.md).

## When to use a literal instead

- The upstream resource isn't managed by infrawrench.
- You want to pin a specific credential no matter what happens upstream.

To change a reference after you've set it, see [Secret rerolls](./secret-rerolls.md).

## See all the wiring

Every reference is also a dependency. The [dependency graph](../features/dependency-graph.md) shows them all at once, including what would be affected if a resource other things depend on went away.
