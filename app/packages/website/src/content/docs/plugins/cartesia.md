---
title: Cartesia
description: Manage Cartesia voices, pronunciation dictionaries, agents and phone numbers, list API keys and organization members and track estimated credit spend with an admin key, and run Sonic synthesis and Ink Whisper transcription from the Speech tab.
sidebar_order: 46
---

## What you can manage

- **Voices**: voices your organization owns and voices from the shared library, with language, the accents and locales each voice can speak, gender, access type, status and whether it is a Pro clone. Edit the name, tagline, description, gender and access of the ones you own, or delete them. With an admin key, each voice has a **Metrics** tab charting the credits it consumed per day.
- **Pronunciation dictionaries**: named sets of text-to-pronunciation overrides applied at synthesis time, with their entries listed inline. Create one, edit its name, description, access and entries, or delete it.
- **Agents**: your Cartesia Managed Agents, with the voice and language they speak, noise suppression, phone numbers, webhook, the Git repository and branch they deploy from, and a table of recent deployments showing which one is live. Edit the name, description, language and noise suppression, or delete the agent.
- **Phone numbers**: Cartesia-provisioned, Twilio and SIP trunk numbers, with the agent each one routes to. Read-only.
- **API keys**: the keys issued for this organization, with who created them and whether that person is still in the org, plus a **Metrics** tab charting each key's daily credits, in total and split by capability (text to speech, speech to text and so on). Read-only, and admin-key only.
- **Organization members**: everyone in your Cartesia organization, with their role and when they joined. Remove a member (admins cannot be removed through the API, and removal keeps their Cartesia account). Admin-key only.

## Credentials

Cartesia gates two endpoints behind a **separate admin key**, so this plugin asks for both.

**API Key** (required): Cartesia console → **API Keys**. Starts `sk_car_`. This drives voice and pronunciation-dictionary listing, text-to-speech and transcription.

**Admin API Key** (optional): created in the same console with the **Admin** key type. Starts `sk_car_admin_` and is **not** interchangeable with the key above. Cartesia only accepts an admin key on `/usage/credits`, `/api-keys` and `/organizations/users`, so leaving it blank hides the **API Keys** and **Organization members** lists, the credit-usage figures and charts, and cost collection cannot run (see [Cost](#cost)). Voices, dictionaries, synthesis and transcription all keep working. Admin keys are created at **play.cartesia.ai/keys/admin**, and only by an organization admin.

![Cartesia Add-account form showing the required API key and the optional admin API key with its sk_car_admin_ placeholder](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/add-account.png)

## Cost

Cartesia spend appears on the **Costs** page, broken down by **capability** — text to speech, speech to text, voice changer and so on — one row per day. It comes from `GET /usage/credits` with daily buckets, and up to a year of history is collected (longer backfills are split into year-long calls, because that is the most Cartesia will answer at once).

Two things to know before you read the numbers.

**It needs the admin key.** Credit usage is one of the routes Cartesia refuses a standard `sk_car_` key on. With the **Admin API Key** field blank there is nothing to collect, so the account shows a setup notice with a link to the console page that creates one — not a silent zero. Only organization admins can create admin keys.

**The amounts are converted from credits, so they are an estimate, not an invoice figure.** Cartesia meters in credits (roughly one credit per character of speech, more per second of audio) and publishes no price per credit and no overage rate — the only public prices are the plan bundles. Infrawrench converts at the cheapest published bundle rate, the Scale plan's $299 per 8 M credits, which is the same rate for every account. If you are on a smaller plan your real cost per credit is higher and the figure here reads low; if you are on a negotiated Enterprise contract it is not modelled at all. Plan-included credits are not subtracted either, so usage inside your monthly allowance still shows as spend. Treat it as the value of what you consumed, and reconcile against Cartesia's own billing before you invoice anyone for it. Budgets and anomaly alerts work off it all the same — it is a faithful picture of consumption trends, just not of your bill.

![Costs page filtered to a Cartesia account, showing the per-capability breakdown and the estimated-amounts notice](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/cost-graph.png)

## The Speech tab

Open a voice for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** runs **Sonic**: `sonic-3.6` (current flagship, 44 languages including Urdu and Odia), `sonic-3.5` (previous generation), `sonic-3` (older, pinned) or `sonic-latest` (a rolling beta that can change without notice, so not for production). Opening a voice preselects it. Audio comes back as 44.1 kHz 128 kbps mp3.
- **Transcribe** always runs **`ink-whisper`** — Cartesia's only transcription model — so the model picker applies to synthesis only, and the language picker applies to transcription.

![Cartesia Speech tab on a voice, showing the Sonic model picker and a synthesized clip in the player](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/speech-tab-sonic.png)

## Tips & limits

- **The Speech tab sets no character cap.** Cartesia documents no per-request transcript limit, so rather than inventing one the plugin lets the provider's own error surface if you go too long.
- **Credit usage is consumption-only.** `GET /usage/credits` returns what you have spent over the last 30 days with no plan limit in the response, so it is never drawn as a used-versus-limit gauge — there is nothing honest to draw it against.
- **Preview audio is usually absent.** Cartesia only returns a voice's `preview_file_url` when the request asks for it with `expand[]=preview_file_url`, and the voice detail page says so where the field would be.
- **There is no `GET /models` endpoint.** The Sonic list is a fixed enum in the plugin rather than a live catalogue, because Cartesia does not publish one.
- **Every request carries a pinned API date.** Cartesia rejects any call without the `Cartesia-Version` header, GETs included. The plugin sends it; you never see it.
- **Shared-library voices belong to Cartesia.** They can be used but not edited or deleted; only voices your organization owns can be changed.
- **Dictionary entries are written as `text = pronunciation`.** The create form takes one per line; the edit form is a single line, so separate entries with semicolons there. Saving replaces the whole list, and entries whose text you did not change keep their case sensitivity.
- **An agent's voice is changed in the Cartesia playground.** The edit form only offers fixed choices, and voices are a live list, so the voice is shown but not editable here. Language, name, description and noise suppression (0 to 100) are.
- **Voice credit charts need the admin key too.** They come from the same `/usage/credits` endpoint as cost collection, broken down by voice.
