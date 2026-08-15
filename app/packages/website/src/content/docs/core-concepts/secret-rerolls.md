---
title: Secret rerolls
description: Reassign an output reference when the upstream resource changes.
sidebar_order: 3
---

You set up an [output reference](./output-references.md) pointing your Postgres plugin at a DigitalOcean managed database. A month later you migrate to Neon. You do not have to delete and recreate the Postgres account — you can **reroll** the secret.

## What “reroll” means

A reroll reassigns a field that was pointing at one output to point at a different output (or to a literal value). Infrawrench keeps a per-field state record, so rerolling one field does not touch the rest of the resource.

## How to reroll

1. Open the resource that has the referenced field.
2. Find the field (for example **Connection string**). A field holding a secret or a reference shows `•••••`, or `from: <source resource>` when it currently points at an output, with a small **Reroll** link beside it. Some plugins label the link for the field instead — the Postgres account calls it **Reroll Connection**.
3. Click **Reroll**. A **Reroll `<field>`** dialog opens with two tabs: **From resource** and **Paste literal value**.
4. Pick the new upstream resource, or switch to the second tab and paste a literal value.
5. Click **Confirm**.

<insert [The Reroll dialog open on a connection-string field, showing the From resource / Paste literal value tabs and the Confirm button] here>

Infrawrench will resolve the new source on the next connection. Existing connections are not forcibly dropped.

## Common reroll scenarios

- **Provider migration** — Postgres database moves from DO to Neon.
- **Rotated credentials** — you revoked the upstream token and issued a new one under a different resource.
- **Environment split** — staging and prod were sharing one database; you split them and want the prod client to point at a different upstream.

## Reroll vs edit

If the upstream resource itself changed (e.g. DO rotated the password), you do **not** need to reroll — the output reference re-resolves automatically. Reroll is only for switching which upstream you point at.
