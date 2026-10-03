---
title: Replicate
description: Browse Replicate predictions, models, versions, trainings and files; create models, start trainings, and create or rescale deployments.
sidebar_order: 38
---

Replicate runs community and private models behind one API. This plugin gives you the account's prediction history, its trainings, its deployments, and the files it has uploaded.

## What you can manage

- **Predictions**: status, input preview, timings, model-specific metrics (token counts, throughput, image counts), logs, output link, and cancel while running
- **Deployments**: create one, rescale it, roll it to a new version, delete it
- **Models**: the models this account actually runs, with run counts, version ids and the README; create, edit and delete your own
- **Model versions**: every version pushed to a model you own, with its Cog version; delete old ones
- **Trainings**: start one, follow its logs, see the destination model and the version each run produced
- **Files**: uploaded prediction inputs, with checksums and expiry
- **Collections**: Replicate's curated model groups
- **Hardware**: the SKUs a deployment can run on

## Credentials

Create a token at [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) and paste it as **API Token**. It starts with `r8_`.

Replicate has a single token type — the same token covers predictions, models, trainings, deployments and files.

![The Replicate Add-account form with the API token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/replicate/add-account.png)

## Notable flows

- **Create a deployment** with a model picker and a hardware picker. Leave the version blank and the plugin resolves the model's latest version for you, rather than making you paste a 64-character hash.
- **Rescale a deployment** by editing its minimum and maximum instances. Setting the minimum to 0 lets it scale to zero between requests, at the cost of a cold start on the next one.
- **Create a model** with a visibility choice and a hardware picker. The owner is filled in from your token, since Replicate only lets a token create models for its own account. This is how you make the destination for a fine-tune.
- **Edit a model's metadata**: description, and the GitHub, paper, license and weights URLs. Replicate accepts the weights URL but never returns it, so the field reads blank after saving.
- **Read a model's README** in its **Describe** tab.
- **Start a training** by picking a trainer model and a destination model, then giving the trainer's input as JSON. Leave the trainer version blank to use its latest. An optional webhook can be limited to start, output, logs or completed events.
- **Follow logs** for a prediction or training in its **Logs** tab. The text is the log Replicate stores on the run itself.
- **Delete a model** in two steps: delete its versions, then the model. Replicate only deletes private models with no versions left, and refuses to delete a version while a deployment, a training or another account's prediction still uses it. Deleting a version also deletes every prediction made with it, output files included.
- **Cancel a running prediction or training** from its detail page.
- **Watch traffic** on a deployment or model in its **Metrics** tab: predictions, failed predictions, average predict time and average queue time (from creation to start), over the last 24 hours by default. Replicate has no metrics endpoint, so these are counted from your predictions list, filtered to the window. The list is walked at most 2,000 predictions deep; on a busy account the charts start at the oldest prediction that reached rather than showing false zeros before it.

## Tips & limits

- **There is no billing, usage or spend API.** `GET /v1/account` returns your username and nothing else: no credits, no balance, no usage series. Infrawrench therefore shows no cost data for Replicate at all; the deployment page links to the Replicate billing dashboard instead. The Metrics tabs count predictions, not spend.
- **Output files expire after one hour.** For predictions created through the API, Replicate deletes the input, output and logs an hour after the prediction completes, and the `replicate.delivery` URLs stop working. Predictions made on the Replicate website keep their files. Download anything you want to keep.
- **Uploaded input files expire on their own schedule**, which is not the same window. Each file carries its own `Expires` timestamp — the detail page shows it, and that is the value to trust.
- **`aborted` is not `canceled`.** Replicate distinguishes a run that was stopped while executing (`canceled`) from one that was terminated before it ever started (`aborted`, usually a missed deadline). Both appear, with different labels and colours.
- **Official models report their version as `hidden`.** That is Replicate's placeholder, not a missing value, and the detail page labels it as such.
- **The model list is derived, not enumerated.** Replicate has no "list my models" endpoint (`GET /v1/models` returns the entire public catalogue), so the plugin shows the models this account touches: anything it deploys, trains into, or has run recently. A brand-new account with no predictions will have an empty Models list, and a model you just created shows up once a training writes to it or it is run. Model versions are listed for the models in that list that you own.
- **Model search is not wired up.** Replicate's search (`GET /v1/search`, still in beta) covers the public catalogue, which is not something this plugin manages; the model pickers offer the models your account already uses.
- **Deployments can only be deleted after 15 minutes offline and unused**, per Replicate's own rule.
- **List pages are a fixed 100 records.** There is no page-size parameter anywhere in the API, so the plugin follows Replicate's opaque cursor URLs and caps how far back it walks.

## Speech

Replicate has no first-party audio endpoint — its speech models are community models run through the asynchronous `/predictions` lifecycle. That does not fit the one-shot request/response of the [Speech tab](../features/speech-testing.md), so this plugin deliberately does not wire one. Run a speech model as a normal prediction instead.
