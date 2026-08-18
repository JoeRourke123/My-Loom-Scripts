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

// --- the hero layout (large and extraLargePortrait) ---------------------------------------------
//
// The work across the top under a scrim, its label set on it, the feature's headline underneath.
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
// Filling is the point here, and the crop is accepted: .scaledToFill() with both frame dimensions
// pinned means a tall canvas shows its middle slice rather than the whole work. If you ever want
// the complete painting again, small/medium/extraLarge still use plate(), which reads the shipped
// width/height off the corpus row and preserves each work's own aspect.

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
  const art = (article && article.subject) || ({} as any);
  const tint = accentOf(article);
  const meta = [art.year, art.movementLabel].filter(Boolean).join(' · ');

  // Everything over the work is white or the shipped accent. `primary` would follow the system
  // appearance rather than the painting and go black-on-black half the time.
  const overlay = w.vstack([
    w.vstack([
      w.hstack([
        w.icon('paintpalette.fill', { size: 12, color: tint }),
        w.text(stamp(date), { font: 'caption', color: 'white' }),
        w.spacer(),
        ...(article && article.liked ? [w.icon('heart.fill', { size: 11, color: 'white' })] : []),
      ], { spacing: 5 }),
    ], { padding: 12 }),

    w.spacer(),

    w.vstack([
      w.text(art.title || 'Daily Artwork', {
        font: titleFont, bold: true, color: 'white', alignment: 'leading', lineLimit: 2,
      }),
      w.text(String(art.author || '').toUpperCase(), {
        font: 'caption', bold: true, color: tint, alignment: 'leading', lineLimit: 1,
      }),
      meta
        ? w.text(meta, { font: 'caption', color: 'white', alignment: 'leading', lineLimit: 1 })
        : w.spacer({ minLength: 0 }),
    ], { padding: 12, spacing: 2, alignment: 'leading' }),
  ], { background: w.gradient({ colors: SCRIM }) });

  const plate = art.imageUrl
    ? w.image(art.imageUrl, { width: PLATE_W, height })
    : w.vstack([w.hstack([w.spacer()]), w.spacer({ minLength: height })], {
        background: w.gradient({ colors: [tint, 'black'], direction: 'diagonal' }),
      });

  return w.zstack([plate, overlay], { alignment: 'bottom' });
}

function details(article: Article | null, deckLines: number) {
  if (!article) {
    return w.vstack([
      w.label({
        icon: 'moon.stars', title: 'Arriving overnight', subtitle: 'Written before morning', color: 'secondary',
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

    // 4×4, roughly 364×382. The work runs to the edges across the top; the feature sits under it.
    //
    // No outer padding on these two — the plate is meant to bleed, and WidgetKit rounds the card's
    // own corners. The text below carries its own inset.
    large: w.vstack([
      heroPanel(article, date, 172, 'title3'),
      details(article, 3),
      w.spacer(),
    ], { alignment: 'leading', spacing: 0 }),

    // The iPhone XL size (364×556). The band is deliberately deeper than half here — this is the
    // one publication where the picture IS the subject, and a portrait canvas needs the height.
    extraLargePortrait: w.vstack([
      heroPanel(article, date, 300, 'title2'),
      details(article, 4),
      w.spacer(),
    ], { alignment: 'leading', spacing: 0 }),

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
