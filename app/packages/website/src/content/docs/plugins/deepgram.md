---
title: Deepgram
description: Manage Deepgram projects, API keys, members, invites, balances and purchases, Voice Agent configurations and variables, chart usage, read the request log, and round-trip audio through Nova transcription and Aura voices.
sidebar_order: 43
---

## What you can manage

- **Projects** — the workspace that owns everything else. Rename it, chart its usage, read its request log, and run the Speech tab from it. Deleting a project is permanent and takes everything in it along.
- **API keys** — create one with a scope, tags and an optional expiry, and delete it. The secret is shown **once**, on the create response.
- **Members** — the users with access to a project. Change a member's role between `member`, `admin` and `owner`, or remove them.
- **Invites** — send one to an email address with a scope, or revoke it. Invites are addressed by email rather than by an id.
- **Balances** — prepaid credit on the project. Read-only; top-ups happen in Deepgram's billing console.
- **Models** — the project's entitled speech-to-text models and Aura voices in one list. TTS entries carry the full voice metadata: accent, age, characteristics, use cases and a preview clip.
- **Agent configurations** — saved Voice Agent `agent` blocks that a session references by `agent_id` instead of sending the whole block. Create one by picking the speech-to-text model (Flux by default), a Deepgram-managed LLM, an Aura voice, a prompt and an optional greeting; or paste a full agent block under **Advanced** to store functions, your own LLM endpoint or another speech provider. Deepgram treats the configuration as immutable, so only its labels (metadata, as `key=value` pairs) can be edited afterwards; the name you give it is stored as the `name` label.
- **Agent variables** — `DG_<NAME>` template variables Deepgram substitutes into agent configurations when a session starts. The `DG_` prefix is added for you; values can be plain text or any JSON. Edit a variable to change its value.
- **Purchases** — the purchase orders behind a project's credit (prepaid, promotional and so on) with amount and expiry. Read-only.
- **Distribution credentials** — the container registry credentials used to pull Deepgram's self-hosted images, for projects that have self-hosted access. Listed with their scopes and creator, and revocable; create them in the Deepgram Console, which is the only place their username and secret are shown.

## Credentials

One field. Deepgram Console → your project's **Settings → API Keys**.

Deepgram has a single key type but **three scopes**, and the scope decides how much of this plugin works:

- a **member** key can transcribe and synthesize, but cannot list keys, members, invites or balances — those sections stay empty,
- an **admin** or **owner** key sees the whole project.

The secret is shown once at creation and cannot be retrieved afterwards, so if you no longer have it, create a replacement rather than hunting for the old one.

![Deepgram Add-account form with the API key field and its scope explanation](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepgram/add-account.png)

## The Speech tab

Open a project for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** posts to `POST /v1/speak` and returns mp3. The voice picker is filled from your project's own Aura entitlements, so you only ever see voices you can actually call.
- **Transcribe** posts the clip's **raw bytes** to `POST /v1/listen` with punctuation, smart formatting, diarisation and utterance segmentation all on — so the word table under the transcript carries speaker labels.

If the key cannot read the project's model catalogue, the tab explains that a member-scope key or better is needed instead of failing silently.

![Deepgram Speech tab on a project, with the Aura voice picker open and a diarised transcript with speaker labels below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepgram/speech-tab-aura.png)

## Metrics

Projects get a **Metrics** tab over the last 30 days, charting requests, audio hours and TTS characters, plus Voice Agent hours and the LLM tokens in and out that agents spent, when the project uses voice agents. **Total hours** appears alongside audio hours when the two differ (multichannel audio counts every channel). Requests are also split by endpoint (`listen`, `speak`, `agent`, `read`) and by method (`sync`, `async`, `streaming`). Deepgram can return several rows per interval (one per grouping key), so the plugin sums them per bucket rather than assuming one row per point.

**API keys** and **models** get a Metrics tab of their own, with the same series filtered to the requests that key authenticated (`accessor=`) or that ran on that model (`model=`, which takes the model's UUID rather than its canonical name). An API key's dashboard card also shows its request count over the last 30 days.

## Request log

Projects also get a **Logs** tab listing recent API requests from `GET /v1/projects/{id}/requests`, oldest first: time, status code, method, path, deployment, audio duration, billed USD, request id and the API key that made it. The tab's source dropdown filters to failed requests or to one endpoint (`listen`, `speak`, `agent`, `read`), and the line count is passed straight through as the page size, up to Deepgram's limit of 1,000.

## Cost graphs

Deepgram accounts feed [cost graphs & budgets](../features/cloud-costs.md) from the billing breakdown (`GET /v1/projects/{project_id}/billing/breakdown`) — real billed USD at daily granularity, no estimating from a rate card. Spend is broken down by **line item**, Deepgram's billed product/model pair such as `streaming::nova-3`, and every account the key can see is collected: one request per project, with the project id attached to each row as a tag. Any tags you attach to your own requests come through as a tag too, joined into one value per bucket, because Deepgram bills the combination rather than each label separately.

A year of history is requested on the first sync and the most recent three days are re-fetched afterwards, so late-arriving usage lands where it belongs.

- **Billing needs an admin or owner key.** A member-scope key is refused, and the account says so rather than quietly graphing nothing.
- **Enterprise contracts may not price usage through the API.** When the breakdown comes back with activity but no dollar amounts, nothing is recorded and the account explains why — a confident $0 for an account that is genuinely spending would be the worse answer. Check the balance and invoices in the Deepgram Console in that case.

## Tips & limits

- **Synthesis is capped at 2,000 characters** per request. That is Deepgram's own limit on `/v1/speak`, and the counter enforces it before the call goes out.
- **The Speech tab caps clips at 25 MB**, well below what Deepgram itself accepts (2 GB). The panel sends audio base64-encoded inside a JSON request, and base64 inflates by a third — 25 MB is what survives that round trip. Send anything larger through Deepgram's own API directly.
- **A new key's secret exists in exactly one place: the create response.** The plugin shows it once with a warning. Deepgram only stores the key id and a truncated prefix, so there is genuinely no way to read it back.
- **Deleting a member revokes every API key they own inside that project**, not just their access.
- **Renaming is the only project edit.** `name` is the sole documented mutable attribute.
- **Agent configurations are listed with their placeholders.** Variables are substituted when a session starts, not when the configuration is read.
- **Deleting an agent configuration can break live traffic.** Sessions that reference its `agent_id` fail afterwards, so move them to a replacement first.
- **Balances are read-only by design.** There is no billing mutation in the API — top-ups go through Deepgram's console.
