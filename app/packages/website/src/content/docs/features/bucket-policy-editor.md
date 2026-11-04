---
title: Bucket policy editor
description: Edit S3-style bucket policies with a visual statement builder, templates, warnings and plain-English summaries.
sidebar_order: 9
---

The **Bucket Policy** tab lets you view and edit a bucket's access policy without writing raw JSON. You'll find it on AWS S3, DigitalOcean Spaces and Scaleway Object Storage buckets. It edits the same AWS-style policy JSON, but shows it as a list of statements you can click into.

![Bucket policy editor showing the visual statement list with a Plain English side panel](https://agent-assets.infrawrench.com/docs-screenshots/features/bucket-policy-editor/visual-statements.png)

## Find your way around

- **Toolbar:** switch between **Visual** and **JSON**, **Reload** the current policy, or **Apply** your changes. Apply is disabled while there are errors.
- **Warnings banner:** red errors block saving. Yellow warnings point out risky patterns, like a public principal, an overly broad action or an ARN that doesn't match the bucket. Grey hints help you scope actions to objects or the bucket correctly.
- **Statement list (Visual mode):** each statement is a card. Click one to edit its Sid, Effect, Principal, Action, Resource and Condition. Use ↑ and ↓ to reorder.
- **Plain English panel:** a read-only summary of every statement, for example _"Allow anyone on the internet to perform s3:GetObject on every object in **my-bucket**"_.
- **JSON mode:** a full code editor if you'd rather work in JSON. Changes carry over in both directions. If the JSON has a syntax error, you need to fix it before switching back to Visual.

## Add a statement from a template

Click **+ From template…** to add a known-good statement. If a template needs values (account ID, OAI ID, VPC endpoint or CIDR), you're asked for them first. Templates:

- **Public read of all objects:** allow `s3:GetObject` to `Principal: *` on `bucket/*`.
- **Deny non-HTTPS requests:** deny everything when `aws:SecureTransport=false`. Pair it with a more specific Allow.
- **Cross-account read/write** (AWS S3 only): let another account ID list, get, put and delete.
- **CloudFront OAI read-only** (AWS S3 only): allow object reads only through a specific CloudFront Origin Access Identity.
- **Allow only from a VPC endpoint** (AWS S3 only): deny anything not coming through `aws:SourceVpce`.
- **Restrict to IP allowlist:** deny anything from outside a CIDR range.

## Save or remove a policy

- To **remove a policy**, delete all statements and click **Apply**. An empty policy deletes the bucket policy, so the bucket goes back to having none.
- If the provider rejects your policy, its error is shown in the toolbar. Common ones are _malformed JSON_, _invalid principal ARN_ and _resource ARN does not match this bucket_.
- Policies are reformatted for readability in JSON view, so your original spacing isn't kept.

## What the warnings check

Checks run in the editor. Your policy isn't sent to the provider for evaluation, and the checks don't replace the provider's own access analyzer. They flag:

- **Errors:** a missing Effect, or a statement with neither Action/NotAction or neither Resource/NotResource.
- **Warnings:** `Principal: *` without a Condition (public access), `Action: s3:*` with `Principal: *` (full wildcard), a Resource ARN that doesn't match this bucket, or Resource `*`.
- **Hints:** object-level actions (`s3:GetObject`, `s3:PutObject`, …) whose Resource doesn't end in `/*`, or bucket-level actions (`s3:ListBucket`, `s3:GetBucketAcl`, …) whose Resource points at objects.
