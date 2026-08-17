// Daily Poem — picks a poem each day, researches it on the web, writes an illustrated magazine
// feature about it, and shows it in a web sheet.
//
// The article is built by a resumable stage machine in pipeline.ts, one network round trip at a
// time, because a full article is 2-5 minutes of serial work and a background window is ~30
// seconds shared across every project on the device. Overnight background runs chip away at it;
// opening the sheet finishes it in the foreground with live progress.

import { loom } from '@loom/core';
import {
  advance, listLiked, notifyOnce, progress, prune, read, remove, retry, setLiked, today,
} from './pipeline';
import { recipe } from './poems';
import {
  articleView, errorView, failedView, likeButton, likedView, offerView, progressView,
} from './views';

// Loom looks for a named export called `widget` on main.ts; re-exporting one from a sibling is
// explicitly supported, and keeps the layout out of this file.
export { widget } from './widget';

// Background refresh shares its window with every other project, so it takes a small bite.
// Background processing only fires while charging on wifi, where a longer slice costs nobody
// anything. Neither is a hard cap: Loom.network.fetch exposes no timeout, so a hung unit can
// overrun by a minute whatever this says.
const SLICE_BACKGROUND = 6_000;
const SLICE_FOREGROUND = 20_000;
const KEEP_DAYS = 7;

export default loom(async (ctx) => {
  // Clear a day's article and stop, so the next run rebuilds it from scratch. This is the testing
  // hook for the whole pipeline — see the Shortcuts recipe in the handover.
  //
  //   Shortcuts → "Run Daily Poem with input in Loom" → Dictionary { "reset": true }
  //   optionally with "date": "2026-08-14" to clear a past day instead of today.
  //
  // Deliberately does NOT rebuild in the same run: the point is to watch a cold start happen on
  // the *next* trigger, which is what a background or Shortcut refetch actually looks like.
  // Shortcuts hands dictionary values through as strings, so this accepts both.
  if (isTruthy(ctx.input && (ctx.input as any).reset)) {
    const target = clamp(String((ctx.input as any).date || today()));
    await remove(recipe, target);
    Loom.log.info(`Daily Poem: cleared ${target} — next run rebuilds it`);
    return { cleared: target };
  }

  switch (ctx.trigger) {
    case 'manual':
    case 'widget':
      return openSheet(today());

    case 'urlScheme':
      return headless(clamp(String((ctx.input && ctx.input.date) || today())), SLICE_FOREGROUND);

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
  name: 'Daily Poem',
  description: 'Researches and writes an illustrated article about a poem each day.',
  permissions: ['network', 'notifications'],
  returnsResult: true,
  triggers: { backgroundProcessing: true },
  // The widget only ever changes when the script runs, so refreshAfter just keeps WidgetKit's
  // timeline alive rather than fetching anything. runOnTap makes the card a door into the article.
  widget: { refreshAfter: 3600, runOnTap: true },
});

// ---------------------------------------------------------------------------------------------
// Headless runs

async function headless(date: string, deadlineMs: number) {
  const status = await advance(recipe, date, { deadlineMs });
  await notifyOnce(recipe, date);
  return {
    date: status.date,
    stage: status.stage,
    title: (await read(recipe, date))?.title || '',
    progress: `${status.unitsDone}/${status.unitsTotal}`,
    done: status.done,
    failed: status.failed,
  };
}

// ---------------------------------------------------------------------------------------------
// The sheet

function clamp(date: string): string {
  const t = today();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= t ? date : t;
}

// A Shortcuts Dictionary sends everything through as text, and the URL scheme only ever has
// strings, so a bare `=== true` would silently never fire from the two places this is used from.
function isTruthy(value: any): boolean {
  return value === true || value === 1 || /^(true|1|yes)$/i.test(String(value ?? ''));
}

// A throwing handler comes back as HTTP 200 carrying a red <pre> with no hx-trigger, which kills
// the self-chaining build loop permanently. Wrapping every route means one transient blip degrades
// to "trying again…" instead of stranding the sheet until it is closed and reopened.
function guard(fn: (req: any) => Promise<any>) {
  return async (req: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      const msg = String((e && e.message) || e);
      Loom.log.error(`Daily Poem route ${req.method} ${req.path}: ${msg}`);
      return errorView(msg, clamp(String(req.query.date || '')));
    }
  };
}

async function openSheet(date: string) {
  await Loom.ui.web({
    template: 'poem-article.html',
    // The page draws its own masthead, so the nav bar would just be a second one. Losing the Done
    // button means losing the reliable way out — Loom shows the grabber, and the page adds a
    // sticky masthead and a floating ↑ so swipe-to-dismiss is always one tap from reachable.
    bar: false,
    routes: {
      // Router. Today with no row starts building; a historic day offers first, so a mis-scrolled
      // date wheel does not quietly spend two minutes of tokens.
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

      // One unit per request. The fragment returned re-triggers this route until the article
      // fragment (which has no hx-trigger) ends the chain.
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
  return { date, title: article?.title || '', stage: article?.stage || 'pick' };
}
