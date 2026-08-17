# Daily Poem

Picks a poem each day, researches it on the web, writes an illustrated magazine feature about it,
and shows it in a web sheet. A home screen widget carries today's poem and the build progress.

This is the original of the three "daily research article" scripts — **Daily Artwork** and
**Daily Building** are the same engine with a different subject.

## Files

| File | What it is |
|---|---|
| `main.ts` | Trigger routing + the sheet's routes. Thin. |
| `pipeline.ts` | The engine: resumable stage machine, DB access, retries, AI + network calls. Knows nothing about poems. |
| `poems.ts` | The Recipe seam: picking, the planning prompt, the writing prompt. Knows nothing about the database. |
| `views.ts` | HTML fragments for the sheet. |
| `widget.ts` | Home screen widget (re-exported from `main.ts`). |
| `poem-article.html` | The sheet's shell — CSS, masthead, date picker. |
| `poems.jsonl` | 730 poems, one JSON object per line. |

`secrets.json` is **not** in this repo — see [Setup](#setup).

## Why it's built this way

A full article is ~25 serial network round trips and 2–5 minutes of work. A background window is
about 30 seconds, shared across every project on the device, with no mid-script cancellation. So
the work is cut into **units**:

> One unit = at most one bridge round trip, followed by exactly one `Loom.db.update`.

Every run advances as many units as fit its deadline and persists after each one. Overnight
background runs chip away at the article; opening the sheet finishes it in the foreground with a
live progress bar. There's no partial-persist window, so no transactions are needed.

### Stages

```
pick → plan → research → write → illustrate → done
```

- **pick** — `poems.jsonl` is pre-permuted offline (strands interleaved, authors round-robined), so
  the pick is a plain modulo over the file by day index. That buys determinism for any past or
  future date, no repeats for a full 730-day cycle, and the same poem again after a delete. All the
  balancing lives offline where there are real tools.
- **plan** — one AI call returns a headline, standfirst, 6 search queries and 7 sections
  (heading + angle + a Wikipedia image query), validated with Zod.
- **research** — all 6 queries in one `Loom.network.fetchAll` batch against Ollama's web search API.
  Sequential would cost the sum of latencies (~5.6s measured); batched it's roughly the slowest one.
- **write** — every outstanding section issued in one `Loom.ai.completeAll` batch. A `''` reply
  means that section failed and only that one is retried.
- **illustrate** — every section's image in **one** Wikipedia Action API request (up to 50 titles at
  once). The obvious per-section implementation was 14 round trips and 3.8s; this is 0.19s.

Failure is a flag (`failed`), never a stage — overwriting `stage` would lose the position a retry
needs, so a run that died on section 5 of 7 would restart from the plan. Each stage has its own
retry policy: no plan means no article (`fail`), but 4 of 6 searches is still an article (`skip`).

Concurrent runs are handled with a 150s lease carried in the `WHERE` clause of every persisting
write, so a unit that overran its lease discards its result rather than clobbering a newer one.

### Prompt hygiene

Two things the prompts fight, both observed live:

- `Loom.ai.complete` concatenates the model's chain-of-thought into the returned string, and
  gpt-oss always emits reasoning. So every reply is `<thinking><answer>` with no separator — hence
  the `<<<JSON … JSON>>>` sentinels and a balanced-brace scanner that takes the *last* block.
- Given a word target and thin sources, the model pads to length by inventing circumstantial detail
  and manufacturing period quotations. The prompt therefore states the word count is a ceiling, not
  a target, and bans quotation marks around anything not verbatim in the poem or sources.
  `stripUnknownLinks` catches invented URLs; nothing downstream can catch an invented fact.

## The sheet

`Loom.ui.web({ template: 'poem-article.html', bar: false })`. The page draws its own masthead, so
the nav bar would just be a second one — and since `bar: false` costs the Done button, the page
carries a sticky masthead that scrolls to top and a floating ↑ button so dismissing is always one
tap away.

