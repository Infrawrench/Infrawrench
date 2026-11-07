---
title: Cartesia
description: Manage Cartesia voices, pronunciation dictionaries, agents and phone numbers, list API keys and organization members and track estimated credit spend with an admin key, and run Sonic synthesis and Ink Whisper transcription from the Speech tab.
sidebar_order: 46
---

## What you can manage

- **Voices**: voices your organization owns and voices from the shared library, with language, the accents and locales each voice can speak, gender, access type, status and whether it is a Pro clone. Edit the name, tagline, description, gender and access of the ones you own, or delete them. With an admin key, each voice has a **Metrics** tab charting the credits it used per day.
- **Pronunciation dictionaries**: named sets of text-to-pronunciation overrides applied when speech is generated, with their entries listed inline. Create one, edit its name, description, access and entries, or delete it.
- **Agents**: your Cartesia Managed Agents, with their voice and language, noise suppression, phone numbers, webhook, the Git repository and branch they deploy from, and recent deployments showing which one is live. Edit the name, description, language and noise suppression, or delete the agent.
- **Phone numbers**: Cartesia-provisioned, Twilio and SIP trunk numbers, with the agent each one routes to. Read-only.
- **API keys**: your organization's keys, with who created them and whether that person is still in the org, plus a **Metrics** tab charting each key's daily credits, in total and split by capability (text to speech, speech to text and so on). Read-only, and admin key only.
- **Organization members**: everyone in your Cartesia organization, with their role and when they joined. Remove a member (admins can't be removed this way, and removal keeps their Cartesia account). Admin key only.

## Connect your account

Cartesia keeps some features behind a separate admin key, so you can enter two keys.

**API Key** (required): in the Cartesia console, open **API Keys**. It starts with `sk_car_`. This covers voices, pronunciation dictionaries, text to speech and transcription.

**Admin API Key** (optional): create it in the same console with the **Admin** key type, at **play.cartesia.ai/keys/admin**. Only an organization admin can create one. It starts with `sk_car_admin_` and is **not** interchangeable with the key above. Without it, you won't see the **API Keys** and **Organization members** lists, credit usage figures and charts, or costs (see [Cost](#cost)). Voices, dictionaries, synthesis and transcription all keep working. If you remove the admin key from an account later, the keys and members already listed stay as they were last read rather than disappearing, and stop updating.

![Cartesia Add-account form showing the required API key and the optional admin API key with its sk_car_admin_ placeholder](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/add-account.png)

## Cost

Cartesia spend appears on the **Costs** page, one row per day, broken down by **capability**: text to speech, speech to text, voice changer and so on. Up to a year of history is collected.

Two things to know before you read the numbers.

**It needs the admin key.** Without one there's nothing to collect, so the account shows a setup notice with a link to the console page where you create one.

**The amounts are estimates, not invoice figures.** Cartesia bills in credits (roughly one credit per character of speech, more per second of audio) and publishes no price per credit, only plan bundles. Infrawrench converts at the cheapest published bundle rate, the Scale plan's $299 per 8 M credits, for every account. On a smaller plan your real cost per credit is higher, so the figure here reads low. Negotiated Enterprise contracts aren't modelled. Plan-included credits aren't subtracted either, so usage inside your monthly allowance still shows as spend. Treat it as the value of what you used and check Cartesia's own billing before you invoice anyone. Budgets and anomaly alerts still work, since the trend is accurate.

![Costs page filtered to a Cartesia account, showing the per-capability breakdown and the estimated-amounts notice](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/cost-graph.png)

## Use the Speech tab

Open a voice to get a **Speech** tab for both synthesis and transcription. See [Speech testing](../features/speech-testing.md) for how the panel works.

- **Synthesize** runs **Sonic**: `sonic-3.6` (current flagship, 44 languages including Urdu and Odia), `sonic-3.5` (previous generation), `sonic-3` (older, pinned) or `sonic-latest` (a rolling beta that can change without notice, so not for production). The voice you opened is preselected. Audio comes back as 44.1 kHz 128 kbps mp3.
- **Transcribe** always uses **`ink-whisper`**, Cartesia's only transcription model. The model picker applies to synthesis only, and the language picker applies to transcription.

![Cartesia Speech tab on a voice, showing the Sonic model picker and a synthesized clip in the player](https://agent-assets.infrawrench.com/docs-screenshots/plugins/cartesia/speech-tab-sonic.png)

## Tips & limits

- **The Speech tab sets no character limit.** If your text is too long, you'll see Cartesia's own error.
- **Credit usage shows consumption only.** Cartesia reports what you spent over the last 30 days but not your plan limit, so there's no used versus limit gauge.
- **Preview audio is usually missing.** The voice detail page notes this where the preview would be.
- **The Sonic model list is fixed.** Cartesia doesn't publish a live model catalogue.
- **Shared library voices belong to Cartesia.** You can use them but not edit or delete them. Only voices your organization owns can be changed.
- **Write dictionary entries as `text = pronunciation`.** The create form takes one per line. The edit form is a single line, so separate entries with semicolons there. Saving replaces the whole list, and entries whose text you didn't change keep their case sensitivity.
- **Change an agent's voice in the Cartesia playground.** The voice is shown here but not editable. Language, name, description and noise suppression (0 to 100) are.
- **Voice credit charts need the admin key too.**
