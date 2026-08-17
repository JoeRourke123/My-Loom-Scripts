// Daily Poem — reads a feature about one poem each morning.
//
// The article is researched and written overnight by a Claude cloud routine (see routines/poem.md
// in github.com/JoeRourke123/My-Loom-Scripts) and committed to that repo. This script downloads it
// and shows it. That is the whole job.
//
// It used to build the article on the phone: a resumable stage machine with leases, retry policies
// and batched model calls, all of it shaped by iOS giving background work ~30 seconds. Moving the
// writing off the device deleted about a thousand lines from this project and fixed the thing the
// machinery caused — sections written in separate calls that repeated each other.

import { loom } from '@loom/core';
import { ensure, listLiked, notifyOnce, prune, read, setLiked, sync, today } from './store';
import { articleView, errorView, likeButton, likedView, pendingView } from './views';

// Loom looks for a named export called `widget` on main.ts; re-exporting one from a sibling is
// explicitly supported, and keeps the layout out of this file.
export { widget } from './widget';

export default loom(async (ctx) => {
  // Only worth presenting when someone is looking at the screen — a widget tap is, since runOnTap
  // opens Loom. On a background run Loom.ui.web returns immediately without presenting.
  if (ctx.trigger === 'manual' || ctx.trigger === 'widget') return openSheet(today());

  const { fetched, missing } = await sync();
  await notifyOnce(today());
  await prune();
  return { fetched, missing };
}, {
  // Sliced out as verbatim source text and evaluated with nothing else in scope, so every value
  // here must be a literal — one free identifier silently blanks the whole config.
  name: 'Daily Poem',
  description: 'A researched feature about a poem, written overnight and waiting each morning.',
  permissions: ['network', 'notifications'],
  returnsResult: true,
  // backgroundRefresh, not backgroundProcessing: the work is one ~30 KB GET now, which fits a
  // refresh window comfortably. It no longer has to wait for charging on wifi.
  triggers: { backgroundRefresh: true },
  widget: { refreshAfter: 3600, runOnTap: true },
});

// ---------------------------------------------------------------------------------------------

// Never let a date the routine has not reached become a fetch for a day that cannot exist.
function clamp(date: string): string {
  const t = today();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= t ? date : t;
}

// A throwing handler comes back as HTTP 200 carrying a red <pre>, which reads as a broken app.
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
    // button means losing the reliable way out — the page adds a sticky masthead and a floating ↑
    // so swipe-to-dismiss is always one tap from reachable.
    bar: false,
    routes: {
      // Fetches on demand, so opening the app works even if background refresh has not run today.
      'GET /view': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        const article = await ensure(d);
        return article ? articleView(article) : pendingView(d);
      }),

      'POST /like': guard(async (req) => {
        const d = clamp(String(req.query.date || date));
        const article = await read(d);
        const liked = await setLiked(d, !(article && article.liked));
        return likeButton(d, liked);
      }),

      'GET /liked': guard(async () => likedView(await listLiked())),
    },
  });

  // Runs after the sheet is dismissed — Loom.ui.web keeps the run alive until then.
  const article = await read(date);
  return { date, title: article?.title || '', published: !!article };
}
