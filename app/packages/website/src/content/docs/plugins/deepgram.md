---
title: Deepgram
description: Manage Deepgram projects, API keys, members, invites, balances and purchases, Voice Agent configurations and variables, chart usage, read the request log, and round-trip audio through Nova transcription and Aura voices.
sidebar_order: 43
---

Connect a Deepgram project to manage its keys, members and voice agents, chart usage and cost, and test transcription and voices.

## What you can manage

- **Projects**: the workspace that owns everything else. Rename it, chart its usage, read its request log, and use the Speech tab from it. Deleting a project is permanent and deletes everything in it.
- **API keys**: create one with a scope, tags and an optional expiry, or delete it. The secret is shown **once**, right after you create it.
- **Members**: the users with access to a project. Change a member's role between `member`, `admin` and `owner`, or remove them.
- **Invites**: invite an email address with a scope, or revoke an invite.
- **Balances**: prepaid credit on the project. Read-only; top up in Deepgram's billing console.
- **Models**: the speech-to-text models and Aura voices your project can use, in one list. Voices show accent, age, characteristics, use cases and a preview clip.
- **Agent configurations**: saved Voice Agent `agent` blocks that a session references by `agent_id` instead of sending the whole block. To create one, pick the speech-to-text model (Flux by default), a Deepgram-managed LLM, an Aura voice, a prompt and an optional greeting. Or paste a full agent block under **Advanced** to store functions, your own LLM endpoint or another speech provider. Deepgram doesn't let you change a configuration after you save it, so you can only edit its labels (metadata, as `key=value` pairs). The name you give it is stored as the `name` label.
- **Agent variables**: `DG_<NAME>` template variables Deepgram fills into agent configurations when a session starts. The `DG_` prefix is added for you. Values can be plain text or any JSON. Edit a variable to change its value.
- **Purchases**: the purchase orders behind a project's credit (prepaid, promotional and so on) with amount and expiry. Read-only.
- **Distribution credentials**: the container registry credentials for pulling Deepgram's self-hosted images, for projects with self-hosted access. You see their scopes and creator and can revoke them. Create them in the Deepgram Console, the only place their username and secret are shown.

## Connect your account

In the Deepgram Console, open your project's **Settings > API Keys** and create a key. Paste it into Infrawrench.

The key's scope decides how much you can do:

- A **member** key can transcribe and synthesize, but can't list keys, members, invites or balances. Those sections stay empty.
- An **admin** or **owner** key sees the whole project.

Deepgram shows the secret only once. If you no longer have it, create a new key.

![Deepgram Add-account form with the API key field and its scope explanation](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepgram/add-account.png)

## Test speech in the Speech tab

Open a project to get a **Speech** tab with two halves. See [Speech testing](../features/speech-testing.md) for how the panel works.

- **Synthesize** turns text into mp3. The voice picker only shows Aura voices your project can use.
- **Transcribe** returns a transcript with punctuation, smart formatting, speaker labels and utterance segments. The word table under the transcript shows who said what.

If the key can't read the project's models, the tab tells you that you need a member scope key or better.

![Deepgram Speech tab on a project, with the Aura voice picker open and a diarised transcript with speaker labels below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/deepgram/speech-tab-aura.png)

## Metrics

Projects get a **Metrics** tab for the last 30 days. It charts requests, audio hours and TTS characters. If the project uses voice agents, it also charts Voice Agent hours and the LLM tokens in and out that agents used. **Total hours** appears next to audio hours when they differ (multichannel audio counts every channel). Requests are also split by endpoint (`listen`, `speak`, `agent`, `read`) and by method (`sync`, `async`, `streaming`).

**API keys** and **models** have their own Metrics tab with the same charts, filtered to the requests that key made or that ran on that model. An API key's dashboard card also shows its request count over the last 30 days.

## Read the request log

Projects also get a **Logs** tab listing recent API requests, oldest first: time, status code, method, path, deployment, audio duration, billed USD, request id and the API key that made it. Use the source dropdown to show only failed requests or one endpoint (`listen`, `speak`, `agent`, `read`). You can show up to 1,000 lines.

## Cost graphs

Deepgram accounts feed [cost graphs & budgets](../features/cloud-costs.md) with real billed USD per day, not estimates. Spend is broken down by **line item**, Deepgram's billed product and model pair such as `streaming::nova-3`. Every project the key can see is included, tagged with its project id. Tags you attach to your own requests come through as a tag too, combined into one value per day, because Deepgram bills the combination rather than each tag separately.

You get a year of history after you connect, and late usage is filled in over the next few days.

- **Billing needs an admin or owner key.** A member scope key is refused, and the account tells you so.
- **Enterprise contracts may not show prices.** If Deepgram reports usage but no dollar amounts, nothing is recorded and the account explains why. Check your balance and invoices in the Deepgram Console instead.

## Tips & limits

- **Synthesis is capped at 2,000 characters** per request. That's Deepgram's own limit, and the counter stops you before you go over.
- **The Speech tab caps clips at 25 MB**, well below the 2 GB Deepgram accepts. Send anything larger through Deepgram's API directly.
- **You see a new key's secret only once**, with a warning. Deepgram doesn't store it, so there's no way to get it back.
- **Removing a member revokes every API key they own in that project**, not just their access.
- **The name is the only project setting you can edit.**
- **Agent configurations show their placeholders.** Variables are filled in when a session starts.
- **Deleting an agent configuration can break live traffic.** Sessions that reference its `agent_id` fail afterwards, so move them to a replacement first.
- **Balances are read-only.** Top up in Deepgram's console.
