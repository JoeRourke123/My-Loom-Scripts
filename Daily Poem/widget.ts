// The home screen widget.
//
// NOTE: this is an ordinary sibling module that main.ts re-exports from — there is no magic
// `widget.ts` convention in Loom. The export Loom looks for is the name `widget` on main.ts.
//
// It reads the database directly rather than using ctx.data. The handler returns a different shape
// depending on which trigger ran (and nothing useful at all for a share-sheet run), whereas the
// widget always wants the same thing: today's article. One read, no coupling to the caller.
//
// extraLargePortrait is the flagship: it is the iPhone XL family (iOS 27), 364×556 — large's
// width at ~1.45× its height. Not 2× large, so it gets one more block of poem and the hero image,
// not twice everything.

import { w } from '@loom/widget';
import { progress, read, today } from './pipeline';
import { recipe } from './poems';
import type { Article, Status } from './pipeline';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The one thread tying this card to the sheet: today's poem is the same colour on the home screen
// as it is inside. w.* colours are a fixed vocabulary, so these are the nearest names to the CSS
// accents in poem-article.html — indigo/orange/teal.
const STRAND_COLOR: Record<string, string> = {
  british: 'indigo',
  american: 'orange',
  european: 'teal',
};

function accent(article: Article | null): string {
  const strand = String((article && article.subject && article.subject.strand) || '').toLowerCase();
  return STRAND_COLOR[strand] || 'indigo';
}

