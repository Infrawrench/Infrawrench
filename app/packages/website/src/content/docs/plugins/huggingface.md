---
title: Hugging Face
description: Deploy and scale Inference Endpoints, run Spaces and Jobs, manage model and dataset repositories, compare Inference Providers and chat with any model, and track usage, quotas and organization tokens on Hugging Face.
sidebar_order: 41
---

## What you can manage

- **Inference Endpoints**: create (from the Inference Catalog or with your own model, cloud, region and hardware), edit autoscaling, security level, revision and tags, change hardware, pause, resume, scale to zero and delete. Each endpoint has a **Metrics** tab, a **Logs** tab and a **Playground** for text-generation models.
- **Spaces**: create (Gradio, Docker or static, on any hardware), change visibility, restart, factory rebuild, pause, change hardware, set the sleep time, and add or remove secrets and variables. Deleting a Space deletes the repository.
- **Models** and **Datasets**: the repositories your namespace owns. Create, delete, switch visibility, turn gated access on or off, and disable discussions.
- **Jobs** and **Scheduled Jobs**: run a Docker image or a Space's image on Jobs hardware, cancel a running job, and create, edit, suspend, resume or trigger cron schedules.
- **Inference Provider Models**: every model the Inference Providers router serves, with each partner provider's price per million tokens, context length, time to first token and throughput, plus a Playground.
- **Service Accounts** (Team and Enterprise organizations): create and delete, mint read, write or inference-only tokens from **Get credentials**, and delete existing tokens.
- **Member Access Tokens** (Team and Enterprise organizations): every member token the organization can see, with role, last use and approval state. Revoke a token's access to the organization.
- **Webhooks**: your Hub webhooks, with enable, disable and delete.

## Credentials

1. On huggingface.co open **Settings → Access Tokens → Create new token**.
2. A **Write** token covers everything. For a **fine-grained** token, grant on your user and on each organization you want to manage:
   - Repositories: read and write
   - Inference Endpoints: read and write
   - Jobs: write
   - Inference: Make calls to Inference Providers
   - Webhooks: read and write
   - Billing: read usage
3. Paste the `hf_…` token, then pick the **Namespace**: your user, or one of your organizations. The picker is filled from the token, so you never type an organization name.

Add one account per namespace you want to manage. Organization-only features (service accounts, member tokens, billed Inference Providers usage) need an organization admin's token and a Team or Enterprise plan.

<insert [Hugging Face Add-account form with the access token filled in and the Namespace picker open, listing the user and two organizations] here>

## Creating an Inference Endpoint

Choose a **Configuration**:

- **From the Inference Catalog** lists the models Hugging Face has tested, each with an engine (vLLM, TGI, llama.cpp…) and hardware already chosen. Pick one and name the endpoint.
- **Custom** lets you choose the model (your own repositories, trending models, or any model id), the task, the **Cloud and Region** (AWS, Google Cloud and Azure regions available to your namespace), and the **Hardware** for that region with its price per replica-hour. Set min and max replicas; a minimum of 0 scales the endpoint to zero after the idle timeout so it costs nothing until the next request.

<insert [Create Inference Endpoint form in Custom mode, with the AWS us-east-1 region selected and the hardware picker showing GPU sizes and monthly prices] here>

The detail page shows the hourly price and the current burn (price times running replicas), the replicas and their stages, and **Change hardware**, which offers every size available in the endpoint's region.

## Metrics, logs and playground

The endpoint **Metrics** tab charts requests by status code, response time percentiles, pending requests, running replicas, and CPU, memory, GPU and GPU memory per replica. Endpoints running vLLM or SGLang with metrics enabled also get KV cache usage, prefix cache hit ratio, time to first token, inter-token latency and waiting/running requests. The default window is the last three hours.

The **Logs** tab reads the structured logs API and can filter to one replica.

The **Playground** calls the endpoint's OpenAI-compatible `/v1/chat/completions` route (served by TGI, vLLM and SGLang containers). On an Inference Provider model it calls `router.huggingface.co`, and the model picker chooses who serves it: the plain id takes the fastest provider, `:cheapest` the cheapest, `:preferred` follows your provider order, and `:<provider>` pins one.

<insert [Inference Provider model detail page showing the providers table with prices and latency, and the Playground tab with the provider picker open] here>

## Costs and quotas

- **Organizations**: billed Inference Providers spend per day, by model, with the provider and the member who made the requests as tags. History goes back 12 months.
- **Users**: Jobs spend for the current billing period, per job, with the hardware as a tag.
- **Quotas**: Inference Endpoints accelerator quotas per cloud and GPU type, and (for users) the daily ZeroGPU quota.

## Status

Incidents from status.huggingface.co are matched to your resources: Hub and Git incidents to repositories and Spaces, Inference Endpoints incidents to endpoints, Spaces Proxy incidents to Spaces, and Jobs incidents to Jobs.

## Tips & limits

- **Inference Endpoints and Spaces compute are not in the cost data.** Hugging Face documents no billing API for them, so the endpoint page shows the list price per replica-hour instead. Check the billing page on huggingface.co for those totals.
- A namespace without Inference Endpoints billing set up shows no endpoints rather than an error.
- Space secrets are write-only: the table lists their keys and descriptions, never their values. Adding or removing a secret or variable restarts the Space.
- Free `cpu-basic` Spaces always sleep after 48 hours idle; only upgraded hardware can change the sleep time.
- A job's command runs under `/bin/sh -c`, so type it as you would in a shell. Leave it empty to use the image's entrypoint.
- Revoking a member token removes its access to the organization only; it keeps working for the owner's personal repositories.
- Endpoint security levels map to Hugging Face's `public`, `authenticated` (shown as Protected in Hugging Face's own console) and `private` (AWS PrivateLink).
