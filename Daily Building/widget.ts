// The home screen widget — a drawing title block, not a magazine card.
//
// An ordinary sibling module that main.ts re-exports from; there is no magic `widget.ts` convention
// in Loom. It reads the database directly rather than using ctx.data, because the handler returns a
// different shape per trigger while the widget always wants the same thing.

import { w } from '@loom/widget';
import { progress, read, today } from './pipeline';
import { recipe, era } from './buildings';
import type { Article, Status } from './pipeline';

// One accent, matching the sheet's drafting-pen blue. Architecture does not need a palette per
// subject the way a painting does — the discipline of a single ink is the point.
const INK = 'blue';

function stageLabel(status: Status | null): string {
  if (!status) return 'Waiting to start…';
  switch (status.stage) {
    case 'pick': return 'Selecting…';
    case 'plan': return 'Planning the sheet…';
    case 'research': return 'Researching…';
    case 'write': return 'Drafting…';
    case 'illustrate': return 'Sourcing photographs…';
    default: return 'Ready';
  }
}

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
    w.text(b.name || 'Selecting a building…', { font, bold: true, alignment: 'leading', lineLimit: 2 }),
    line ? w.text(line, { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 1 })
         : w.spacer({ minLength: 0 }),
    b.location ? w.text(b.location, { font: 'caption', color: 'tertiary', alignment: 'leading', lineLimit: 1 })
               : w.spacer({ minLength: 0 }),
  ], { alignment: 'leading', spacing: 2 });
}

function footer(article: Article | null, status: Status | null, deckLines: number) {
  if (article && article.failed) {
    return w.label({ icon: 'exclamationmark.triangle.fill', title: 'Stopped', subtitle: 'Tap to resume', color: 'orange' });
  }
  if (article && article.stage === 'done') {
    const stack = [w.text(article.title, { font: 'subheadline', bold: true, alignment: 'leading', lineLimit: 2 })];
    if (deckLines > 0) {
      stack.push(w.text(article.standfirst, {
        font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: deckLines,
      }));
    }
    return w.vstack(stack, { alignment: 'leading', spacing: 3 });
  }
  return w.vstack([
    w.progressBar({
      value: status ? status.unitsDone : 0,
      total: status && status.unitsTotal ? status.unitsTotal : 16,
      color: INK, label: 'Drawing',
    }),
    w.text(stageLabel(status), { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 2 }),
  ], { alignment: 'leading', spacing: 4 });
}

const CARD = { alignment: 'leading', spacing: 8, padding: 4 };

export const widget = async () => {
  const date = today();
  const article = await read(recipe, date);
  const status = await progress(recipe, date);

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
        footer(article, status, 0),
      ], { ...CARD, spacing: 6 }),
    ], { spacing: 11, alignment: 'top' }),

    large: w.vstack([
      header(article, date),
      plate(article, 330),
      w.divider(),
      block(article, 'title3'),
      w.spacer(),
      footer(article, status, 2),
    ], CARD),

    // The iPhone XL size, 364×556 — the photograph, then the full title block, then the headline.
    extraLargePortrait: w.vstack([
      header(article, date),
      plate(article, 344),
      w.divider(),
      block(article, 'title2'),
      w.spacer(),
      w.divider(),
      footer(article, status, 4),
    ], { ...CARD, spacing: 10 }),

    extraLarge: w.hstack([
      plate(article, 340),
      w.vstack([
        header(article, date),
        block(article, 'title2'),
        w.spacer(),
        footer(article, status, 4),
      ], { ...CARD, spacing: 9 }),
    ], { spacing: 16, alignment: 'top' }),
  };
};
