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
import { read, today } from './store';
import type { Article } from './store';

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

function byline(article: Article | null, font: string) {
  const poem = (article && article.subject) || ({} as any);
  return w.vstack([
    w.text(poem.title || 'Daily Poem', { font, bold: true, alignment: 'leading', lineLimit: 2 }),
    w.text(String(poem.author || '').toUpperCase(), {
      font: 'caption', color: accent(article), alignment: 'leading', lineLimit: 1,
    }),
  ], { alignment: 'leading', spacing: 3 });
}

// The one place both states are decided, so every size tells the same story. There are only two
// now: the feature is downloaded, or it is not. No progress bar — nothing is being built here, and
// a bar that cannot move is worse than a sentence.
function footer(article: Article | null, deckLines: number) {
  if (!article) {
    return w.label({
      icon: 'moon.stars', title: 'Arriving overnight', subtitle: 'Written before morning', color: 'secondary',
    });
  }
  const stack = [
    w.text(article.title, { font: 'subheadline', bold: true, alignment: 'leading', lineLimit: 2 }),
  ];
  // deckLines: 0 drops the standfirst entirely — medium is 364×170 and the headline plus even two
  // lines of deck overflows it once the header and byline have taken their share.
  if (deckLines > 0) {
    stack.push(w.text(article.standfirst, {
      font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: deckLines,
    }));
  }
  return w.vstack(stack, { alignment: 'leading', spacing: 3 });
}

const CARD = { alignment: 'leading', spacing: 9, padding: 4 };

// --- the hero layout (large and extraLargePortrait) ---------------------------------------------
//
// Picture across the top, the poem's own identity set on it, the feature's headline underneath.
//
// Three things make this work, none of them obvious:
//
// 1. `w.gradient` is NOT a renderable node — it has no case in the render switch and draws as an
//    EmptyView if you put it in a tree. It is only legal as a stack's `background`. So the scrim
//    is a vstack laid over the image inside a zstack, not a layer in its own right.
// 2. 'clear' is a real colour name in widgetColor(), which is the only reason a fade is possible
//    at all — every other name is opaque.
// 3. The image passes `height` and no `width`. imageView does .frame(width: width, height: height)
//    with both optional, so a nil width keeps the proposed width: the picture fills whatever the
//    device actually gives the widget instead of being pinned to a 17 Pro Max's 364pt.
//
// Common props are applied in the order opacity → background → cornerRadius → padding, so padding
// on the scrim would inset the gradient too. The text blocks carry their own padding instead.

// The card's own width. w.image needs BOTH dimensions to fill: imageView does
// .scaledToFill().frame(width:height:).clipped(), and with a nil width the frame resolves its
// width from the image's aspect at that height — which is fit, not fill, and leaves a portrait
// picture as a narrow column. Pinning the width makes the crop happen horizontally instead.
//
// 364 is the large/XL widget width on a 17 Pro Max, which is what the rest of this file is
// measured against. On a narrower device the plate overruns to the right and WidgetKit clips it;
// that is a slightly off-centre crop, not a broken layout. Lower it if you move phones.
const PLATE_W = 364;

// Dark at the very top so the wordmark reads, clear through the middle so the picture is a
// picture, and dark from three-quarters down where the writing sits.
const SCRIM = ['black', 'clear', 'clear', 'black', 'black'];

