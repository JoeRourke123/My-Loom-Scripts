// The home screen widget — a drawing title block, not a magazine card.
//
// An ordinary sibling module that main.ts re-exports from; there is no magic `widget.ts` convention
// in Loom. It reads the database directly rather than using ctx.data, because the handler returns a
// different shape per trigger while the widget always wants the same thing.

import { w } from '@loom/widget';
import { read, today } from './store';
import { era } from './views';
import type { Article } from './store';

// One accent, matching the sheet's drafting-pen blue. Architecture does not need a palette per
// subject the way a painting does — the discipline of a single ink is the point.
const INK = 'blue';


// w.image is always .scaledToFill().frame().clipped() with no fit option, but a frame with only a
// width keeps the intrinsic aspect. Architecture photographs are overwhelmingly landscape, so the
// usual case is full width; the shipped dimensions catch the tall exceptions (towers, spires).
function plate(article: Article | null, box: number) {
  const b = (article && article.subject) || ({} as any);
  if (!b.imageUrl) return w.spacer({ minLength: 0 });
  const w0 = Number(b.width) || 4;
  const h0 = Number(b.height) || 3;
  const width = h0 > w0 ? Math.round(box * (w0 / h0)) : box;
  return w.image(b.imageUrl, { width, cornerRadius: 3 });
}

function header(article: Article | null, date: string) {
  const b = (article && article.subject) || ({} as any);
  const kids = [
    w.icon('ruler.fill', { size: 11, color: INK }),
    w.text(b.style || 'Daily Building', { font: 'caption', color: 'secondary', lineLimit: 1 }),
    w.spacer(),
  ];
  if (article && article.liked) kids.push(w.icon('circle.fill', { size: 8, color: INK }));
  return w.hstack(kids, { spacing: 5 });
}

// The title block, reduced to what fits: name, then architect and date on one measured line.
function block(article: Article | null, font: string) {
  const b = (article && article.subject) || ({} as any);
  const named = b.architect && !/^(various|unknown)$/i.test(b.architect);
  const line = [named ? b.architect : null, b.year !== undefined ? era(b.year) : null]
    .filter(Boolean).join(' · ');
  return w.vstack([
    w.text(b.name || 'Daily Building', { font, bold: true, alignment: 'leading', lineLimit: 2 }),
    line ? w.text(line, { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 1 })
         : w.spacer({ minLength: 0 }),
    b.location ? w.text(b.location, { font: 'caption', color: 'tertiary', alignment: 'leading', lineLimit: 1 })
               : w.spacer({ minLength: 0 }),
  ], { alignment: 'leading', spacing: 2 });
}

// Two states now, not four: the sheet is downloaded, or it is not. No progress bar — nothing is
// being drawn here, and a bar that cannot move is worse than a sentence.
function footer(article: Article | null, deckLines: number) {
  if (!article) {
    return w.label({
      icon: 'moon.stars', title: 'Arriving overnight', subtitle: 'Drawn up before morning', color: 'secondary',
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

export const widget = async () => {
  const date = today();
  const article = await read(date);

  return {
    small: w.vstack([
      header(article, date),
      plate(article, 140),
      w.spacer(),
      block(article, 'caption'),
    ], { ...CARD, spacing: 5 }),

    medium: w.hstack([
      plate(article, 150),
      w.vstack([
        header(article, date),
        block(article, 'headline'),
        w.spacer(),
        footer(article, 0),
      ], { ...CARD, spacing: 6 }),
    ], { spacing: 11, alignment: 'top' }),

    large: w.vstack([
      header(article, date),
      plate(article, 330),
      w.divider(),
      block(article, 'title3'),
      w.spacer(),
      footer(article, 2),
    ], CARD),

    // The iPhone XL size, 364×556 — the photograph, then the full title block, then the headline.
    extraLargePortrait: w.vstack([
      header(article, date),
      plate(article, 344),
      w.divider(),
      block(article, 'title2'),
      w.spacer(),
      w.divider(),
      footer(article, 4),
    ], { ...CARD, spacing: 10 }),

    extraLarge: w.hstack([
      plate(article, 340),
      w.vstack([
        header(article, date),
        block(article, 'title2'),
        w.spacer(),
        footer(article, 4),
      ], { ...CARD, spacing: 9 }),
    ], { spacing: 16, alignment: 'top' }),
  };
};
