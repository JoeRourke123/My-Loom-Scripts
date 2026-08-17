// Everything that produces HTML lives here, so main.ts stays about behaviour.
//
// The `html` tag escapes every interpolation — that default IS the security control here, because
// poem text, headings and source titles all end up in a web view with no CSP. Only section bodies
// bypass it, via { __html }, and only after sanitiseMarkdown() has been through them.

import { html } from '@loom/core';
import { marked } from 'marked';
import type { Article, Section } from './store';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Formatted by hand rather than via toLocaleDateString: one fewer thing that can behave
// differently inside JavaScriptCore than it does anywhere else.
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
// The article

// The strand drives the accent colour, and it is the strongest thread tying this sheet to the
// widget — the same poem is the same colour on the home screen and in here. The template holds the
// actual values; this only picks which class to wear.
export function strandClass(subject: any): string {
  const strand = String((subject && subject.strand) || '').toLowerCase();
  return strand === 'american' || strand === 'european' ? `s-${strand}` : 's-british';
}

export function articleView(a: Article) {
  const poem = a.subject || ({} as any);
  const hero = a.sections.find((s) => s.imageUrl);
  const kicker = `${prettyDate(a.date)}${poem.strandLabel ? ` · ${poem.strandLabel}` : ''}`;

  return html`
    <article class="${strandClass(poem)}">
      <!-- Full-bleed hero with the headline set over it. Falls back to a strand gradient when
           nothing was illustrated, so the article never opens on a bare wall of text. The img
           removes itself on error rather than leaving a broken frame under the headline — these
           are hotlinked and uncached. -->
      <header class="hero ${hero ? '' : 'bare'}">
        ${hero ? html`<img src="${hero.imageUrl}" alt="" onerror="this.remove()">` : ''}
        <div class="scrim"></div>
        <div class="txt">
          <p class="kicker">${kicker}</p>
          <h1>${a.title}</h1>
        </div>
      </header>

      <div class="wrap">
    ${a.standfirst ? html`<p class="standfirst">${a.standfirst}</p>` : ''}

    <div class="poem">
      <p class="ptitle">${poem.title}</p>
      <p class="pauthor">${poem.author}</p>
      <pre>${poem.text}</pre>
      ${poem.source
        ? html`<a class="plink" href="${poem.source}">Read it at the source ↗</a>`
        : ''}
    </div>

    <!-- The hero is already the masthead image; repeating it as section one's figure is what
         makes a layout look automated. -->
    <div class="parts">
      ${a.sections.filter((s) => s.body).map((s) => sectionView(s, !!hero && s === hero))}
    </div>

    <!-- Every link in the prose is checked against this list before render, so publishing it is
         both the honest thing and a way to see when a piece is thinly sourced. -->
    ${a.sources.length
      ? html`<div class="sources">
          <h2>Sources</h2>
          <ol>${a.sources.map((s) => html`<li><a href="${s.url}">${s.title}</a></li>`)}</ol>
        </div>`
      : ''}

    <div class="likebar">
      ${likeButton(a.date, a.liked)}
    </div>
      </div>
    </article>
  `;
}

function sectionView(s: Section, isHero = false) {
  return html`
    <section class="part">
      ${s.imageUrl && !isHero
        ? html`<figure>
            <!-- Images are hotlinked from Wikimedia — Loom.files is UTF-8 only, so there is no
                 local cache — which means a file that moves or 404s at read time would otherwise
                 leave an "Image via Wikipedia" caption floating above nothing. This attribute is
                 in the static part of the template, not an interpolation, so it survives. -->
            <img src="${s.imageUrl}" alt="" loading="lazy"
                 onerror="this.closest('figure').remove()">
            <figcaption>Image via <a href="${s.imagePage}">Wikipedia</a></figcaption>
          </figure>`
        : ''}
      <h2>${s.heading}</h2>
      <!-- async: false pinned explicitly — marked returns a Promise when it is on, and a
           stringified Promise would render as visible garbage. -->
      <div class="body">${{ __html: String(marked.parse(s.body, { async: false })) }}</div>
    </section>
  `;
}

// Smallest possible swap — liking must not re-render (or re-scroll) the whole article.
export function likeButton(date: string, liked: boolean) {
  return html`
    <button id="like" class="like ${liked ? 'on' : ''}"
            hx-post="/like?date=${date}" hx-target="#like" hx-swap="outerHTML">
      ${liked ? '♥ Liked' : '♡ Like'}
    </button>
  `;
}

// ---------------------------------------------------------------------------------------------
// Not here yet
//
// There is no build to watch any more, so there is no progress bar and no self-replacing request
// chain. A day is either downloaded or it is not, and "not" has exactly two causes worth telling
// apart: the routine has not published it, or the phone could not reach GitHub.

export function pendingView(date: string) {
  return html`
    <div class="wrap">
      <div class="panel">
        <p class="kicker">${prettyDate(date)}</p>
        <h2>Not written yet</h2>
        <p>Each morning's feature is researched and written overnight. It usually lands before 5am.</p>
        <button hx-get="/view?date=${date}" hx-target="#app" hx-swap="innerHTML">Check again</button>
      </div>
    </div>
  `;
}

// One tap to retry rather than an automatic poll: the failure here is a network round trip, not a
// half-finished build that needs nursing to completion.
export function errorView(message: string, date: string) {
  return html`
    <div class="wrap">
      <div class="panel">
        <p class="kicker">${prettyDate(date)}</p>
        <h2>Could not reach it</h2>
        <p class="err">${message}</p>
        <button hx-get="/view?date=${date}" hx-target="#app" hx-swap="innerHTML">Try again</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------------------------
// Liked

export function likedView(rows: Article[]) {
  if (!rows.length) {
    return html`
      <div class="wrap">
        <div class="panel">
          <h2>Nothing kept yet</h2>
          <p>Articles you like are kept here for good. The rest clear after a week.</p>
        </div>
      </div>
    `;
  }
  return html`
    <div class="wrap">
      <p class="kicker" style="margin:26px 0 4px">${rows.length} kept</p>
      <ul class="liked">
        ${rows.map((r) => html`
          <li class="${strandClass(r.subject)}">
            <button hx-get="/view?date=${r.date}" hx-target="#app" hx-swap="innerHTML">
              <span class="ln">${r.subject.strandLabel || shortDate(r.date)}</span>
              <span class="lt">${r.title}</span>
              <span class="lm">${r.subject.author || ''} · ${shortDate(r.date)}</span>
            </button>
          </li>
        `)}
      </ul>
    </div>
  `;
}
