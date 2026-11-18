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

![The Reroll connectionString dialog on a Postgres database, with the From resource tab listing a Neon branch (selected) and a DigitalOcean managed database, the Paste literal value tab beside it, and the Confirm button](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/secret-rerolls/reroll-dialog.png)

The new source is used from the next connection. Existing connections aren't dropped.

## What the From resource tab lists

**From resource** lists the resources in your accounts with an output that can fill the field: mostly the same outputs that give a resource a tab for the field's plugin. For a Postgres connection string that means managed Postgres databases such as a DigitalOcean database or a Neon branch, with each one's provider and output under its name. A resource whose tab wouldn't show (a DigitalOcean MySQL database, for a Postgres field) isn't listed.

Some fields have nothing that can fill them, such as a Cloud SQL root password. The tab then says **No compatible resources found.** and you paste a value instead.

## Pasted values the provider owns

When the field is something the provider itself holds, like the Cloud SQL root password, a pasted value is set at the provider first and stored only once the provider accepts it. If the provider refuses it (a password that's too short, say), you get an error and nothing changes.

## When to reroll

- **Moving providers:** your Postgres database moves from DigitalOcean to Neon.
- **Rotated credentials:** you revoked the upstream token and issued a new one under a different resource.
- **Splitting environments:** staging and prod shared one database, you split them, and the prod client needs to point somewhere else.

## Reroll or wait?

If the upstream resource itself changed (for example DigitalOcean rotated the password), you **don't** need to reroll. The reference picks up the new value on its own. Reroll only when you want to switch which upstream you point at.
