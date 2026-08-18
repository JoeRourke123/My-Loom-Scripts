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

// --- the hero layout (large and extraLargePortrait) ---------------------------------------------
//
// The photograph across the top under a scrim, the title block set on it, the sheet's headline
// underneath. Closer to a real drawing sheet than the stacked version it replaces.
//
// Three things make this work, none of them obvious:
//
// 1. `w.gradient` is NOT a renderable node — it only has meaning as a stack's `background`, so the
//    scrim is a vstack laid over the image inside a zstack rather than a layer of its own.
// 2. 'clear' is a real colour name in widgetColor(), which is the only reason a fade is possible.
// 3. The image passes `height` and no `width`. imageView does .frame(width:height:) with both
//    optional, so a nil width keeps the proposed width and the plate fills whatever the device
//    gives the widget.
//
// Cropping costs less here than it does for Daily Artwork: architecture photographs are
// overwhelmingly landscape, so a band is close to their natural shape.

// The card's own width. w.image needs BOTH dimensions to fill: imageView does
// .scaledToFill().frame(width:height:).clipped(), and with a nil width the frame resolves its
// width from the image's aspect at that height — which is fit, not fill, and leaves a portrait
// picture as a narrow column. Pinning the width makes the crop happen horizontally instead.
//
// 364 is the large/XL widget width on a 17 Pro Max, which is what the rest of this file is
// measured against. On a narrower device the plate overruns to the right and WidgetKit clips it;
// that is a slightly off-centre crop, not a broken layout. Lower it if you move phones.
const PLATE_W = 364;

const SCRIM = ['black', 'clear', 'clear', 'black'];

function heroPanel(article: Article | null, date: string, height: number, titleFont: string) {
  const b = (article && article.subject) || ({} as any);
  const named = b.architect && !/^(various|unknown)$/i.test(b.architect);
  const line = [named ? b.architect : null, b.year !== undefined ? era(b.year) : null]
    .filter(Boolean).join(' · ');

  // Everything over the photograph is white or the drafting-pen blue. `primary` would follow the
  // system appearance rather than the picture and go black-on-black half the time.
  const overlay = w.vstack([
    w.vstack([
      w.hstack([
        w.icon('ruler.fill', { size: 11, color: INK }),
        w.text(b.style || 'Daily Building', { font: 'caption', color: 'white', lineLimit: 1 }),
        w.spacer(),
        ...(article && article.liked ? [w.icon('circle.fill', { size: 8, color: 'white' })] : []),
      ], { spacing: 5 }),
    ], { padding: 12 }),

    w.spacer(),

    w.vstack([
      w.text(b.name || 'Daily Building', {
        font: titleFont, bold: true, color: 'white', alignment: 'leading', lineLimit: 2,
      }),
      line
        ? w.text(line, { font: 'caption', bold: true, color: INK, alignment: 'leading', lineLimit: 1 })
        : w.spacer({ minLength: 0 }),
      b.location
        ? w.text(b.location, { font: 'caption', color: 'white', alignment: 'leading', lineLimit: 1 })
        : w.spacer({ minLength: 0 }),
    ], { padding: 12, spacing: 2, alignment: 'leading' }),
  ], { background: w.gradient({ colors: SCRIM }) });

  const plate = b.imageUrl
    ? w.image(b.imageUrl, { width: PLATE_W, height })
    : w.vstack([w.hstack([w.spacer()]), w.spacer({ minLength: height })], {
        background: w.gradient({ colors: [INK, 'black'], direction: 'diagonal' }),
      });

  return w.zstack([plate, overlay], { alignment: 'bottom' });
}

function details(article: Article | null, deckLines: number) {
  if (!article) {
    return w.vstack([
      w.label({
        icon: 'moon.stars', title: 'Arriving overnight', subtitle: 'Drawn up before morning', color: 'secondary',
      }),
    ], { padding: 13 });
  }
  return w.vstack([
    w.text(article.title, { font: 'subheadline', bold: true, alignment: 'leading', lineLimit: 2 }),
    w.text(article.standfirst, {
      font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: deckLines,
    }),
  ], { padding: 13, spacing: 5, alignment: 'leading' });
}

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

    // 4×4, roughly 364×382. The photograph runs to the edges across the top, the title block set
    // on it, the sheet underneath. No outer padding — the plate is meant to bleed, and WidgetKit
    // rounds the card's own corners.
    large: w.vstack([
      heroPanel(article, date, 172, 'title3'),
      details(article, 3),
      w.spacer(),
    ], { alignment: 'leading', spacing: 0 }),

    // The iPhone XL size, 364×556 — a deeper plate and one more line of deck.
    extraLargePortrait: w.vstack([
      heroPanel(article, date, 268, 'title2'),
      details(article, 4),
      w.spacer(),
    ], { alignment: 'leading', spacing: 0 }),

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
