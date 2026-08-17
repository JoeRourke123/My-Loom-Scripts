// Everything that touches the network or the database.
//
// The article is written overnight by a Claude cloud routine and committed to
// github.com/JoeRourke123/My-Loom-Scripts; this file downloads it and keeps a local copy. There is
// no build engine here any more — no stage machine, no leases, no retry budget — because none of
// that was ever about writing articles. It existed to fit a 2-5 minute job into a ~30 second
// background window on a phone. The work happens elsewhere now, so the phone does one GET.

export interface Source { title: string; url: string }
export interface Section { heading: string; body: string; imageUrl: string; imagePage: string }

export interface Article {
  date: string;
  liked: boolean;
  title: string;
  standfirst: string;
  subject: any;
  sections: Section[];
  sources: Source[];
}

const KIND = 'artwork';
const TABLE = 'daily';
const BASE = 'https://raw.githubusercontent.com/JoeRourke123/My-Loom-Scripts/main/daily';

// The routine publishes a week ahead, so a night it misses is invisible here.
const AHEAD = 7;
const KEEP_DAYS = 7;

// ---------------------------------------------------------------------------------------------
// Dates

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today(): string {
  return localDate(new Date());
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

// ---------------------------------------------------------------------------------------------
// Sanitising
//
// Section bodies are rendered with { __html } into a web sheet that has no CSP. They are model
// output derived from arbitrary web pages, and now they arrive over the network rather than being
// produced in-process — so this is MORE load-bearing than it was, not less. The validator in the
// repo is a second line of defence, not a replacement for this one: it runs on a machine we do not
// control at render time.

// marked does not sanitise. This closes the path from a prompt-injected page into the web view.
export function sanitiseMarkdown(markdown: string): string {
  return String(markdown)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|style)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=/gi, ' data-blocked=')
    .replace(/javascript:/gi, '');
}

