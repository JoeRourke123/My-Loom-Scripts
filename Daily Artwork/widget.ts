// The home screen widget.
//
// NOTE: an ordinary sibling module that main.ts re-exports from — there is no magic `widget.ts`
// convention in Loom. It reads the database directly rather than using ctx.data, because the
// handler returns a different shape per trigger while the widget always wants the same thing.
//
// The subject here is a picture, so the picture is the widget. That is the main departure from
// Daily Poem, where the image was a 92pt thumbnail beside the text.

import { w } from '@loom/widget';
import { read, today } from './store';
import type { Article } from './store';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function stamp(date: string): string {
  const [, m, d] = String(date).split('-').map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]}` : String(date);
}

// The palette is a closed 17-name vocabulary and an unrecognised name silently falls back to
// .primary, so the corpus ships `accentName` already resolved to a legal value offline.
const PALETTE = new Set(['primary', 'secondary', 'tertiary', 'accent', 'red', 'orange', 'yellow',
  'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'brown', 'white', 'black']);

function accentOf(article: Article | null): string {
  const name = String((article && article.subject && article.subject.accentName) || '');
  return PALETTE.has(name) ? name : 'accent';
}

// w.image is always .scaledToFill().frame().clipped() with no fit option — but a frame with only a
// width preserves the intrinsic aspect. 358 of the 730 works are portrait, so passing a width
// blindly would crop half the corpus; the shipped dimensions let each one keep its own shape.
function plate(article: Article | null, box: number) {
  const art = (article && article.subject) || ({} as any);
  if (!art.imageUrl) return w.spacer({ minLength: 0 });
  const w0 = Number(art.width) || 4;
  const h0 = Number(art.height) || 3;
  // Fit the work inside a `box` square: landscape is width-bound, portrait is height-bound.
  const width = h0 > w0 ? Math.round(box * (w0 / h0)) : box;
  return w.image(art.imageUrl, { width, cornerRadius: 10 });
}


// --- shared pieces -----------------------------------------------------------------------------

function header(article: Article | null, date: string, accent: string) {
  const art = (article && article.subject) || ({} as any);
  const kids = [
    w.icon('paintpalette.fill', { size: 12, color: accent }),
    w.text(stamp(date), { font: 'caption', color: 'secondary' }),
  ];
  if (art.movementLabel) {
    kids.push(w.text('·', { font: 'caption', color: 'tertiary' }));
    kids.push(w.text(art.movementLabel, { font: 'caption', color: 'tertiary', lineLimit: 1 }));
  }
  kids.push(w.spacer());
  if (article && article.liked) kids.push(w.icon('heart.fill', { size: 11, color: 'pink' }));
  return w.hstack(kids, { spacing: 5 });
}

// There is no equivalent of the poem's opening lines: `description` is empty for 98.7% of works,
// so the byline IS the text.
function byline(article: Article | null, font: string) {
  const art = (article && article.subject) || ({} as any);
  const meta = [art.year, art.movementLabel].filter(Boolean).join(' · ');
  return w.vstack([
    w.text(art.title || 'Daily Artwork', { font, bold: true, alignment: 'leading', lineLimit: 2 }),
    w.text(art.author || '', { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 1 }),
    meta ? w.text(meta, { font: 'caption', color: 'tertiary', alignment: 'leading', lineLimit: 1 })
         : w.spacer({ minLength: 0 }),
  ], { alignment: 'leading', spacing: 2 });
}

// Two states now, not four: the feature is downloaded, or it is not. No progress bar — nothing is
// being built here, and a bar that cannot move is worse than a sentence.
function footer(article: Article | null, deckLines: number, accent: string) {
  if (!article) {
    return w.label({
      icon: 'moon.stars', title: 'Arriving overnight', subtitle: 'Written before morning', color: 'secondary',
    });
  }
  const stack = [w.text(article.title, { font: 'subheadline', bold: true, alignment: 'leading', lineLimit: 2 })];
  if (deckLines > 0) {
    stack.push(w.text(article.standfirst, {
      font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: deckLines,
    }));
  }
  return w.vstack(stack, { alignment: 'leading', spacing: 3 });
}

const CARD = { alignment: 'leading', spacing: 8, padding: 4 };

// --- the export ---------------------------------------------------------------------------------

export const widget = async () => {
  const date = today();
  const article = await read(date);
  const accent = accentOf(article);

  return {
    // Just the painting and the date — at 170pt anything else is noise.
    small: w.vstack([
      header(article, date, accent),
      w.spacer(),
      plate(article, 132),
      w.spacer(),
    ], { ...CARD, spacing: 5, alignment: 'center' }),

    medium: w.hstack([
      plate(article, 128),
      w.vstack([
        header(article, date, accent),
        byline(article, 'headline'),
        w.spacer(),
        footer(article, 0, accent),
      ], { ...CARD, spacing: 6 }),
    ], { spacing: 11, alignment: 'top' }),

    // 4×4 — the painting gets the top two thirds, the words the rest.
    large: w.vstack([
      header(article, date, accent),
      plate(article, 300),
      w.spacer(),
      w.divider(),
      byline(article, 'title3'),
      footer(article, 2, accent),
    ], { ...CARD, alignment: 'center' }),

    // The iPhone XL size (364×556) and the one this is designed for: the work large, then the
    // byline, then the headline and deck the article generated.
    extraLargePortrait: w.vstack([
      header(article, date, accent),
      plate(article, 330),
      w.divider(),
      byline(article, 'title2'),
      w.spacer(),
      footer(article, 4, accent),
    ], { ...CARD, spacing: 11, alignment: 'center' }),

    // iPad landscape, 4×6: the work beside the words rather than above them.
    extraLarge: w.hstack([
      plate(article, 330),
      w.vstack([
        header(article, date, accent),
        byline(article, 'title2'),
        w.spacer(),
        footer(article, 4, accent),
      ], { ...CARD, spacing: 9 }),
    ], { spacing: 16, alignment: 'top' }),
  };
};
