# Daily Building

Picks a building each day, researches it on the web, and draws up a sheet about it: a photographic
plate, a title block, a timeline rule and seven sections of prose. The widget is a drawing title
block rather than a magazine card.

Same engine as [Daily Poem](../Daily%20Poem/README.md) and
[Daily Artwork](../Daily%20Artwork/README.md) — `pipeline.ts` copied across for the third time.
Everything subject-specific lives in `buildings.ts`.

## Files

| File | What it is |
|---|---|
| `main.ts` | Trigger routing + the sheet's routes |
| `pipeline.ts` | The engine: resumable stage machine, DB access, retries, AI + network calls |
| `buildings.ts` | The Recipe seam: picking, planning prompt, writing prompt, `era()` |
| `views.ts` | HTML fragments, including the timeline rule |
| `widget.ts` | Home screen widget (re-exported from `main.ts`) |
| `building.html` | The sheet's shell — CSS, masthead, date picker |
| `buildings.jsonl` | 459 buildings, one JSON object per line |

`secrets.json` is **not** in this repo — see [Setup](#setup).

## Why it's built this way

A full article is ~25 serial network round trips; a background window is ~30 seconds shared across
every project on the device. So the work is cut into **units**:

> One unit = at most one bridge round trip, followed by exactly one `Loom.db.update`.

Each run advances as many units as fit its deadline and persists after every one, so a build
survives being cut off mid-way. Background runs chip away at it; opening the sheet finishes it in
the foreground with live progress.

### Stages

```
pick → plan → research → write → illustrate → done
```

- **pick** — `buildings.jsonl` is sorted by year offline, dealt into seven era-strata and
  interleaved, so consecutive days jump across centuries instead of walking forward through time.
  The pick is a plain modulo over that pre-permuted file: deterministic for any date, and the same
  building again after a delete.
- **plan** — one AI call: headline, standfirst, 6 search queries, 7 sections. Zod-validated.
- **research** — all 6 queries in one `Loom.network.fetchAll` batch (Ollama web search).
- **write** — every outstanding section in one `Loom.ai.completeAll` batch; only failures retry.
- **illustrate** — every section's photograph in one Wikipedia Action API request (up to 50 titles).

Failure is a flag, not a stage, so a retry resumes where it died. Per-stage retry policies decide
what exhaustion means: no plan means no article (`fail`), 4 of 6 searches is still an article
(`skip`).

Years are stored as signed integers and rendered by `era()` — `-2560` reads as "2560 BC", which is
what anyone writing about the Great Pyramid needs. `EARLIEST`/`LATEST` in `buildings.ts` bracket the
shipped corpus and are asserted by a self-check.

### Prompt hygiene

`Loom.ai.complete` concatenates gpt-oss's chain-of-thought into the reply, so every response is
`<thinking><answer>` with no separator — hence the `<<<JSON … JSON>>>` sentinels and a
balanced-brace scan taking the *last* block. The writing prompt makes the word count a ceiling
rather than a target and forbids quotation marks around anything not verbatim in the sources;
otherwise thin research gets padded with invented dates and manufactured quotes.

## The sheet

`Loom.ui.web({ template: 'building.html', bar: false })`. The drawing sheet runs to the edges and
draws its own masthead. Losing the nav bar costs the Done button, so the page carries a masthead
that scrolls to top and a floating ↑ that appears at 300px.

**The timeline rule** is the sheet's signature and the one genuinely fiddly bit. A linear scale is
useless — 65% of the corpus is post-1900, so everything worth comparing piles into the last 5% of
the bar. Instead `scalePosition()` uses an ordinal epoch scale: eleven stops from -2600 to 2025,
each taking an equal share of the width, with the year interpolated inside its own segment. That's
how architectural history is normally drawn anyway. The labels are positioned with the same
function as the ticks and the marker — laying them out with `space-between` would put "1500" at 66%
of the rule while its tick sat at 43%, and a scale whose gradations lie about where they are is
worse than no scale.

| Route | Does |
|---|---|
| `GET /view` | Router. Today with no row starts building; a past day *offers* first, so a mis-scrolled date wheel doesn't quietly spend two minutes of tokens. |
| `GET /build` | Advances exactly one unit, returns a progress fragment that re-triggers itself. The finished article fragment has no `hx-trigger` — that ends the chain. |
| `POST /start` | Creates the row for a past day |
| `POST /like` | Toggles saved |
| `GET /liked` | The index |
| `POST /retry` | Clears the failure flag, keeps the position |
| `POST /rebuild` | Deletes the row and starts over |

Every route is wrapped in `guard()` — a throwing handler returns HTTP 200 with a red `<pre>` and no
`hx-trigger`, which would kill the self-chaining build loop permanently.

Masthead: **Today**, **Index**, and a native date picker.

## The widget

A drawing title block. One accent — drafting-pen blue — for every subject: architecture doesn't need
a palette per building the way a painting does, and the discipline of a single ink is the point. It
reads the database directly rather than using `ctx.data`, and shows a stage label ("Researching…",
"Drafting…", "Sourcing photographs…") while the sheet is still being built.

`w.image` is always scaled-to-fill with no fit option, but a frame with only a width keeps the
intrinsic aspect ratio. Architecture photographs are overwhelmingly landscape, so the usual case is
full width; the corpus ships measured dimensions to catch the tall exceptions — towers and spires.

Config: `widget: { refreshAfter: 3600, runOnTap: true }` — a tap opens the sheet.

## Storage

Per-script SQLite, table `articles`, one row per date. Liked sheets are kept forever; the rest are
pruned after 7 days by the `backgroundProcessing` run. A `Today's building` notification fires once
per finished sheet, scheduled for 07:00 so a 03:00 build doesn't buzz at 03:00.

## Setup

1. **AI provider.** Loom → Settings → AI Providers → add a profile named exactly **`Ollama`** with
   model `gpt-oss:120b`. Matched literally by `PROVIDER` in `pipeline.ts`.
2. **API key.** In the Loom editor, create `secrets.json` in this project:

   ```json
   { "ollama": "your-ollama-api-key" }
   ```

   Keychain-backed and never synced — which is why it isn't in this repo. The same key authenticates
   the web search calls.
3. **Copy the corpus.** `buildings.jsonl` must sit beside `main.ts`. It's built offline by
   `build-arch-corpus.py`, which isn't part of the project folder.
4. Run once manually — the first build takes a couple of minutes with a live progress bar.
5. Add the widget: long-press home screen → **Loom → Daily Building**.

**Permissions:** `network`, `notifications`.

**Background:** `triggers: { backgroundProcessing: true }` — fires while charging on wifi, takes a
20s slice and prunes old rows. iOS decides when.

## Shortcuts / Siri

| Trigger | Behaviour |
|---|---|
| Tap in Loom, or widget tap | Opens the sheet |
| Shortcuts / Siri | Headless — up to 20s of work, returns a status dictionary |
| URL scheme | Headless, and accepts a `date` |

**Nightly pre-build** — Shortcuts → Automation → Time of Day (say 05:00) → **Loom → Run Script →
Daily Building**. Chain two or three runs if you want a cold start finished in one go.

**Reset a day** — *Run Daily Building with input*, Dictionary:

```
{ "reset": true }
{ "reset": true, "date": "2026-08-14" }
```

Clears the row and stops; the rebuild happens on the *next* trigger, which is what a real background
run looks like. Shortcuts sends dictionary values as text, so `true`, `1` and `yes` all work.

**URL scheme:**

```
loom://run?script=Daily%20Building&date=2026-08-14
```

`returnsResult: true`, so Shortcuts receives `{ date, stage, building, progress, done, failed }`.
