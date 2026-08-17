import { loom, html } from '@loom/core';
import { w } from '@loom/widget';

const KEY = 'meds';
const DAYS = 14;

export default loom(async (ctx) => {
  Loom.log.info('Medication Reminder run', { trigger: ctx.trigger, input: ctx.input });

  // The Taken button is runsScript, so its tap arrives back here as a widget run. That round-trip
  // through the app is unavoidable: ending a Live Activity means running JS, and only the main app
  // process can.
  //
  // Keyed on the trigger, not on ctx.input.button: this project has no widget export, so the only
  // thing that can produce a 'widget' run is a tap on the card's own button. Requiring the button
  // key as well would make the confirmation fail silently if that key ever didn't survive the trip.
  if (ctx.trigger === 'widget' || ctx.input?.button === 'taken') return confirmSheet();

  const med = ctx.input?.med ? String(ctx.input.med) : '';

  // A second automation firing after you've already taken today's dose shouldn't nag.
  if (await takenToday()) return 'Already taken today';

  // list() is the source of truth, not KV — the user can swipe the card away and iOS ends one after
  // 8 hours, neither of which tells the script. Asking iOS stops a re-trigger stacking a second card.
  const running = await Loom.activity.list();
  if (running.some((a) => a.key === KEY)) return 'Reminder already showing';

  const key = await Loom.activity.start({
    key: KEY,
    // Every row is an hstack ending in a spacer. A vstack sizes to its widest child and the Lock
    // Screen then centres that block, so without the spacers the whole card floats in the middle
    // with a wide gap either side — `alignment: 'leading'` only aligns the children to each other.
    content: w.vstack([
      w.hstack([
        w.label({ icon: 'pills.fill', title: 'Take your medication', subtitle: med, color: 'pink' }),
        w.spacer(),
      ]),
      w.hstack([
        w.button({ label: 'Taken', kvKey: 'taken', runsScript: true, color: 'green', font: 'caption' }),
        w.spacer(),
      ]),
      // No `background` on the root — it becomes the whole card's tint, and pink on pink is invisible.
    ], { spacing: 10, alignment: 'leading' }),

    compactLeading: w.icon('pills.fill', { color: 'pink' }),
    compactTrailing: w.text('Due'),
    minimal: w.icon('pills.fill', { color: 'pink' }),

    expanded: {
      leading: w.label({ icon: 'pills.fill', title: 'Medication', color: 'pink' }),
      trailing: w.text('Due', { font: 'headline' }),
      bottom: w.button({ label: 'Taken', kvKey: 'taken', runsScript: true, color: 'green', font: 'caption' }),
    },

    // No staleAfter: the card says one thing and it stays true until confirmed, so greying it out
    // after a while would be a lie. relevance keeps it above other Loom activities in the Island.
    relevance: 100,
  });

  if (!key) {
    // An unattended background refresh can't start an activity, and neither can a run when Live
    // Activities are switched off for Loom. A notification is the surface that still works.
    await Loom.notify.schedule({
      title: 'Medication',
      body: med ? `Time to take ${med}.` : 'Time to take your medication.',
    });
    return 'Live Activity unavailable — sent a notification instead';
  }

  return 'Reminder on the Lock Screen';
}, {
  name: 'Medication Reminder',
  description: 'Puts a medication reminder on the Lock Screen until you confirm you have taken it.',
  returnsResult: true,
});

// MARK: - Confirmation sheet

