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

const KIND = 'building';
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
    imageUrl: String(s.imageUrl || ''),
    imagePage: String(s.imagePage || ''),
  }));

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
      Loom.log.warn(`Daily Building: ${date} failed to download: ${e.message}`);
      missing.push(date);
      break;
    }
    if (got) fetched.push(date);
    else {
      missing.push(date);
      if (i > 0) break;
    }
  }

  if (fetched.length) Loom.log.info(`Daily Building: downloaded ${fetched.join(', ')}`);
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
  if (removed) Loom.log.info(`Daily Building: pruned ${removed} old article(s)`);
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
  // Most of the corpus before 1400 has no named architect — "Great Mosque of Córdoba — Various" is
  // a worse notification than naming the style, so fall back the way the old engine did.
  const architect = String(subject.author || '');
  const credit = !architect || /^(various|unknown)$/i.test(architect) ? String(subject.style || '') : architect;
  await Loom.notify.schedule({
    title: 'Today’s building',
    body: `${row.title}${credit ? ` — ${credit}` : ''}`,
    trigger,
  });
  await t.update({ date }, { notifiedAt: new Date().toISOString() });
}
