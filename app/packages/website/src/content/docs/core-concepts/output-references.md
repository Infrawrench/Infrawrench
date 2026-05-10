---
title: Output references
description: Wire one resource's output into another resource's input instead of copy-pasting.
sidebar_order: 2
---

Many resources depend on credentials from other resources. A Postgres client needs a connection string. A Kubernetes plugin needs a kubeconfig. You could copy those values by hand every time they change — or you can reference them.

## The idea

When you create or edit a resource, any secret-valued field (API token, connection string, kubeconfig, password) can be filled in two ways:

- **Literal** — you paste the actual value.
- **Output reference** — you point at another resource’s output field.

Output references re-resolve automatically. If the upstream resource’s value changes (say, a managed database rotates its password), the dependent resource picks up the new value the next time it connects.

## Example

You have a DigitalOcean managed Postgres database. You want to add a Postgres plugin account that points to it so you can use the [SQL editor](../features/sql-editor.md).

1. Add a new Postgres account.
2. On the **Connection string** field, click the link icon.
3. Pick **DigitalOcean → my-database → connectionString**.
4. Save.

<insert [Field with a "link" icon showing the output-ref picker open] here>

The Postgres account now follows whatever DigitalOcean returns.

## Which plugins expose outputs

Any resource that produces a credential-ish value. Common ones:

- DigitalOcean managed databases — `connectionString`, `privateConnectionString`
- Neon branches — `connectionString`
- EKS / AKS / GKE clusters — `kubeconfig`
- PlanetScale branches — `connectionString`
- Turso databases — `url`, `authToken`

## When to use a literal instead

- The upstream resource is not managed by infrawrench.
- You want to pin a specific credential regardless of upstream changes.

See [Secret rerolls](./secret-rerolls.md) for changing a reference after you set it.
