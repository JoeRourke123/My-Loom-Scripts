// Everything that produces HTML lives here, so main.ts stays about behaviour.
//
// The `html` tag escapes every interpolation — that default IS the security control, because
// titles, artist names and source titles all end up in a web view with no CSP. Only section bodies
// bypass it, via { __html }, and only after sanitiseMarkdown() has been through them.

import { html } from '@loom/core';
import { marked } from 'marked';
import type { Article, Section } from './store';

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
// The article

export function articleView(a: Article) {
  const art = a.subject || ({} as any);
  const accent = /^#[0-9a-fA-F]{6}$/.test(String(art.accent || '')) ? String(art.accent) : '#6a6f7a';
  const meta = [art.year, art.movementLabel].filter(Boolean).join(' · ');

  return html`
    <article class="feature" style="--accent: ${accent}">
      <!-- The backdrop must live INSIDE the swapped fragment: #app is replaced wholesale on every
           route, so a backdrop in the static template would never change with the article. A
           position: fixed element inside swapped content is still viewport-fixed. -->
      <div class="bg">
        ${art.imageUrl ? html`<img src="${art.imageUrl}" alt="" onerror="this.remove()">` : ''}
      </div>

      <div class="deck">
        <header class="open">
          <p class="kicker">${prettyDate(a.date)}${meta ? ` · ${meta}` : ''}</p>
          <h1>${a.title}</h1>
          <p class="by">${art.title} — ${art.author}</p>
          <p class="scrolltip">Scroll ↓</p>
        </header>

        ${a.standfirst ? html`<div class="card lede">${a.standfirst}</div>` : ''}

        <!-- The backdrop is cover-cropped, so this is the only place the work is seen whole. -->
        ${art.imageUrl
          ? html`<div class="card plate">
              <img src="${art.imageUrl}" alt="${art.title}"
                   style="aspect-ratio: ${art.width || 4} / ${art.height || 3}">
              <p class="cap">
                <span>${art.title}${art.year ? `, ${art.year}` : ''} — ${art.author}</span>
                ${art.source ? html`<a href="${art.source}">WikiArt ↗</a>` : ''}
              </p>
            </div>`
          : ''}

        ${a.sections.filter((s) => s.body).map(sectionView)}

        <!-- Every link in the prose is checked against this list before render, so publishing it
             is both the honest thing and a way to see when a piece is thinly sourced. -->
        ${a.sources.length
          ? html`<div class="sources">
              <h2>Sources</h2>
              <ol>${a.sources.map((s) => html`<li><a href="${s.url}">${s.title}</a></li>`)}</ol>
            </div>`
          : ''}

        <div class="actions">
          ${likeButton(a.date, a.liked)}
        </div>
      </div>
    </article>
  `;
}

function sectionView(s: Section, i: number) {
  return html`
    <section class="card">
      <p class="num">${String(i + 1).padStart(2, '0')}</p>
      ${s.imageUrl
        ? html`<figure>
            <img src="${s.imageUrl}" alt="" loading="lazy"
                 onerror="this.closest('figure').remove()">
            <figcaption>Image via <a href="${s.imagePage}">Wikipedia</a></figcaption>
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
      ${liked ? '♥ Saved' : '♡ Save'}
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
      <p>Not written yet. Each morning's feature is researched overnight and usually lands before 5am.</p>
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
// Saved

export function likedView(rows: Article[]) {
  if (!rows.length) {
    return html`
      <div class="panel">
        <h2>Nothing saved yet</h2>
        <p>Features you save are kept here. The rest are cleared after a week.</p>
      </div>
    `;
  }
  return html`
    <div class="panel" style="padding: 26px 26px 14px">
      <h2>${rows.length} saved</h2>
    </div>
    <ul class="liked">
      ${rows.map((r) => html`
        <li>
          <button hx-get="/view?date=${r.date}" hx-target="#app" hx-swap="innerHTML">
            ${r.subject.imageUrl
              ? html`<img src="${r.subject.imageUrl}" alt="" loading="lazy" onerror="this.remove()">`
              : ''}
            <span>
              <span class="lt">${r.title}</span>
              <span class="lm">${r.subject.author || ''} · ${shortDate(r.date)}</span>
            </span>
          </button>
        </li>
      `)}
    </ul>
  `;
}
