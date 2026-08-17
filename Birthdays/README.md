# Birthdays

Upcoming birthdays from your Contacts, soonest first — as a home screen widget in every size, and
as a web sheet with filter chips when you tap it.

**Files:** `main.ts`, `index.html` (the sheet's shell — styling and the htmx container).

## How it works

`Loom.contacts.search()` with no query walks the whole address book. That's the only way to ask
"who has a birthday soon" — any other query shape needs you to already know the names. It's a full
scan on the script thread, which is why this leans on background refresh rather than running
constantly.

For each contact with a birthday it computes:

- `days` — whole days until the next occurrence
- `on` — `"14 Mar"`
- `turning` — only when the contact card carries a year. Most don't, and guessing an age is worse
  than showing none.
- `at` — an ISO timestamp of the next occurrence, so the widget can render it with `w.date` and let
  WidgetKit tick the countdown down without re-running the script.

Contacts give month/day (and sometimes a year), never a timestamp, so `nextOccurrence()` constructs
the date rather than parsing one. A 29 Feb birthday lands on 1 Mar in common years — the same thing
iOS does in its own Birthdays calendar.

Sorted by `days`, returns the first 24.

## The widget

Five sizes, all from the same list:

| Size | Layout |
|---|---|
| small | Next birthday only — countdown, name, date/age |
| medium | Header + 2 rows |
| large | Header + 6 rows |
| extraLarge | Landscape iPad — two columns of 6 |
| extraLargePortrait | iOS 27 tall XL — 9 rows |

Two things worth knowing if you edit it:

- Row counts are measured, not guessed. A widget tree that overflows doesn't scroll or shrink — it
  centres and clips *both* ends, so the header is the first thing to vanish. 9 rows is the ceiling
  on a 17 Pro Max (~594pt tall, ~47pt a row).
- The countdown is `w.date(at, { style: 'days' })`, not text. It's the one value that goes wrong
  overnight, and WidgetKit re-renders a date node itself. `'relative'` was wrong here — it always
  shows two units ("2 mths, 22 days") and wraps the column.

Avatar circles are 32pt: two wide capitals ("AW", "GN") don't fit 26pt at bold caption2 and SwiftUI
truncates them to an ellipsis.

Config: `widget: { refreshAfter: 21600, runOnTap: true }` — six hours, and a tap opens the sheet.

## The sheet

Opens on a `manual` or `widget` trigger only. Without the `widget` case, a widget tap would open
Loom, scan contacts, and show nothing — which reads exactly like a tap that failed. On a background
run `Loom.ui.web` returns immediately without presenting, so the check stays safe either way.

One route, `/list?filter=…`, returning the whole block: hero card for the next birthday, then the
rest as cards. The filter chips (Next month / Next 3 months / Everyone) re-request the same
fragment, so the active-chip state comes free rather than needing its own swap.

Colours, emoji and initials are hashed from the name, so the same person keeps the same face
between runs. Zodiac sign comes from a cutoff table.

> **Note:** `routes` lives in the `Loom.ui.web()` call, never in the `loom()` config — the config is
> sliced out as source text and evaluated in an isolated context, so a function reference there
> silently becomes nothing.

## Permissions

`permissions: ['contacts']` — iOS prompts for Contacts access on the first run. Nothing else.

## Setup

1. Run it once manually so the widget has data.
2. Long-press the home screen → **Loom → Birthdays**, pick a size.
3. Background refresh is enabled in config (`triggers: { backgroundRefresh: true }`) — iOS decides
   when it actually fires; there's no schedule to set.

No Shortcuts setup needed, but *"Run Birthdays"* works via Siri if you want it. If the widget says
"No birthdays found", the contacts have no birthday fields — add one to a contact card and run the
script once.
