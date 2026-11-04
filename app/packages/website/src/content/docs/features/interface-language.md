---
title: Interface language
description: Switch the app's interface language on each device, to English, Spanish, French, German, Japanese or Chinese, from Settings > General.
---

You can use the web and desktop apps in English, Spanish, French, German, Japanese or Chinese. Translations are still being added, so anything not translated yet shows in English.

Resource type names, field labels and descriptions from the built-in providers are translated too, so your inventory doesn't switch back to English. Names you chose yourself, like resources, accounts and dashboards, are never translated.

## Change the language

1. Open **Settings > General**.
2. Pick a language in the **Language** card.

The app reloads in the new language straight away.

![Settings > General page with the Language card visible, the dropdown open showing the six languages with their native names (Deutsch, English, español, français, 中文, 日本語)](https://agent-assets.infrawrench.com/docs-screenshots/features/interface-language/language-picker.png)

Good to know:

- The setting is **per device**, not per account. Your browser at work and the desktop app at home can use different languages.
- If you've never picked a language, the app uses your browser or system language if it's supported, and English otherwise.
- Dates, times and numbers follow your operating system's regional settings, whatever the interface language.

The mobile app isn't translated yet and shows English only.

## For self-hosters and contributors

Translations ship with the app, so no outside translation service is contacted while it runs. How to regenerate them after changing UI strings is described in the repository's `KNOWLEDGE.md` (UI translations section).
