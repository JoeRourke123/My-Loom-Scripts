# My-Loom-Scripts

A collection of the scripts I use with [Loom](https://github.com/joerourke/loom) — iOS automation,
scripts as tools.

Each folder is a Loom project: drop it into `iCloud Drive/Loom/` and it appears in the app. The
folder name is the display name and must match `config.name` in `main.ts`.

| Project | What it does |
|---|---|
| [Medication Reminder](Medication%20Reminder/) | Live Activity on the Lock Screen until you confirm the dose. Streak + history sheet. |
| [Birthdays](Birthdays/) | Upcoming birthdays from Contacts — widget in every size, plus a filterable sheet. |
| [Daily Artwork](Daily%20Artwork/) | Researches and writes an illustrated feature about a painting each day. |
| [Daily Building](Daily%20Building/) | Same, for a building — with a photographic plate and a timeline rule. |
| [Daily Poem](Daily%20Poem/) | Same, for a poem. The original of the three. |

Each project has its own README covering how it works, permissions, and the Shortcuts/Siri setup.

## Note on secrets

`secrets.json` is deliberately **not** in this repo. It's Keychain-backed on device and never
synced. The three `Daily *` projects need one containing an Ollama API key:

```json
{ "ollama": "your-ollama-api-key" }
```

Create it in the Loom editor, not here.
