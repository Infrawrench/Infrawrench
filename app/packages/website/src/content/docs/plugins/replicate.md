---
title: Replicate
description: Browse Replicate predictions, models, versions, trainings and files; create models, start trainings, and create or rescale deployments.
sidebar_order: 38
---

Replicate runs community and private models behind one API. Use this plugin to see your prediction history, trainings, deployments and uploaded files.

## What you can manage

- **Predictions**: status, input preview, timings, model-specific metrics (token counts, throughput, image counts), logs, output link, and cancel while running
- **Deployments**: create one, rescale it, roll it to a new version, delete it
- **Models**: the models your account actually runs, with run counts, version ids and the README. Create, edit and delete your own.
- **Model versions**: every version pushed to a model you own, with its Cog version. Delete old ones.
- **Trainings**: start one, follow its logs, see the destination model and the version each run produced
- **Files**: uploaded prediction inputs, with checksums and expiry
- **Collections**: Replicate's curated model groups
- **Hardware**: the hardware a deployment can run on

## Connect your account

Create a token at [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) and paste it as **API Token**. It starts with `r8_`.

Replicate has one kind of token, and it covers predictions, models, trainings, deployments and files.

![The Replicate Add-account form with the API token field](https://agent-assets.infrawrench.com/docs-screenshots/plugins/replicate/add-account.png)

## Things you can do

- **Create a deployment** by picking a model and hardware. Leave the version blank to use the model's latest version, so you don't have to paste a 64-character hash.
- **Rescale a deployment** by editing its minimum and maximum instances. A minimum of 0 lets it scale to zero between requests, at the cost of a cold start on the next one.
- **Create a model** with a visibility choice and a hardware picker. The owner is filled in from your token, since a token can only create models for its own account. This is how you make the destination for a fine-tune.
- **Edit a model's details**: description, and the GitHub, paper, license and weights URLs. Replicate saves the weights URL but never shows it again, so the field reads blank after saving.
- **Read a model's README** in its **Describe** tab.
- **Start a training**: pick a trainer model and a destination model, then give the trainer's input as JSON. Leave the trainer version blank to use its latest. You can add a webhook limited to start, output, logs or completed events.
- **Follow logs** for a prediction or training in its **Logs** tab.
- **Delete a model** in two steps: delete its versions, then the model. Replicate only deletes private models with no versions left, and won't delete a version while a deployment, a training or another account's prediction still uses it. Deleting a version also deletes every prediction made with it, output files included.
- **Cancel a running prediction or training** from its detail page.
- **Watch traffic** on a deployment or model in its **Metrics** tab: predictions, failed predictions, average predict time and average queue time (from creation to start), over the last 24 hours by default. These are counted from your most recent 2,000 predictions, so on a busy account the charts start at the oldest one in that set.

## Tips & limits

- **There's no cost data.** Replicate doesn't share credits, balance or usage, so Infrawrench shows no spend for it. The deployment page links to your Replicate billing dashboard instead. Metrics tabs count predictions, not spend.
- **Output files expire after one hour.** For predictions made through the API, Replicate deletes the input, output and logs an hour after the prediction finishes, and the `replicate.delivery` links stop working. Predictions made on the Replicate website keep their files. Download anything you want to keep.
- **Uploaded input files expire on their own schedule.** Check the expiry time on each file's detail page.
- **`aborted` isn't `canceled`.** `canceled` means a run was stopped while running. `aborted` means it was ended before it started, usually because it missed a deadline. Both appear, with different labels and colours.
- **Official models show their version as `hidden`.** That's Replicate's placeholder, not a missing value.
- **The Models list shows models your account uses**: anything it deploys, trains into, or has run recently. A brand-new account with no predictions has an empty Models list, and a model you just created appears once a training writes to it or it's run. Model versions are listed for the models in that list that you own. Replicate has no list of an account's own models, so a model of yours stays here once seen, even after it falls out of your recent runs. One you delete on Replicate stays too, until you remove it here.
- **There's no model search.** The model pickers offer the models your account already uses.
- **Deployments can only be deleted after 15 minutes offline and unused**, which is Replicate's rule.

## Speech

Replicate's speech models are community models that run as regular predictions, so this plugin has no [Speech tab](../features/speech-testing.md). Run a speech model as a normal prediction instead.