// The tap opens this rather than confirming outright: a Live Activity button is easy to hit by
// accident, and "did I already take it?" is the question you actually have at that moment. The
// activity only ends inside POST /taken — dismissing the sheet leaves the reminder up.
async function confirmSheet() {
  let confirmed = false;

  await Loom.ui.web({
    title: 'Medication',
    html: PAGE,
    routes: {
      'GET /view': view,
      'POST /taken': async () => {
        if (!(await takenToday())) {
          await Loom.db.table('doses').insert({ takenAt: new Date().toISOString(), day: dayKey(new Date()) });
        }
        await Loom.activity.end(KEY, {
          content: w.vstack([
            w.label({ icon: 'checkmark.circle.fill', title: 'Medication taken', color: 'green' }),
          ], { padding: 12 }),
          dismiss: 10, // left up briefly so the confirmation is visible, then gone
        });
        confirmed = true;
        return view();
      },
    },
  });

  return confirmed ? 'Taken' : 'Not confirmed — reminder still showing';
}

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, system-ui; margin: 0; padding: 20px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; opacity: .5; margin: 28px 0 10px; }
  .status { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  .sub { opacity: .6; font-size: 15px; margin: 0; }
  .confirm { width: 100%; padding: 16px; margin-top: 20px; font-size: 18px; font-weight: 600;
             color: #fff; background: #34c759; border: 0; border-radius: 14px; }
  .confirm:active { opacity: .7; }
  .grid { display: flex; gap: 6px; }
  .day { flex: 1; text-align: center; font-size: 11px; opacity: .5; }
  .dot { height: 30px; border-radius: 8px; margin-bottom: 4px; background: currentColor; opacity: .12; }
  .dot.on { background: #34c759; opacity: 1; }
  .streak { font-size: 34px; font-weight: 700; margin: 0; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 11px 0; border-bottom: 1px solid rgba(128,128,128,.25); font-size: 15px; }
  li span { float: right; opacity: .5; }
</style>
<div id="app" hx-get="/view" hx-trigger="load"></div>`;

async function view() {
  // Whole table, unfiltered: one row per day means a decade of use is ~3,650 rows, which is nothing
  // for SQLite and cheaper than paginating. ponytail: revisit if this ever becomes multi-dose-a-day.
  const rows = await Loom.db.table('doses').select();
  const days = new Set(rows.map((r) => String(r.day)));
  const today = dayKey(new Date());
  const done = days.has(today);

  const recent = rows
    .filter((r) => r.takenAt)
    .sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)))
    .slice(0, 10);

  return html`
    <p class="status">${done ? 'Taken today' : 'Not taken yet today'}</p>
    <p class="sub">${done ? `Logged at ${time(recent[0]?.takenAt)}` : 'Confirm below once you have taken it.'}</p>

    ${done ? '' : html`<form hx-post="/taken" hx-target="#app">
      <button class="confirm" type="submit">I've taken it</button>
    </form>`}

    <h2>Streak</h2>
    <p class="streak">${streak(days)} ${streak(days) === 1 ? 'day' : 'days'}</p>

    <h2>Last ${DAYS} days</h2>
    <div class="grid">${lastDays(DAYS).map((d) => html`<div class="day">
      <div class="dot ${days.has(dayKey(d)) ? 'on' : ''}"></div>${'SMTWTFS'[d.getDay()]}
    </div>`)}</div>

    <h2>History</h2>
    <ul>${recent.length
      ? recent.map((r) => html`<li>${dateLabel(r.takenAt)}<span>${time(r.takenAt)}</span></li>`)
      : html`<li>Nothing logged yet.</li>`}</ul>
  `;
}

// MARK: - Dates

// Local-time day key. Not toISOString().slice(0,10) — that's UTC, so a dose taken at 11pm in
// summer would land on the following day and break both the streak and "taken today".
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d);
  }
  return out;
}

// Counts back from today, but a gap at today alone doesn't break it — the streak is still alive
// until you've missed a whole day.
function streak(days) {
  let count = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d))) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

function time(iso) {
  return iso ? new Date(String(iso)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function dateLabel(iso) {
  const d = new Date(String(iso));
  if (dayKey(d) === dayKey(new Date())) return 'Today';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

async function takenToday() {
  const rows = await Loom.db.table('doses').select({ day: dayKey(new Date()) });
  return rows.length > 0;
}