function stamp(date: string): string {
  const [, m, d] = String(date).split('-').map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]}` : String(date);
}

// One w.text with embedded newlines rather than one node per line: SwiftUI's Text renders \n
// natively, and lineLimit then caps the whole block so a long line wrapping cannot push the rest
// of the card out of frame.
function opening(article: Article | null, count: number): string {
  const text = String((article && article.subject && article.subject.text) || '');
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, count).join('\n');
}

function heroImage(article: Article | null): string {
  if (!article) return '';
  const withImage = article.sections.filter((s) => s.imageUrl);
  return withImage.length ? withImage[0].imageUrl : '';
}

// --- shared pieces -----------------------------------------------------------------------------

// The same DAILY POEM wordmark the sheet's masthead wears, in the same order: wordmark, then
// date and strand, then the heart.
function header(article: Article | null, date: string, compact = false) {
  const tint = accent(article);
  const kids: any[] = [
    w.text('DAILY', { font: 'caption', bold: true, color: 'secondary' }),
    w.text('POEM', { font: 'caption', bold: true, color: tint }),
  ];
  if (!compact) {
    kids.push(w.spacer());
    kids.push(w.text(stamp(date), { font: 'caption', color: 'secondary' }));
    if (article && article.liked) kids.push(w.icon('heart.fill', { size: 11, color: tint }));
  } else {
    kids.push(w.spacer());
    if (article && article.liked) kids.push(w.icon('heart.fill', { size: 10, color: tint }));
  }
  return w.hstack(kids, { spacing: 4 });
}

// Strand label as its own line, letterspaced-caps in the accent — the widget's echo of the
// sheet's .kicker.
function kicker(article: Article | null, date: string) {
  const label = (article && article.subject && article.subject.strandLabel) || stamp(date);
  return w.text(String(label).toUpperCase(), {
    font: 'caption', bold: true, color: accent(article), alignment: 'leading', lineLimit: 1,
  });
}

function byline(article: Article | null, font: string) {
  const poem = (article && article.subject) || ({} as any);
  return w.vstack([
    w.text(poem.title || 'Choosing a poem…', { font, bold: true, alignment: 'leading', lineLimit: 2 }),
    w.text(String(poem.author || '').toUpperCase(), {
      font: 'caption', color: accent(article), alignment: 'leading', lineLimit: 1,
    }),
  ], { alignment: 'leading', spacing: 3 });
}

// The one place the four states are decided, so every size tells the same story.
function footer(article: Article | null, status: Status | null, deckLines: number) {
  if (article && article.failed) {
    return w.label({ icon: 'exclamationmark.triangle.fill', title: 'Stopped', subtitle: 'Tap to try again', color: 'red' });
  }
  if (article && article.stage === 'done') {
    const stack = [
      w.text(article.title, { font: 'subheadline', bold: true, alignment: 'leading', lineLimit: 2 }),
    ];
    // deckLines: 0 drops the standfirst entirely — medium is 364×170 and the headline plus even
    // two lines of deck overflows it once the header and byline have taken their share.
    if (deckLines > 0) {
      stack.push(w.text(article.standfirst, {
        font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: deckLines,
      }));
    }
    return w.vstack(stack, { alignment: 'leading', spacing: 3 });
  }
  const done = status ? status.unitsDone : 0;
  const total = status && status.unitsTotal ? status.unitsTotal : 16;
  return w.vstack([
    w.progressBar({ value: done, total, color: accent(article), label: 'Writing' }),
    w.text(status ? status.nextLabel : 'Waiting to start…', {
      font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 2,
    }),
  ], { alignment: 'leading', spacing: 4 });
}

const CARD = { alignment: 'leading', spacing: 9, padding: 4 };

// --- the export ---------------------------------------------------------------------------------

export const widget = async () => {
  const date = today();
  const article = await read(recipe, date);
  const status = await progress(recipe, date);
  const hero = heroImage(article);

  return {
    small: w.vstack([
      header(article, date),
      w.spacer(),
      byline(article, 'headline'),
      w.spacer(),
      article && article.stage === 'done'
        ? w.text(article.title, { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 3 })
        : w.text(status ? `${status.unitsDone}/${status.unitsTotal}` : '…',
                 { font: 'caption', bold: true, color: accent(article) }),
    ], { ...CARD, spacing: 4 }),

    medium: w.hstack([
      w.vstack([
        header(article, date),
        byline(article, 'headline'),
        w.spacer(),
        footer(article, status, 0),
      ], { ...CARD, spacing: 7 }),
      hero ? w.image(hero, { width: 92, height: 92, cornerRadius: 12 }) : w.spacer({ minLength: 0 }),
    ], { spacing: 10 }),

    // 4×4. No hero — at this height the poem is worth more than the picture.
    large: w.vstack([
      header(article, date),
      kicker(article, date),
      byline(article, 'title3'),
      w.text(opening(article, 5), { font: 'footnote', alignment: 'leading', lineLimit: 5 }),
      w.spacer(),
      w.divider(),
      footer(article, status, 3),
    ], CARD),

    // The iPhone XL size, and the one this widget is designed for. 174pt taller than large, which
    // buys the hero image and about six more lines of poem — not a second copy of everything.
    //
    // The hero sits beside the byline at 1:1 rather than as a full-width band. w.image is always
    // .scaledToFill() with no fit option, so a 364×132 band on a typical 2:3 poet portrait crops
    // to the middle quarter — chin and collar, no face. A square frame keeps the middle two
    // thirds, which is where the face actually is.
    extraLargePortrait: w.vstack([
      header(article, date),
      hero
        ? w.hstack([
            w.image(hero, { width: 118, height: 118, cornerRadius: 14 }),
            byline(article, 'title2'),
          ], { spacing: 12, alignment: 'top' })
        : byline(article, 'title2'),
      w.text(opening(article, 14), { font: 'footnote', alignment: 'leading', lineLimit: 14 }),
      w.spacer(),
      w.divider(),
      footer(article, status, 4),
    ], CARD),

    // iPad landscape, 4×6: the hero earns its place beside the text rather than above it.
    extraLarge: w.hstack([
      w.vstack([
        header(article, date),
        byline(article, 'title2'),
        w.text(opening(article, 10), { font: 'footnote', alignment: 'leading', lineLimit: 10 }),
        w.spacer(),
        footer(article, status, 3),
      ], CARD),
      hero ? w.image(hero, { width: 260, cornerRadius: 14 }) : w.spacer({ minLength: 0 }),
    ], { spacing: 14 }),
  };
};
