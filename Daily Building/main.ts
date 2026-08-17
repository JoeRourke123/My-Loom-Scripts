// Daily Building — picks a building each day, researches it on the web, and draws up a sheet about
// it: a photographic plate, a title block, a timeline rule, and seven sections of prose.
//
// The engine is pipeline.ts, copied unchanged for the third time — the same resumable stage
// machine, batched through Loom.network.fetchAll and Loom.ai.completeAll so a whole article costs
// ~28s of wall clock instead of ~70s. Everything subject-specific lives in buildings.ts.

import { loom } from '@loom/core';
import {
  advance, listLiked, notifyOnce, progress, prune, read, remove, retry, setLiked, today,
} from './pipeline';
import { recipe } from './buildings';
import {
  articleView, errorView, failedView, likeButton, likedView, offerView, progressView,
} from './views';

// Loom looks for a named export called `widget` on main.ts; re-exporting one from a sibling is
// explicitly supported, and keeps the layout out of this file.
export { widget } from './widget';

const SLICE_BACKGROUND = 6_000;
const SLICE_FOREGROUND = 20_000;
const KEEP_DAYS = 7;

export default loom(async (ctx) => {
  // Clear a day's feature and stop, so the next run rebuilds it from scratch:
  //   Shortcuts → "Run Daily Building with input in Loom" → Dictionary { "reset": true }
  // Deliberately does NOT rebuild in the same run — the point is to watch a cold start on the
  // *next* trigger, which is what a background or Shortcut refetch actually looks like.
  if (isTruthy(ctx.input && (ctx.input as any).reset)) {
    const target = clamp(String((ctx.input as any).date || today()));
    await remove(recipe, target);
    Loom.log.info(`Daily Building: cleared ${target} — next run rebuilds it`);
    return { cleared: target };
  }

  switch (ctx.trigger) {
    case 'manual':
    case 'widget':
      return openSheet(today());

    case 'urlScheme':
      return headless(clamp(String((ctx.input && (ctx.input as any).date) || today())), SLICE_FOREGROUND);

    case 'shortcut':
    case 'siri':
      return headless(today(), SLICE_FOREGROUND);

    case 'backgroundProcessing': {
      const status = await headless(today(), SLICE_FOREGROUND);
      await prune(recipe, KEEP_DAYS);
      return status;
    }

    case 'backgroundRefresh':
      return headless(today(), SLICE_BACKGROUND);

    default:
      return { skipped: ctx.trigger };
  }
}, {
  // Sliced out as verbatim source text and evaluated with nothing else in scope, so every value
  // here must be a literal — one free identifier silently blanks the whole config.
  name: 'Daily Building',
  description: 'Researches and writes a researched drawing sheet about a building each day.',
  permissions: ['network', 'notifications'],
  returnsResult: true,
  triggers: { backgroundProcessing: true },
  widget: { refreshAfter: 3600, runOnTap: true },
});

// ---------------------------------------------------------------------------------------------

async function headless(date: string, deadlineMs: number) {
  const status = await advance(recipe, date, { deadlineMs });
  await notifyOnce(recipe, date);
  const article = await read(recipe, date);
  return {
    date: status.date,
    stage: status.stage,
    building: article?.subject?.name || '',
    artist: article?.subject?.author || '',
    progress: `${status.unitsDone}/${status.unitsTotal}`,
    done: status.done,
    failed: status.failed,
  };
}

function clamp(date: string): string {
  const t = today();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= t ? date : t;
}

// A Shortcuts Dictionary sends everything through as text, and the URL scheme only ever has
// strings, so a bare `=== true` would silently never fire from either.
function isTruthy(value: any): boolean {
  return value === true || value === 1 || /^(true|1|yes)$/i.test(String(value ?? ''));
}

// A throwing handler comes back as HTTP 200 carrying a red <pre> with no hx-trigger, which kills
// the self-chaining build loop permanently.
function guard(fn: (req: any) => Promise<any>) {
  return async (req: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      const msg = String((e && e.message) || e);
      Loom.log.error(`Daily Building route ${req.method} ${req.path}: ${msg}`);
      return errorView(msg, clamp(String(req.query.date || '')));
    }
  };
}

async function openSheet(date: string) {
  await Loom.ui.web({
    template: 'building.html',
    // bar: false — the drawing sheet runs to the edges and draws its own masthead. That costs the
    // Done button, so building.html carries the two replacements the docs require: a masthead that
    // scrolls to top, and a floating ↑ that appears at 300px.
    bar: false,
    routes: {
      'GET /view': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        const article = await read(recipe, d);
        if (!article) {
          return d === today()
            ? progressView(await advance(recipe, d, { maxUnits: 0 }))
            : offerView(d);
        }
        if (article.failed) return failedView(article);
        if (article.stage === 'done') return articleView(article);
        return progressView((await progress(recipe, d))!);
      }),

      'GET /build': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        const status = await advance(recipe, d, { maxUnits: 1 });
        if (status.done) {
          await notifyOnce(recipe, d);
          return articleView((await read(recipe, d))!);
        }
        if (status.failed) return failedView((await read(recipe, d))!);
        return progressView(status);
      }),

      'POST /start': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        return progressView(await advance(recipe, d, { maxUnits: 0 }));
      }),

      'POST /like': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        const article = await read(recipe, d);
        const liked = await setLiked(recipe, d, !(article && article.liked));
        return likeButton(d, liked);
      }),

      'GET /liked': guard(async () => likedView(await listLiked(recipe))),

      'POST /retry': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        await retry(recipe, d);
        return progressView((await progress(recipe, d))!);
      }),

      'POST /rebuild': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        await remove(recipe, d);
        return progressView(await advance(recipe, d, { maxUnits: 0 }));
      }),
    },
  });

  // Runs after the sheet is dismissed — Loom.ui.web keeps the run alive until then.
  const article = await read(recipe, date);
  return { date, building: article?.subject?.name || '', stage: article?.stage || 'pick' };
}