| Route | Does |
|---|---|
| `GET /view` | Router. Today with no row starts building; a past day *offers* first, so a mis-scrolled date wheel doesn't quietly spend two minutes of tokens. |
| `GET /build` | Advances exactly one unit and returns a progress fragment that re-triggers itself. The article fragment has no `hx-trigger`, which is what ends the chain. |
| `POST /start` | Creates the row for a past day |
| `POST /like` | Toggles the heart |
| `GET /liked` | The liked index |
| `POST /retry` | Clears the failure flag, keeps the position |
| `POST /rebuild` | Deletes the row and starts over |

Every route is wrapped in `guard()`. A throwing handler comes back as HTTP 200 carrying a red
`<pre>` with no `hx-trigger`, which would kill the self-chaining build loop permanently — the guard
degrades a transient blip to "trying again…" instead.

The masthead has **Today**, **Liked**, and a native date picker for reading back through the week.

## The widget

Reads the database directly rather than using `ctx.data` — the handler returns a different shape
per trigger, while the widget always wants the same thing: today's article. Shows the build
progress while it's still being written, then the poem. Accent colour follows the strand
(british → indigo, american → orange, european → teal), matching the CSS accents in the sheet.

`extraLargePortrait` is the flagship: the iOS 27 iPhone XL family, 364×556 — large's width at
~1.45× its height, so it gets one more block of poem and the hero image, not twice everything.

Config: `widget: { refreshAfter: 3600, runOnTap: true }`. The widget only changes when the script
runs, so `refreshAfter` just keeps WidgetKit's timeline alive.

## Storage

Per-script SQLite, table `articles`, one row per date. Liked articles are kept forever; everything
else is pruned after 7 days by the `backgroundProcessing` run.

A notification (`Today's poem`) fires once per finished article, scheduled for 07:00 — a build that
finishes at 03:00 must not buzz at 03:00. `notifiedAt` is a column rather than a before/after
comparison so overlapping runs can't double-notify.

## Setup

1. **AI provider.** Loom → Settings → AI Providers → add a profile named exactly **`Ollama`** with
   model `gpt-oss:120b`. The name is matched literally by `PROVIDER` in `pipeline.ts:96`.
2. **API key.** In the Loom editor, create `secrets.json` in this project:

   ```json
   { "ollama": "your-ollama-api-key" }
   ```

   It's Keychain-backed and never synced, which is why it isn't in this repo. The same key is used
   for the web search API (`https://ollama.com/api/web_search`).
3. **Copy the corpus.** `poems.jsonl` must be beside `main.ts`. It's built offline by
   `build-corpus.py`, which isn't part of the project folder.
4. Run once manually. The first build takes a couple of minutes with a live progress bar.
5. Add the widget: long-press home screen → **Loom → Daily Poem**.

**Permissions:** `network`, `notifications`. iOS prompts for notifications on the first finished
article.

**Background:** `triggers: { backgroundProcessing: true }` — fires while charging on wifi, takes a
20s slice and prunes old rows. iOS decides when; there is no schedule to set.

## Shortcuts / Siri

The script routes on `ctx.trigger`, so it behaves differently depending on how you call it:

| Trigger | Behaviour |
|---|---|
| Tap in Loom, or widget tap | Opens the sheet |
| Shortcuts / Siri | Headless — advances up to 20s of work, returns a status dictionary |
| URL scheme | Headless, and accepts a `date` |

**Nightly pre-build** — Shortcuts → Automation → Time of Day (say 05:00) → **Loom → Run Script →
Daily Poem**. Runs headless, so by the time you open the widget the article is usually finished.
Chain two or three runs if you want a cold start finished in one go.

**Reset a day** (the testing hook) — Shortcuts action *Run Daily Poem with input*, input a
Dictionary:

```
{ "reset": true }
{ "reset": true, "date": "2026-08-14" }
```

That clears the row and stops. It deliberately does *not* rebuild in the same run — the point is to
watch a cold start happen on the next trigger, which is what a real background run looks like.
Shortcuts passes dictionary values through as text, so `isTruthy()` accepts `true`, `1` and `yes`.

**URL scheme:**

```
loom://run?script=Daily%20Poem&date=2026-08-14
```

Because `returnsResult: true`, Shortcuts gets the status dictionary back (`stage`, `title`,
`progress`, `done`, `failed`) — useful if you want to notify yourself only when `done` is true.
