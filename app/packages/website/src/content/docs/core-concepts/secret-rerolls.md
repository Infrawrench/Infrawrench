---
title: Secret rerolls
description: Point a credential field at a different upstream resource, or a pasted value, when your setup changes.
sidebar_order: 3
---

Say you set up an [output reference](./output-references.md) so your Postgres account uses a DigitalOcean managed database. A month later you move to Neon. You don't need to delete and recreate the Postgres account. You can **reroll** the secret instead.

## What a reroll does

A reroll points a field at a different output, or at a literal value you paste. Only that field changes. The rest of the resource stays as it is.

## Reroll a field

1. Open the resource that has the field.
2. Find the field (for example **Connection string**). A field holding a secret or reference shows `•••••`, or `from: <source resource>` when it points at an output, with a small **Reroll** link beside it. Some plugins name the link after the field. The Postgres account calls it **Reroll Connection**.
3. Click **Reroll**. A **Reroll `<field>`** dialog opens with two tabs: **From resource** and **Paste literal value**.
4. Pick the new upstream resource, or switch tabs and paste a value.
5. Click **Confirm**.

<insert [The Reroll dialog open on a connection-string field, showing the From resource / Paste literal value tabs and the Confirm button] here>

The new source is used from the next connection. Existing connections aren't dropped.

## When to reroll

- **Moving providers:** your Postgres database moves from DigitalOcean to Neon.
- **Rotated credentials:** you revoked the upstream token and issued a new one under a different resource.
- **Splitting environments:** staging and prod shared one database, you split them, and the prod client needs to point somewhere else.

## Reroll or wait?

If the upstream resource itself changed (for example DigitalOcean rotated the password), you **don't** need to reroll. The reference picks up the new value on its own. Reroll only when you want to switch which upstream you point at.
