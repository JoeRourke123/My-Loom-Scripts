# Daily Poem

A researched feature about one poem, written overnight and waiting on the phone each morning.
Widget on the home screen, full article in a web sheet.

The writing happens in a **Claude cloud routine**, not on the phone. This project downloads what
the routine published and renders it.

## Files

| File | What it is |
|---|---|
| `main.ts` | Trigger routing and the sheet's routes. ~60 lines. |
| `store.ts` | Fetch, sanitise, store, prune, notify. The only file that touches the network or the database. |
| `views.ts` | HTML fragments for the sheet. |
| `widget.ts` | Home screen widget (re-exported from `main.ts`). |
| `poem-article.html` | The sheet's shell — CSS, masthead, date picker. |

No `secrets.json`, no corpus, no API key. The phone does one GET.

## How it works

A routine runs at 03:00 and publishes `daily/poem/<date>.json` to this repo (see
[`routines/poem.md`](../routines/poem.md)). The phone fetches it from
`raw.githubusercontent.com` — no auth, no zip, CDN-cached.

The routine writes **a week ahead**, which is the whole reliability model: if a night is missed
there is no alert to notice, but the next night fills the hole and the phone never sees a gap.

`sync()` downloads today plus any of the next six days it does not already have. Opening the sheet
also fetches on demand, so the app works even if background refresh has not run.

### Why there is no build engine any more

This project used to carry a ~1,000-line resumable stage machine: leases, per-stage retry policies,
batched model calls, JSON sentinels, a balanced-brace scanner. None of it was about writing
articles — it existed because iOS gives background work about 30 seconds, shared across every
project on the device, and Loom's bridge calls are strictly serial.

A nightly cloud session has no such constraint. Deleting the engine also fixed the thing it caused:
sections were written in separate model calls that each saw the outline but not each other's prose,
so they repeated each other. One coherent generation does not have that problem.

### Sanitising is on the phone, deliberately

Section bodies render through `{ __html }` into a web sheet with **no CSP**. They are model output
derived from arbitrary web pages, and they now arrive over the network — so `sanitiseMarkdown()`
and `stripUnknownLinks()` in `store.ts` matter *more* than they did, not less.

`stripUnknownLinks()` checks every link against the article's own `sources[]`, which is why that
list ships in the payload and is rendered at the foot of the article. The validator in the repo is
a second line of defence, not a replacement — it runs somewhere we do not control, at a different
time.

## Storage

Per-script SQLite, table `daily`, one row per date. Liked articles are kept forever; the rest are
pruned after 7 days. Future days are never pruned — they have not been read yet.

A `Today's poem` notification fires once per article, scheduled for 07:00 so a 03:00 download does
not buzz at 03:00.

> The table is `daily`, not the old `articles`. ScriptDB freezes column types on first insert, so
> the retired `stage`/`cursor`/`lease` columns would have fought the new row shape. A new table
> skipped the migration entirely; the old one is inert and can be dropped from the Database tab.

## Setup

1. Copy this folder into `iCloud Drive/Loom/`.
2. Run it once — it downloads the next week.
3. Add the widget: long-press home screen → **Loom → Daily Poem**.

**Permissions:** `network`, `notifications`.

**Background:** `triggers: { backgroundRefresh: true }`. One ~30 KB GET fits a refresh window, so
unlike the old build it does not wait for charging on wifi. iOS decides when.

## Shortcuts / Siri

| Trigger | Behaviour |
|---|---|
| Tap in Loom, or widget tap | Opens the sheet |
| Shortcuts / Siri / URL scheme | Syncs and returns `{ fetched, missing }` |

`returnsResult: true`, so a Shortcut can act on which days landed.

## Changing what it writes

Edit [`routines/brief.md`](../routines/brief.md) (process and house rules) or
[`routines/poem.md`](../routines/poem.md) (voice, and what makes a poem worth a thousand words).
The routine reads them from the repo at run time, so a `git push` is the whole deployment.
