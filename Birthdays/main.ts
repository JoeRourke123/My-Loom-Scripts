import { loom, html } from '@loom/core';
import { w } from '@loom/widget';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TINTS = ['pink', 'purple', 'indigo', 'blue', 'teal', 'green', 'orange'];

export default loom(async (ctx) => {
  // No query walks the whole address book — the only way to ask "who has a birthday soon",
  // since you'd otherwise have to already know the names. It's a full scan on the script
  // thread, which is why this leans on background refresh rather than running constantly.
  const contacts = await Loom.contacts.search();
  const today = startOfDay(new Date());

  const upcoming = contacts
    .filter((c) => c.birthday)
    .map((c) => {
      const next = nextOccurrence(c.birthday, today);
      return {
        name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Unnamed',
        days: Math.round((next.getTime() - today.getTime()) / DAY),
        on: `${c.birthday.day} ${MONTHS[c.birthday.month - 1]}`,
        month: c.birthday.month,
        day: c.birthday.day,
        // Only when the contact card carries a year — most don't, and guessing an age is worse
        // than showing none.
        turning: c.birthday.year ? next.getFullYear() - c.birthday.year : null,
        // The widget renders this with w.date so the countdown keeps ticking between runs.
        at: next.toISOString(),
      };
    })
    .sort((a, b) => a.days - b.days);

  Loom.log.info('Scanned contacts for birthdays', {
    contacts: contacts.length,
    withBirthday: upcoming.length,
    next: upcoming.length ? `${upcoming[0].name} in ${upcoming[0].days}d` : 'none',
  });

  // Only worth a sheet when someone is actually looking at the screen — which a widget tap is,
  // since runOnTap opens Loom. Without 'widget' here the tap would open the app, scan, and show
  // nothing, which reads exactly like a tap that failed. On a background run Loom.ui.web returns
  // immediately without presenting, so this stays safe either way.
  //
  // routes goes here, never in the loom() config below — the config is evaluated in an isolated
  // context and a function reference there silently becomes nothing.
  if (ctx.trigger === 'manual' || ctx.trigger === 'widget') {
    await Loom.ui.web({
      template: 'index.html',
      title: 'Birthdays',
      routes: {
        '/list': (req) => listView(upcoming, req.query.filter || '30'),
      },
    });
  }

  return { list: upcoming.slice(0, 24), scanned: contacts.length };
}, {
  name: 'Birthdays',
  description: 'Upcoming birthdays from your contacts, soonest first.',
  permissions: ['contacts'],
  triggers: { backgroundRefresh: true },
  widget: { refreshAfter: 21600, runOnTap: true },
});

// MARK: - Widget

export const widget = (ctx) => {
  const list = (ctx.data && ctx.data.list) || [];
  if (!list.length) return empty();

  const next = list[0];

  return {
    small: w.vstack([
      next.days === 0
        ? w.text('TODAY', { font: 'caption2', bold: true, color: 'pink' })
        : w.date(next.at, { style: 'days', font: 'caption2', bold: true, color: 'pink' }),
      w.text(next.name, { font: 'headline', bold: true, lineLimit: 2 }),
      w.spacer(),
      w.text(sub(next), { font: 'caption', color: 'secondary', lineLimit: 1 }),
    ], { spacing: 2, padding: 12, alignment: 'leading' }),

    medium: w.vstack([header(list), rows(list, 2)], { spacing: 6, padding: 12, alignment: 'leading' }),

    large: w.vstack([header(list), rows(list, 6)], { spacing: 6, padding: 14, alignment: 'leading' }),

    // Landscape XL (iPad): wide and short, so the list runs in two columns rather than
    // stretching seven rows across the full width.
    extraLarge: w.vstack([
      header(list),
      w.hstack([
        rows(list.slice(0, 6), 6),
        rows(list.slice(6, 12), 6),
      ], { spacing: 20, alignment: 'top' }),
    ], { spacing: 8, padding: 16, alignment: 'leading' }),

    // iOS 27's tall XL — same width as large, so it takes more rows instead of more columns.
    // 10, not 16: a widget tree that overflows doesn't scroll or shrink, it centres and clips
    // both ends, so the header is the first thing to disappear. Measured against a 17 Pro Max,
    // where the family is ~594pt tall and a row costs ~47pt.
    extraLargePortrait: w.vstack([
      header(list),
      rows(list, 9),
    ], { spacing: 8, padding: 16, alignment: 'leading' }),
  };
};

function header(list) {
  const soon = list.filter((b) => b.days <= 30).length;
  return w.vstack([
    w.hstack([
      w.icon('birthday.cake.fill', { size: 15, color: 'pink' }),
      w.text('Birthdays', { font: 'headline', bold: true }),
      w.spacer(),
      w.text(soon ? `${soon} in 30 days` : 'none this month', { font: 'caption2', color: 'secondary' }),
    ], { spacing: 6 }),
    w.divider({ color: 'secondary' }),
  ], { spacing: 4, alignment: 'leading' });
}

function rows(list, count) {
  // The extra spacing is the point of the smaller type — shrinking the text alone just leaves
  // the same wall of rows with more air inside each one.
  return w.vstack(list.slice(0, count).map(row), { spacing: 11, alignment: 'leading' });
}

