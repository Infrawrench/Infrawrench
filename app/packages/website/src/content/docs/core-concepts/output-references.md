---
title: Output references
description: Wire one resource's output into another resource's input instead of copy-pasting.
sidebar_order: 2
---

Many resources depend on credentials from other resources. A Postgres client needs a connection string. A Kubernetes plugin needs a kubeconfig. You could copy those values by hand every time they change — or you can reference them.

## The idea

A field that holds a credential (API token, connection string, kubeconfig, password) can be filled in two ways:

- **Literal** — you paste the actual value.
- **Output reference** — the field points at another resource’s output field.

Output references re-resolve automatically. If the upstream resource’s value changes (say, a managed database rotates its password), the dependent resource picks up the new value the next time it connects.

## Where the references come from

Credential forms are plain fields — there is no link icon on **Connection string** or **Kubeconfig** that opens a picker. References are wired from the resource that _produces_ the value, or from a field that already holds one:

- **From the upstream resource's own page.** A managed database or cluster carries a tab for the plugin that consumes it — a DigitalOcean Postgres database gets a **PostgreSQL** tab, a DOKS or EKS cluster gets a **Kubernetes** tab — and opening that tab passes the connection string, CA certificate or kubeconfig straight through as a reference. Nothing is typed and no second account is created. That is what a credential field's help text means when it says you can "link this to a DigitalOcean Managed Database after adding".
- **From a picker the plugin declares.** DNS record content is the one create form with a reference control today: a **Value source** select offering **Pick a resource** or **Use custom value** — see [DNS records](#dns-records) below.
- **From a field that already holds a secret or a reference.** Those render with a **Reroll** link that opens a dialog for pointing them somewhere else — see [Secret rerolls](./secret-rerolls.md).

## Example

You have a DigitalOcean managed Postgres database and you want the [SQL editor](../features/sql-editor.md) pointed at it.

1. Open the managed database resource.
2. Switch to its **PostgreSQL** tab.
3. That's it — the connection string and CA certificate flow through from the database's outputs.

The Postgres side now follows whatever DigitalOcean returns.

<insert [A DigitalOcean managed Postgres database detail page with the PostgreSQL peer tab open and the SQL editor connected through it] here>

## Which plugins expose outputs

Any resource that produces a credential-ish value. Common ones:

- DigitalOcean managed databases — `connectionString`, `privateConnectionString`
- Neon branches — `connectionString`
- EKS / AKS / GKE clusters — `kubeconfig`
- PlanetScale branches — `connectionString`
- Turso databases — `url`, `authToken`

## DNS records

DNS record content uses the same machinery. When you create an **A**, **AAAA**, or **CNAME** record, a **Value source** select appears above the value, offering **Pick a resource** (the default) or **Use custom value**. Leave it on **Pick a resource** and the value field becomes a picker that searches across your accounts for IP- or hostname-producing resources; picking one stores a live reference, so the record tracks the source's address and is re-applied at the provider when it changes. Other record types (MX, TXT, SRV, NS) have no such select — their value is plain text. See [DNS records](../features/dns-records.md).

## When to use a literal instead

- The upstream resource is not managed by infrawrench.
- You want to pin a specific credential regardless of upstream changes.

See [Secret rerolls](./secret-rerolls.md) for changing a reference after you set it.

## Seeing the wiring

Every reference is also a dependency edge, and the [dependency graph](../features/dependency-graph.md) draws them all at once — including the blast radius of any resource other things depend on.
