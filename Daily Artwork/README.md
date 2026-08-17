# Daily Artwork

Picks a painting each day, researches it on the web, writes an illustrated feature about it, and
shows it in a full-bleed parallax web sheet. The home screen widget is the painting itself.

Same engine as [Daily Poem](../Daily%20Poem/README.md) — `pipeline.ts` was copied across untouched.
Everything subject-specific lives in `artworks.ts`.

## Files

| File | What it is |
|---|---|
| `main.ts` | Trigger routing + the sheet's routes |
| `pipeline.ts` | The engine: resumable stage machine, DB access, retries, AI + network calls |
| `artworks.ts` | The Recipe seam: picking, planning prompt, writing prompt |
| `views.ts` | HTML fragments for the sheet |
| `widget.ts` | Home screen widget (re-exported from `main.ts`) |
| `artwork.html` | The sheet's shell — CSS, masthead, date picker |
| `artworks.jsonl` | 730 paintings, one JSON object per line |

`secrets.json` is **not** in this repo — see [Setup](#setup).

## Why it's built this way

A full article is ~25 serial network round trips and 2–5 minutes of work; a background window is
~30 seconds shared across every project on the device. So the work is cut into **units**:

> One unit = at most one bridge round trip, followed by exactly one `Loom.db.update`.

Every run advances as many units as fit its deadline and persists after each one. Background runs
chip away at the article; opening the sheet finishes it in the foreground with a live progress bar.

### Stages

```
pick → plan → research → write → illustrate → done
```

- **pick** — `artworks.jsonl` is pre-permuted offline by `build-art-corpus.py` (artists
  round-robined, British works interleaved proportionally through the two years), so the pick is a
  plain modulo over the file by day index: deterministic for any date, no repeats for 730 days, and
  the same painting again after a delete. Every image in the corpus was fetched and *measured*
  during the build, so a shipped row is a guarantee that the picture exists and is big enough to
  fill a phone screen.
- **plan** — one AI call: headline, standfirst, 6 search queries, 7 sections. Zod-validated.
- **research** — all 6 queries in one `Loom.network.fetchAll` batch (Ollama web search).
- **write** — every outstanding section in one `Loom.ai.completeAll` batch; only failures retry.
- **illustrate** — every section's supporting image in one Wikipedia Action API request (up to 50
  titles at once — 0.19s, versus 3.8s for the per-section version).

Failure is a flag, not a stage, so a retry resumes from where it died rather than restarting at the
plan. Per-stage policies decide what an exhausted retry budget means: no plan means no article
(`fail`), but 4 of 6 searches is still an article (`skip`).

### Prompt hygiene

`Loom.ai.complete` concatenates gpt-oss's chain-of-thought into the reply, so every response is
`<thinking><answer>` with no separator — hence the `<<<JSON … JSON>>>` sentinels and a
balanced-brace scan that takes the *last* block. The writing prompt states the word count is a
ceiling rather than a target, and bans quotation marks around anything not verbatim in the sources:
given thin research the model otherwise pads with invented dates and manufactured period quotes.
Invented URLs are stripped downstream; invented facts can't be.

## The sheet

`Loom.ui.web({ template: 'artwork.html', bar: false })`. The painting runs edge to edge behind the
status bar and the page draws its own masthead. `bar: false` costs the Done button, so the page
carries both replacements: a masthead that scrolls to top, and a floating ↑ that appears at 400px.

| Route | Does |
|---|---|
| `GET /view` | Router. Today with no row starts building; a past day *offers* first, so a mis-scrolled date wheel doesn't quietly spend two minutes of tokens. |
| `GET /build` | Advances exactly one unit, returns a progress fragment that re-triggers itself. The finished article fragment has no `hx-trigger` — that's what ends the chain. |
| `POST /start` | Creates the row for a past day |
| `POST /like` | Toggles saved |
| `GET /liked` | The saved index |
| `POST /retry` | Clears the failure flag, keeps the position |
| `POST /rebuild` | Deletes the row and starts over |

Every route is wrapped in `guard()` — a throwing handler returns HTTP 200 with a red `<pre>` and no
`hx-trigger`, which would kill the self-chaining build loop permanently.

Masthead: **Today**, **Saved**, and a native date picker.

## The widget

The subject is a picture, so the picture *is* the widget — that's the main departure from Daily
Poem, where the image was a 92pt thumbnail beside the text. It reads the database directly rather
than using `ctx.data`, since the handler returns a different shape per trigger while the widget
always wants today's article.

Accent colours come from the corpus as `accentName`, already resolved offline to one of the 17
legal `w.*` colour names — an unrecognised name silently falls back to `.primary`.

Config: `widget: { refreshAfter: 3600, runOnTap: true }` — a tap opens the sheet.

## Storage

Per-script SQLite, table `articles`, one row per date. Liked articles are kept forever; the rest are
pruned after 7 days by the `backgroundProcessing` run. A `Today's artwork` notification fires once
per finished article, scheduled for 07:00 so a 03:00 build doesn't buzz at 03:00.

## Setup

1. **AI provider.** Loom → Settings → AI Providers → add a profile named exactly **`Ollama`** with
   model `gpt-oss:120b`. Matched literally by `PROVIDER` in `pipeline.ts`.
2. **API key.** In the Loom editor, create `secrets.json` in this project:

   ```json
   { "ollama": "your-ollama-api-key" }
   ```

   Keychain-backed and never synced — which is why it isn't in this repo. The same key authenticates
   the web search calls.
3. **Copy the corpus.** `artworks.jsonl` must sit beside `main.ts`. It's built offline by
   `build-art-corpus.py`, which isn't part of the project folder.
4. Run once manually — the first build takes a couple of minutes with a live progress bar.
5. Add the widget: long-press home screen → **Loom → Daily Artwork**.

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
Daily Artwork**. By the time you look at the widget the feature is usually finished; chain two or
three runs to guarantee a cold start completes.

**Reset a day** — *Run Daily Artwork with input*, Dictionary:

```
{ "reset": true }
{ "reset": true, "date": "2026-08-14" }
```

Clears the row and stops — deliberately no rebuild in the same run, so the next trigger shows you a
real cold start. Shortcuts sends dictionary values as text, so `true`, `1` and `yes` all work.

**URL scheme:**

```
loom://run?script=Daily%20Artwork&date=2026-08-14
```

`returnsResult: true`, so Shortcuts receives `{ date, stage, artwork, artist, progress, done,
failed }` — enough to notify yourself only when `done` is true.