// The whole card is the picture; everything else sits on top of it.
//
// The earlier version made the plate a band across the top with the text in a separate zone
// underneath. That has a failure mode: a zstack sizes to its tallest child, and the overlay —
// padding plus a wordmark row plus three lines of title block — can exceed a 172pt band, at which
// point the image stops filling and dead space opens above it. Sizing the plate to the whole card
// removes the failure rather than tuning around it: the image is always the tallest child.
//
// The heights are the real widget sizes on a 17 Pro Max, which is what PLATE_W assumes too. An
// image shorter than the card would leave a gap at the bottom; one taller pushes the writing off
// the end. There is no proposed-size to read at build time, so these are measurements, not maths.
function heroCard(
  article: Article | null,
  date: string,
  height: number,
  titleFont: string,
  deckLines: number,
) {
  const poem = (article && article.subject) || ({} as any);
  const url = heroImage(article);
  const tint = accent(article);

  // Everything over the picture is white or the strand tint. `primary` follows the system
  // appearance rather than the photograph and would go black-on-black half the time.
  const overlay = w.vstack([
    w.vstack([
      w.hstack([
        w.text('DAILY', { font: 'caption', bold: true, color: 'white' }),
        w.text('POEM', { font: 'caption', bold: true, color: tint }),
        w.spacer(),
        w.text(stamp(date), { font: 'caption', color: 'white' }),
        ...(article && article.liked ? [w.icon('heart.fill', { size: 11, color: 'white' })] : []),
      ], { spacing: 4 }),
    ], { padding: 13 }),

    w.spacer(),

    w.vstack([
      w.text(String(poem.strandLabel || '').toUpperCase(), {
        font: 'caption', bold: true, color: tint, alignment: 'leading', lineLimit: 1,
      }),
      w.text(poem.title || 'Daily Poem', {
        font: titleFont, bold: true, color: 'white', alignment: 'leading', lineLimit: 2,
      }),
      w.text(String(poem.author || '').toUpperCase(), {
        font: 'caption', color: 'white', alignment: 'leading', lineLimit: 1,
      }),

      ...(article
        ? [
            w.divider({ color: 'white' }),
            w.text(article.title, {
              font: 'subheadline', bold: true, color: 'white', alignment: 'leading', lineLimit: 2,
            }),
            // Wrapped rather than tinted: there is no per-text opacity, only the stack common prop,
            // so the deck gets its own stack to sit back from the headline.
            w.vstack([
              w.text(article.standfirst, {
                font: 'caption', color: 'white', alignment: 'leading', lineLimit: deckLines,
              }),
            ], { opacity: 0.78, alignment: 'leading' }),
          ]
        : [
            w.text('Arriving overnight', {
              font: 'caption', color: 'white', alignment: 'leading', lineLimit: 1,
            }),
          ]),
    ], { padding: 13, spacing: 4, alignment: 'leading' }),
  ], { background: w.gradient({ colors: SCRIM }) });

  // No picture: a tinted block the same size, so the card keeps its shape on the days illustration
  // failed rather than collapsing into a different layout.
  const plate = url
    ? w.image(url, { width: PLATE_W, height })
    : w.vstack([w.hstack([w.spacer()]), w.spacer({ minLength: height })], {
        background: w.gradient({ colors: [tint, 'black'], direction: 'diagonal' }),
      });

  return w.zstack([plate, overlay], { alignment: 'bottom' });
}

// --- the export ---------------------------------------------------------------------------------

export const widget = async () => {
  const date = today();
  const article = await read(date);
  const hero = heroImage(article);

  return {
    small: w.vstack([
      header(article, date),
      w.spacer(),
      byline(article, 'headline'),
      w.spacer(),
      article
        ? w.text(article.title, { font: 'caption', color: 'secondary', alignment: 'leading', lineLimit: 3 })
        : w.text('Arriving overnight', { font: 'caption', color: 'secondary', lineLimit: 2 }),
    ], { ...CARD, spacing: 4 }),

    medium: w.hstack([
      w.vstack([
        header(article, date),
        byline(article, 'headline'),
        w.spacer(),
        footer(article, 0),
      ], { ...CARD, spacing: 7 }),
      hero ? w.image(hero, { width: 92, height: 92, cornerRadius: 12 }) : w.spacer({ minLength: 0 }),
    ], { spacing: 10 }),

    // 4×4, roughly 364×382. The picture takes the top ~45%; the rest is the feature.
    //
    // No outer padding on these two: the hero is meant to run to the edges, and WidgetKit clips
    // the card's own corners. The text blocks below carry their own inset instead.
    large: heroCard(article, date, 382, 'title3', 2),

    // The iPhone XL size (364×556) and the one this widget is designed for. 174pt taller than
    // large, which buys a taller plate and the poem's opening lines under the deck — not a second
    // copy of everything.
    // 364×556 — the same card, taller, so the deck gets two more lines.
    extraLargePortrait: heroCard(article, date, 556, 'title2', 4),

    // iPad landscape, 4×6: the hero earns its place beside the text rather than above it.
    extraLarge: w.hstack([
      w.vstack([
        header(article, date),
        byline(article, 'title2'),
        w.text(opening(article, 10), { font: 'footnote', alignment: 'leading', lineLimit: 10 }),
        w.spacer(),
        footer(article, 3),
      ], CARD),
      hero ? w.image(hero, { width: 260, cornerRadius: 14 }) : w.spacer({ minLength: 0 }),
    ], { spacing: 14 }),
  };
};