function row(b, i) {
  const today = b.days === 0;
  return w.hstack([
    // 32, not 26: two wide capitals ("AW", "GN") don't fit a 26pt circle at bold caption2 and
    // SwiftUI truncates them to an ellipsis. Costs no height — the two-line text stack beside
    // it is taller anyway.
    w.circle([w.text(initials(b.name), { font: 'caption2', bold: true, color: 'white' })], {
      color: today ? 'pink' : TINTS[i % TINTS.length],
      size: 32,
    }),
    w.vstack([
      w.text(b.name, { font: 'subheadline', bold: today, lineLimit: 1 }),
      w.text(sub(b), { font: 'caption2', color: 'secondary', lineLimit: 1 }),
    ], { spacing: 1, alignment: 'leading' }),
    w.spacer(),
    // w.date, not w.text: this is the one value that goes wrong overnight, and WidgetKit
    // re-renders a date node itself without needing the script to run again.
    //
    // 'days', not 'relative': relative always shows two units ("2 mths, 22 days"), which wraps
    // in this column. 'days' is the single-unit countdown and re-renders at each midnight.
    today
      ? w.text('Today', { font: 'caption2', bold: true, color: 'pink' })
      : w.date(b.at, { style: 'days', font: 'caption2', color: 'secondary' }),
  ], { spacing: 8 });
}

function empty() {
  return w.vstack([
    w.icon('birthday.cake', { size: 26, color: 'secondary' }),
    w.text('No birthdays found', { font: 'callout', bold: true }),
    w.text('Add a birthday to a contact card, then run Birthdays once.', {
      font: 'caption2', color: 'secondary', lineLimit: 3, alignment: 'leading',
    }),
  ], { spacing: 4, padding: 14, alignment: 'leading' });
}

// MARK: - Web sheet

// One route, one target: the chips re-request the same fragment with a different filter and
// swap the whole block, so the active chip state comes free rather than needing its own swap.
function listView(list, filter) {
  const horizon = filter === 'all' ? 400 : Number(filter);
  const shown = list.filter((b) => b.days <= horizon);

  return html`
    ${chips(filter)}
    ${shown.length ? hero(shown[0]) : ''}
    ${shown.length > 1 ? html`<div class="rest">${shown.slice(1).map(card)}</div>` : ''}
    ${shown.length ? '' : html`
      <div class="none">
        <div class="none-emoji">🗓️</div>
        <p>Nothing in the next ${horizon} days.</p>
        <p class="dim">Try a wider range above.</p>
      </div>`}
  `;
}

function chips(active) {
  const opts = [['30', 'Next month'], ['90', 'Next 3 months'], ['all', 'Everyone']];
  return html`<div class="chips">${opts.map(([value, label]) => html`
    <button class="chip ${value === active ? 'on' : ''}"
            hx-get="/list?filter=${value}" hx-target="#app">${label}</button>`)}</div>`;
}

function hero(b) {
  return html`
    <div class="hero" style="--h:${hue(b.name)}">
      <div class="cake">${emoji(b.name)}</div>
      <div class="countdown">${sleeps(b.days)}</div>
      <div class="hero-name">${b.name}</div>
      <div class="hero-sub">${b.on}${b.turning === null ? '' : ` · turning ${b.turning}`} · ${zodiac(b.month, b.day)}</div>
    </div>`;
}

function card(b) {
  return html`
    <div class="card">
      <div class="avatar" style="--h:${hue(b.name)}">${initials(b.name)}</div>
      <div class="who">
        <div class="name">${b.name}</div>
        <div class="dim">${b.on}${b.turning === null ? '' : ` · turning ${b.turning}`} · ${zodiac(b.month, b.day)}</div>
      </div>
      <div class="badge">${sleeps(b.days)}</div>
    </div>`;
}

// Deterministic per person, so the same face keeps the same colour and emoji between runs —
// random would reshuffle the whole list every time the sheet opened.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function hue(name) { return hash(name) % 360; }

function emoji(name) {
  const set = ['🎂', '🎈', '🎉', '🥳', '🎁', '🍰', '✨', '🎊'];
  return set[hash(name) % set.length];
}

function sleeps(days) {
  if (days === 0) return 'Today! 🎉';
  if (days === 1) return 'Tomorrow';
  if (days <= 14) return `${days} sleeps`;
  return when(days);
}

function zodiac(month, day) {
  const cutoffs = [20, 19, 21, 20, 21, 21, 23, 23, 23, 23, 22, 22];
  const signs = ['Capricorn ♑', 'Aquarius ♒', 'Pisces ♓', 'Aries ♈', 'Taurus ♉', 'Gemini ♊',
    'Cancer ♋', 'Leo ♌', 'Virgo ♍', 'Libra ♎', 'Scorpio ♏', 'Sagittarius ♐'];
  return day <= cutoffs[month - 1] ? signs[month - 1] : signs[month % 12];
}

// MARK: - Helpers

function sub(b) {
  return b.turning === null ? b.on : `${b.on} · turning ${b.turning}`;
}

function when(days) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `${days} days`;
  if (days < 14) return 'Next week';
  return `${Math.round(days / 7)} weeks`;
}

function initials(name) {
  const parts = name.split(' ').filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Contacts give month/day (and sometimes year), never a timestamp — so the next occurrence has
// to be constructed rather than parsed. A 29 Feb birthday lands on 1 Mar in common years, which
// is what iOS itself does in the Birthdays calendar.
function nextOccurrence(b, today) {
  const thisYear = new Date(today.getFullYear(), b.month - 1, b.day);
  return thisYear.getTime() >= today.getTime()
    ? thisYear
    : new Date(today.getFullYear() + 1, b.month - 1, b.day);
}
