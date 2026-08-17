# Medication Reminder

Puts a medication reminder on the Lock Screen as a Live Activity and keeps it there until you
confirm you've taken it. Tapping **Taken** opens a small sheet with a streak, a 14-day grid and
a history list.

**Files:** `main.ts` — that's it. One file, no data, no API keys.

## How it works

The script has two jobs depending on how it was triggered.

**Started by a Shortcuts automation** (the normal case) it:

1. Checks the `doses` table for a row with today's local date — if you've already taken it, it
   returns `Already taken today` and does nothing, so a second automation firing can't nag you.
2. Asks `Loom.activity.list()` whether a card with key `meds` is already showing. That's the
   source of truth rather than KV, because you can swipe a card away and iOS ends one after 8
   hours — neither of which tells the script. This is what stops a re-trigger stacking a second
   card.
3. Starts the Live Activity: Lock Screen card, Dynamic Island compact/minimal/expanded, a green
   **Taken** button, `relevance: 100` so it sits above other Loom activities.
4. If the activity can't start (Live Activities off for Loom, or an unattended background run),
   it falls back to `Loom.notify.schedule()` and says so in the return value.

**Started by the button** — the Taken button is `runsScript: true`, so the tap comes back into
this same script as a `widget` trigger. That round trip through the app is unavoidable: ending a
Live Activity means running JS, and only the main app process can do that. The script keys off
`ctx.trigger === 'widget'` (this project has no widget export, so nothing else can produce a
widget run) and opens the confirmation sheet.

The tap deliberately doesn't confirm outright — a Live Activity button is easy to hit by accident,
and "did I already take it?" is the question you actually have at that moment. The activity only
ends inside `POST /taken`. Dismissing the sheet leaves the reminder up.

### The sheet

`Loom.ui.web` with inline HTML (no template file) and two routes:

| Route | Does |
|---|---|
| `GET /view` | Renders status, streak, 14-day dot grid, last 10 doses |
| `POST /taken` | Inserts the dose row, ends the Live Activity with a green tick (`dismiss: 10`), re-renders |

htmx does the swapping — the form posts and replaces `#app`.

### Dates

Day keys are built from local time (`dayKey()`), not `toISOString().slice(0,10)`. A dose taken at
11pm BST would land on the following day in UTC and break both the streak and "taken today".

The streak counts back from today, but a gap at *today alone* doesn't break it — you haven't
missed a day until the day is over.

## Storage

Per-script SQLite, table `doses`, one row per dose:

```
{ takenAt: '2026-08-17T20:11:04.000Z', day: '2026-08-17' }
```

`view()` selects the whole table unfiltered — one row a day means a decade is ~3,650 rows, which is
nothing for SQLite and cheaper than paginating.

## Permissions

- **Live Activities** — iOS asks the first time one starts. If you decline, the script falls back
  to a notification.
- **Notifications** — only used for the fallback path.

No network, no contacts, no health.

## Shortcuts setup

The script doesn't schedule itself — `triggers.schedule` doesn't exist in Loom. Use a Shortcuts
personal automation:

1. **Shortcuts → Automation → +  → Time of Day**
2. Pick your dose time, **Run Immediately**, turn *Notify When Run* off
3. Action: search **Loom → Run Script**, pick **Medication Reminder**
4. Optional: pass a dictionary input so the card names the drug —

   ```
   Dictionary { "med": "Sertraline 50mg" }
   ```

   It renders as the card's subtitle and in the fallback notification body.

Repeat the automation for each dose time. The "already taken today" check is per-day, not per-dose,
so multiple doses a day currently only track the first — see the `ponytail:` note in `view()`.

Siri also works out of the box: *"Run Medication Reminder"*.
