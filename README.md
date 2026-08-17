# My-Loom-Scripts

A collection of the scripts I use with [Loom](https://github.com/JoeRourke123/Loom) — iOS
automation, scripts as tools.

Each `Daily *` / titled folder is a Loom project: drop it into `iCloud Drive/Loom/` and it appears
in the app. The folder name is the display name and must match `config.name` in `main.ts`.

| Project | What it does |
|---|---|
| [Medication Reminder](Medication%20Reminder/) | Live Activity on the Lock Screen until you confirm the dose. Streak + history sheet. |
| [Birthdays](Birthdays/) | Upcoming birthdays from Contacts — widget in every size, plus a filterable sheet. |
| [Daily Artwork](Daily%20Artwork/) | A researched feature about a painting, published overnight. |
| [Daily Building](Daily%20Building/) | The same for a building — photographic plate and a timeline rule. |
| [Daily Poem](Daily%20Poem/) | The same for a poem. The original of the three. |

## The daily publications

The three `Daily *` projects are written by **Claude cloud routines**, not by the phone. Each night
a routine picks the day's subject, researches it on the web, writes the feature, validates it and
commits the result here. The phone downloads finished JSON and renders it.

```
routines/brief.md          process, grounding rules, house style — shared
routines/{poem,artwork,building}.md   voice and editorial angle per publication
tools/pick.mjs             deterministic subject for a (kind, date)
tools/validate.mjs         the gate: schema, sourcing, image hosts, safety
tools/corpora/*.jsonl      730 poems, 730 paintings, 459 buildings
daily/<kind>/<date>.json   what gets published
```

**Editing a brief is the whole deployment.** The routines read `routines/*.md` from this repo at
run time, so a `git push` changes what tomorrow's feature looks like. No routine update needed.

### Why the subject is not the model's to choose

`pick.mjs` maps a date to a subject by plain modulo over a pre-permuted corpus. That gives
determinism for any date, no repeats for a full cycle, and the same subject again on a rebuild.
`--stub` writes the article skeleton with the subject already filled in, and `validate.mjs`
re-derives it and compares — so a run that "improves" a poem's text fails rather than publishing.

### What the validator refuses to publish

- a body link that is not in the article's own `sources[]` — hallucinated citations fail the build
- an image on any host outside wikimedia/wikipedia/wikiart — these are hotlinked into a web view
- a `<script>`, a `javascript:` URL, an inline event handler
- a subject that does not match `pick.mjs`
- a headline that is just the subject's own title, a section headed "Background", fewer than five
  or more than eight sections, a section under 200 characters
- a handful of filler phrases (*delve*, *tapestry*, *stands as a testament*…), which are banned as
  symptoms — where one appears the sentence around it is usually padding

The agent runs the validator itself, reads the failures and fixes them before committing.

### A week ahead, on purpose

Each run publishes today plus any missing day in the next six. A routine fire that is skipped
before a session exists leaves no run record — there is nothing to alert on. Writing ahead means a
missed night self-heals the next night and the phone never sees a gap. The repo is its own monitor:
if `daily/poem/` has no file for tomorrow, something is wrong.

## Note on secrets

`secrets.json` is deliberately not in this repo — it is Keychain-backed on device and never synced.
Nothing here needs one any more: the daily projects used to hold an Ollama key for on-device
generation, and that moved to the cloud routines with the rest of the writing.
