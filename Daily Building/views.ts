// Everything that produces HTML lives here, so main.ts stays about behaviour.
//
// The `html` tag escapes every interpolation — that default IS the security control, because
// building names, architects and source titles all end up in a web view with no CSP. Only section
// bodies bypass it, via { __html }, and only after sanitiseMarkdown() has been through them.

import { html } from '@loom/core';
import { marked } from 'marked';
import type { Article, Section } from './store';

// Lived in buildings.ts, which the cloud routine made redundant. It is display formatting, so it
// belongs with the views; widget.ts imports it from here.
// -2560 reads as "2560 BC", which is what anyone writing about the Great Pyramid needs.
export function era(year: number): string {
  return year < 0 ? `${Math.abs(year)} BC` : String(year);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function prettyDate(date: string): string {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function shortDate(date: string): string {
  const [, m, d] = String(date).split('-').map(Number);
  return m && d ? `${d} ${MONTHS[m - 1].slice(0, 3)}` : date;
}

// ---------------------------------------------------------------------------------------------
// The timeline rule
//
// A linear scale is useless here: 65% of the corpus is post-1900, so everything worth comparing
// would pile into the last 5% of the bar. These stops each take an equal share of the width and
// the year is interpolated inside its own segment — an ordinal epoch scale, which is how
// architectural history is usually drawn anyway. -2600 to 2025 in ten legible steps.
const STOPS = [-2600, -500, 500, 1000, 1400, 1700, 1850, 1920, 1970, 2000, 2025];

export function scalePosition(year: number): number {
  const y = Math.max(STOPS[0], Math.min(STOPS[STOPS.length - 1], year));
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (y <= STOPS[i + 1]) {
      const within = (y - STOPS[i]) / (STOPS[i + 1] - STOPS[i]);
      return ((i + within) / (STOPS.length - 1)) * 100;
    }
  }
  return 100;
}

// Labels are positioned by the same scalePosition() the ticks and the marker use. Laying them out
// with space-between instead would put "1500" at 66% of the rule while its tick sits at 43% — a
// scale whose gradations lie about where they are is worse than no scale at all.
const LABELS = [-2600, 0, 1500, 1900, 2025];

function timeline(year: number) {
  const pos = scalePosition(year);
  return html`
    <div class="scale">
      <p class="cap">Position in the record</p>
      <div class="bar">
        ${STOPS.map((s, i) => html`<span class="tick ${i % 2 === 0 ? 'major' : ''}"
          style="left: ${(i / (STOPS.length - 1)) * 100}%"></span>`)}
        <span class="you" style="left: ${pos}%"></span>
      </div>
      <div class="lbl">
        ${LABELS.map((y) => html`<span style="left: ${scalePosition(y)}%">${era(y)}</span>`)}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------------------------
// The article

export function articleView(a: Article) {
  const b = a.subject || ({} as any);
  const named = b.architect && !/^(various|unknown)$/i.test(b.architect);

  return html`
    <p class="sheetno">Sheet ${a.date.replace(/-/g, '.')} — ${b.style || 'Building'}</p>
    <h1 class="headline">${a.title}</h1>
    ${a.standfirst ? html`<p class="standfirst">${a.standfirst}</p>` : ''}

    ${b.imageUrl
      ? html`<div class="plate">
          <i></i><i></i><i></i><i></i>
          <img src="${b.imageUrl}" alt="${b.name}"
               style="aspect-ratio: ${b.width || 4} / ${b.height || 3}"
               onerror="this.closest('.plate').remove()">
        </div>
        <p class="platecap">
          <span>${b.name}</span>
          ${b.source ? html`<a href="${b.source}">Wikipedia ↗</a>` : ''}
        </p>`
      : ''}

    <dl class="titleblock">
      <div><dt>Building</dt><dd>${b.name}</dd></div>
      <div><dt>Architect</dt><dd>${named ? b.architect : '— not recorded —'}</dd></div>
      <div><dt>Completed</dt><dd>${era(b.year)}</dd></div>
      <div><dt>Location</dt><dd>${b.location}</dd></div>
      <div><dt>Style</dt><dd>${b.style}</dd></div>
    </dl>

    ${timeline(b.year)}

    ${a.sections.filter((s) => s.body).map(sectionView)}

    <!-- Every link in the prose is checked against this list before render, so publishing it is
         both the honest thing and a way to see when a sheet is thinly sourced. -->
    ${a.sources.length
      ? html`<div class="sources">
          <h2>Sources</h2>
          <ol>${a.sources.map((s) => html`<li><a href="${s.url}">${s.title}</a></li>`)}</ol>
        </div>`
      : ''}

    <div class="actions">
      ${likeButton(a.date, a.liked)}
    </div>
  `;
}

function sectionView(s: Section, i: number) {
  return html`
    <section class="part">
      <p class="partno">A-${String(i + 1).padStart(2, '0')}</p>
      ${s.imageUrl
        ? html`<figure>
            <img src="${s.imageUrl}" alt="" loading="lazy"
                 onerror="this.closest('figure').remove()">
            <figcaption>via Wikipedia — <a href="${s.imagePage}">source</a></figcaption>
          </figure>`
        : ''}
      <h2>${s.heading}</h2>
      <div class="body">${{ __html: String(marked.parse(s.body, { async: false })) }}</div>
    </section>
  `;
}

export function likeButton(date: string, liked: boolean) {
  return html`
    <button id="like" class="${liked ? 'on' : ''}"
            hx-post="/like?date=${date}" hx-target="#like" hx-swap="outerHTML">
      ${liked ? '● Filed' : '○ File'}
    </button>
  `;
}

// ---------------------------------------------------------------------------------------------
// Build progress
//
// A self-replacing single-shot chain: exactly one request in flight, terminating by construction
// when /build returns the article fragment, which carries no hx-trigger. Deliberately NOT
// hx-trigger="every 1s" — the sheet's request loop is strictly serial FIFO and one batched unit
// can take 20 seconds, so an interval trigger would pile up stale requests behind it.

// There is no build to watch any more, so there is no progress bar and no self-replacing request
// chain. A day is either downloaded or it is not, and "not" has two causes worth telling apart:
// the routine has not published it, or the phone could not reach GitHub.

export function pendingView(date: string) {
  return html`
    <div class="panel">
      <h2>${prettyDate(date)}</h2>
      <p>Not drawn yet. Each morning's sheet is researched overnight and usually lands before 5am.</p>
      <button hx-get="/view?date=${date}" hx-target="#app" hx-swap="innerHTML">Check again</button>
    </div>
  `;
}

// One tap to retry rather than an automatic poll: the failure is a network round trip, not a
// half-finished build that needs nursing to completion.
export function errorView(message: string, date: string) {
  return html`
    <div class="panel">
      <h2>Could not reach it</h2>
      <p class="err">${message}</p>
      <button hx-get="/view?date=${date}" hx-target="#app" hx-swap="innerHTML">Try again</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------------------------
// The index (filed sheets)

export function likedView(rows: Article[]) {
  if (!rows.length) {
    return html`
      <div class="panel">
        <h2>Index empty</h2>
        <p>Sheets you file are kept here. The rest are cleared after a week.</p>
      </div>
    `;
  }
  return html`
    <p class="sheetno">Index — ${rows.length} filed</p>
    <ul class="index">
      ${rows.map((r) => html`
        <li>
          <button hx-get="/view?date=${r.date}" hx-target="#app" hx-swap="innerHTML">
            ${r.subject.imageUrl
              ? html`<img src="${r.subject.imageUrl}" alt="" loading="lazy" onerror="this.remove()">`
              : ''}
            <span>
              <span class="lt">${r.subject.name || r.title}</span>
              <span class="lm">${era(r.subject.year)} · ${r.subject.location || ''} · ${shortDate(r.date)}</span>
            </span>
          </button>
        </li>
      `)}
    </ul>
  `;
}