// Citation hygiene. A hallucinated URL inside something that looks like journalism is the worst
// output this can produce, so links are checked against the sources the article actually lists;
// unknown hrefs keep their text and lose the link.
export function stripUnknownLinks(markdown: string, allowed: Source[]): string {
  const ok = new Set(allowed.map((s) => s.url));
  return String(markdown)
    // FIRST, before anything reads a bracket. Models drift from [text](url) into fullwidth CJK
    // brackets — 【text】(url) — which marked does not recognise as a link, so it renders the
    // brackets literally mid-article. Normalising repairs the link instead of deleting it.
    .replace(/[【〔［]/g, '[')
    .replace(/[】〕］]/g, ']')
    .replace(/\[([^\]]*)\]\s*[（(]\s*(https?:\/\/[^)）\s]+)[^)）]*[)）]/g, (whole, text, href) =>
      ok.has(href) ? `[${text}](${href})` : text)
    // Anything still bracketed that never became a link: citation markers with no footnote list.
    .replace(/\[\^\d+\]/g, '')
    .replace(/\[\d+(?:\s*[,，]\s*\d+)*\](?!\()/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

// ---------------------------------------------------------------------------------------------
// Illustration
//
// The routine names a Wikipedia article per illustrated section; the phone resolves it to a picture
// at download time. Resolving late rather than at publish time is the point: a file URL captured
// last night can rot before it is read, and one written from memory looks valid right up until it
// 404s in the sheet. A title either resolves now or the section quietly runs unillustrated.

const WIKI_UA = 'LoomDaily/1.0 (personal Loom automation; github.com/JoeRourke123/My-Loom-Scripts)';

// Every section's image in ONE request. The obvious implementation — a search then a summary, per
// section — is 14 round trips and measured 3.8s. The Action API takes up to 50 titles at once and
// returns pageimages for all of them: 0.19s. Bridge calls are strictly serial, so collapsing round
// trips is the only speed-up available. A title the model invented comes back `missing` and that
// section simply goes unillustrated.
async function wikiImages(queries: string[]): Promise<Record<string, { url: string; page: string }>> {
  const wanted = queries.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 50);
  if (!wanted.length) return {};

  const res = await Loom.network.fetch(
    'https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=original%7Cthumbnail'
      + '&pithumbsize=960&format=json&redirects=1&titles='
      + wanted.map(encodeURIComponent).join('%7C'),
    // Wikimedia 403s requests carrying a default user agent.
    { headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`wiki pageimages HTTP ${res.status}`);
  const data = JSON.parse(res._body);

  // The API normalises and follows redirects, so the title that comes back is often not the title
  // that went in. Both maps have to be walked to get back to the caller's original string.
  const alias: Record<string, string> = {};
  for (const list of [data?.query?.normalized, data?.query?.redirects]) {
    for (const entry of list || []) alias[String(entry.to)] = String(entry.from);
  }
  const original = (title: string): string => {
    let name = title;
    for (let hop = 0; hop < 4 && alias[name]; hop++) name = alias[name];
    return name;
  };

  const out: Record<string, { url: string; page: string }> = {};
  const used = new Set<string>();
  for (const page of Object.values<any>(data?.query?.pages || {})) {
    if (!page || page.missing !== undefined) continue;
    // Prefer the 960px thumbnail: `original` can be a 40 MP scan that stalls the sheet.
    const url = String((page.thumbnail && page.thumbnail.source) || (page.original && page.original.source) || '');
    if (!url || used.has(url)) continue;
    used.add(url);
    out[original(String(page.title))] = {
      url,
      page: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replace(/ /g, '_'))}`,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rows
//
// TABLE is 'daily', deliberately not the old 'articles'. ScriptDB freezes column types on the
// first insert and drops NULLs on read, so the retired stage/cursor/lease/attempts columns would
// fight this row shape. A new table costs nothing and skips the migration entirely.

function parse<T>(raw: any, fallback: T): T {
  try {
    return raw ? (JSON.parse(String(raw)) as T) : fallback;
  } catch {
    return fallback;
  }
}

function toArticle(row: any): Article {
  return {
    date: String(row.date),
    liked: !!row.liked,
    title: String(row.title || ''),
    standfirst: String(row.standfirst || ''),
    subject: parse<any>(row.subject, {}),
    sections: parse<Section[]>(row.sections, []),
    sources: parse<Source[]>(row.sources, []),
  };
}

export async function read(date: string): Promise<Article | null> {
  const rows = await Loom.db.table(TABLE).select({ date });
  return rows.length ? toArticle(rows[0]) : null;
}

export async function has(date: string): Promise<boolean> {
  const rows = await Loom.db.table(TABLE).select({ date });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Fetching

// Returns false when the day simply is not published yet — a 404 is an ordinary state here, not an
// error, because the reader can be looking at a date the routine has not reached.
async function fetchDay(date: string): Promise<boolean> {
  const res = await Loom.network.fetch(`${BASE}/${KIND}/${date}.json`, {
    headers: { Accept: 'application/json' },
  });

  if (res.status === 404) return false;
  // fetch does NOT throw on non-2xx, and a 5xx body parses to nothing useful — checking status
  // first is the difference between "no article today" and a silent blank.
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${date}`);

  const doc = JSON.parse(res._body);
  if (doc.schemaVersion !== 1) throw new Error(`unknown schemaVersion ${doc.schemaVersion} for ${date}`);
  if (doc.date !== date) throw new Error(`${date}.json claims to be ${doc.date}`);
  if (!Array.isArray(doc.sections) || !doc.sections.length) throw new Error(`${date} has no sections`);

  const sources: Source[] = (Array.isArray(doc.sources) ? doc.sources : [])
    .filter((s: any) => s && typeof s.url === 'string')
    .map((s: any) => ({ title: String(s.title || ''), url: String(s.url) }));

  const sections: Section[] = doc.sections.map((s: any) => ({
    heading: String(s.heading || ''),
    body: stripUnknownLinks(sanitiseMarkdown(String(s.body || '')), sources),
    imageUrl: '',
    imagePage: '',
  }));

  // An unillustrated article is fine; failing one over missing pictures is not.
  try {
    const queries: string[] = doc.sections.map((s: any) => String(s.imageQuery || ''));
    const found = await wikiImages(queries);
    queries.forEach((q, i) => {
      const hit = found[q.trim()];
      if (!hit) return;
      sections[i].imageUrl = hit.url;
      sections[i].imagePage = hit.page;
    });
  } catch (e: any) {
    Loom.log.warn(`Daily Artwork: image lookup failed for ${date}: ${e.message}`);
  }

  const row = {
    date,
    title: String(doc.title || ''),
    standfirst: String(doc.standfirst || ''),
    subject: JSON.stringify(doc.subject || {}),
    sections: JSON.stringify(sections),
    sources: JSON.stringify(sources),
    fetchedAt: new Date().toISOString(),
  };

  const t = Loom.db.table(TABLE);
  // Every column on every write: rowToDict drops NULLs, so a partial insert means missing keys on
  // read and an update against a column that was never created.
  if (await has(date)) await t.update({ date }, row);
  else await t.insert({ ...row, liked: 0, notifiedAt: '' });

  return true;
}

// Today first, then the days after it. Stops asking for future days as soon as one is missing —
// the routine writes them in order, so a gap means it has not got that far.
export async function sync(): Promise<{ fetched: string[]; missing: string[] }> {
  const start = today();
  const fetched: string[] = [];
  const missing: string[] = [];

  for (let i = 0; i < AHEAD; i++) {
    const date = shift(start, i);
    if (await has(date)) continue;
    let got = false;
    try {
      got = await fetchDay(date);
    } catch (e: any) {
      Loom.log.warn(`Daily Artwork: ${date} failed to download: ${e.message}`);
      missing.push(date);
      break;
    }
    if (got) fetched.push(date);
    else {
      missing.push(date);
      if (i > 0) break;
    }
  }

  if (fetched.length) Loom.log.info(`Daily Artwork: downloaded ${fetched.join(', ')}`);
  return { fetched, missing };
}

// Used by the sheet: make sure this specific day is here, fetching it on demand.
export async function ensure(date: string): Promise<Article | null> {
  const existing = await read(date);
  if (existing) return existing;
  const got = await fetchDay(date);
  return got ? read(date) : null;
}

// ---------------------------------------------------------------------------------------------
// Liking, pruning, notifying

export async function setLiked(date: string, liked: boolean): Promise<boolean> {
  await Loom.db.table(TABLE).update({ date }, { liked: liked ? 1 : 0 });
  return liked;
}

export async function listLiked(): Promise<Article[]> {
  const rows: any[] = await Loom.db.table(TABLE).select({ liked: 1 });
  return rows
    .map(toArticle)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Liked articles are kept forever; everything else is a day's reading. Future days are never
// pruned — they have not been read yet.
export async function prune(): Promise<number> {
  const cutoff = shift(today(), -KEEP_DAYS);
  const t = Loom.db.table(TABLE);
  const rows: any[] = await t.select();
  let removed = 0;
  for (const row of rows) {
    if (row.liked) continue;
    if (String(row.date) >= cutoff) continue;
    await t.delete({ date: row.date });
    removed++;
  }
  if (removed) Loom.log.info(`Daily Artwork: pruned ${removed} old article(s)`);
  return removed;
}

// Idempotent under overlapping runs, which is why notifiedAt is a column rather than a comparison
// of before and after.
export async function notifyOnce(date: string): Promise<void> {
  const t = Loom.db.table(TABLE);
  const rows = await t.select({ date });
  if (!rows.length) return;
  const row: any = rows[0];
  if (row.notifiedAt) return;

  // A download that lands at 03:00 must not buzz at 03:00. An omitted or unparseable trigger date
  // silently means "five seconds from now", so it has to be valid and in the future.
  const at = new Date();
  at.setHours(7, 0, 0, 0);
  const trigger = at.getTime() > Date.now() + 60_000 ? { date: at.toISOString() } : undefined;

  const subject = parse<any>(row.subject, {});
  await Loom.notify.schedule({
    title: 'Today’s artwork',
    body: `${row.title} — ${subject.author || ''}`.trim(),
    trigger,
  });
  await t.update({ date }, { notifiedAt: new Date().toISOString() });
}
