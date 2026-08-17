// Generic resumable "daily research article" engine. Knows nothing about its subject — swap the
// Recipe (see buildings.ts) and this drives anything. Third project on this engine, still verbatim
// apart from the notification title.
//
// The whole shape of this file comes from one constraint: a full article is ~25 serial network
// round trips and 2-5 minutes of wall clock, and Loom gives background scripts a ~30 second window
// SHARED serially across every project on the device, with no mid-script cancellation. So the
// article cannot be built in one pass, anywhere. Instead:
//
//   ONE UNIT = at most one bridge round trip, followed by exactly one Loom.db.update.
//
// "One round trip" now means one *batched* call: research issues all six searches through
// Loom.network.fetchAll, write issues all seven sections through Loom.ai.completeAll, and
// illustrate resolves every image in a single Wikipedia request. Bridge calls block the script
// thread, so Promise.all over them stays serial (ADR-025) — batching is the only way to overlap
// anything, and it took a build from ~70s to ~28s.
//
// There is therefore no partial-persist window and no need for transactions (which the bridge does
// not expose anyway). A unit either completed and is durable, or it did not happen and repeats.
// The write stage is the one exception and it is deliberate: it persists whichever sections came
// back before reporting the failures, so a retry re-requests only what actually failed.
// advance() runs as many units as its deadline allows and returns; whoever calls next picks up
// exactly where it stopped.

export type Stage = 'pick' | 'plan' | 'research' | 'write' | 'illustrate' | 'done';

export interface Subject { id: string; title: string; author: string; [key: string]: any }
export interface Source { title: string; url: string; content: string }

export interface Section {
  heading: string;
  angle: string;
  imageQuery: string;
  body: string;
  imageUrl: string;
  imagePage: string;
}

export interface PlanResult {
  title: string;
  standfirst: string;
  queries: string[];
  sections: { heading: string; angle: string; imageQuery: string }[];
}

export interface WriteContext {
  subject: Subject;
  title: string;
  standfirst: string;
  sections: Section[];
  index: number;
  sources: Source[];
  previous: string;
}

export interface Recipe {
  table: string;
  searches: number;
  sections: number;
  pick(date: string): Promise<Subject>;
  plan(subject: Subject, attempt: number): Promise<PlanResult>;
  // Returns one entry per context, in order. An entry is '' when that section failed — the engine
  // retries only those.
  writeAll(contexts: WriteContext[]): Promise<string[]>;
}

export interface Article {
  date: string;
  stage: Stage;
  liked: boolean;
  failed: boolean;
  title: string;
  standfirst: string;
  subject: Subject;
  sections: Section[];
  lastError: string;
}

export interface Status {
  date: string;
  stage: Stage;
  done: boolean;
  busy: boolean;
  failed: boolean;
  unitsDone: number;
  unitsTotal: number;
  nextLabel: string;
  error: string;
  retryInMs: number;
}

export interface AdvanceOpts { maxUnits?: number; deadlineMs?: number }

// ---------------------------------------------------------------------------------------------
// Tunables

const PROVIDER = 'Ollama';         // must match the AI Provider profile name in Loom Settings
const MODEL = 'gpt-oss:120b';
const PLAN_TOKENS = 3000;
const SECTION_TOKENS = 6000;
const SOURCE_CHARS = 1500;         // per source, truncated at ingest so prompts never need trimming
const SOURCES_PER_SECTION = 6;
const MAX_SOURCES = 30;
const WIKI_UA = 'LoomDailyBuilding/1.0 (personal Loom automation; contact via github.com/loom)';

// Must exceed the worst single unit. Loom.network.fetch exposes no timeout option and URLSession's
// own 60s is unreachable from JS, so a hung unit can run for a minute; two of those is the floor.
const LEASE_MS = 150_000;

const NEXT: Record<string, Stage> = {
  pick: 'plan', plan: 'research', research: 'write', write: 'illustrate', illustrate: 'done',
};

// Failure is a flag, not a stage. Overwriting `stage` with 'failed' would lose the position a
// retry needs to resume from — a run that died on section 5 of 7 would restart from the plan.
function isTerminal(row: Row): boolean {
  return row.stage === 'done' || !!row.failed;
}

type Exhausted = 'retry' | 'skip' | 'fail';
const POLICY: Record<string, { max: number; onExhausted: Exhausted }> = {
  pick: { max: 99, onExhausted: 'retry' },        // unreadable corpus == transient iCloud eviction
  plan: { max: 5, onExhausted: 'fail' },          // no plan, no article
  research: { max: 3, onExhausted: 'skip' },      // 4 of 6 searches is still an article
  write: { max: 4, onExhausted: 'skip' },         // drop the section, keep the article
  illustrate: { max: 2, onExhausted: 'skip' },    // an unillustrated section is fine
};

// ---------------------------------------------------------------------------------------------
// Dates

export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function today(): string {
  return localDate(new Date());
}

// ---------------------------------------------------------------------------------------------
// Model access
//
// Loom.ai.complete concatenates the model's chain-of-thought into the returned string —
// AIClient.swift appends `reasoning`/`reasoning_content` deltas as plain .text alongside content,
// and AIBridge collects every chunk into one string. gpt-oss always emits reasoning. So every
// reply is <thinking><answer> with no separator. Sentinels are not a nicety here: without them,
// chain-of-thought lands in the published article and no JSON ever parses.

function lastBlock(text: string, tag: string): { body: string; closed: boolean } | null {
  const open = `<<<${tag}`;
  const close = `${tag}>>>`;
  // Last, not first: the reasoning trace routinely quotes the sentinel while planning its answer.
  const o = text.lastIndexOf(open);
  if (o === -1) return null;
  const rest = text.slice(o + open.length);
  const c = rest.indexOf(close);
  return c === -1
    ? { body: rest.trim(), closed: false }
    : { body: rest.slice(0, c).trim(), closed: true };
}

// Forward scan tracking string state, returning the last balanced top-level {...}. Supersedes a
// naive first-{ to last-} slice, which mangles any reply containing prose braces.
function lastBalancedObject(text: string): string | null {
  let depth = 0, start = -1, inStr = false, esc = false;
  let best: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) best = text.slice(start, i + 1);
    }
  }
  return best;
}

export function extractJSON(text: string): string | null {
  const block = lastBlock(text, 'JSON');
  if (block && block.body) {
    const inner = lastBalancedObject(block.body);
    if (inner) return inner;
  }
  const fences = String(text).match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fences && fences.length) {
    const body = fences[fences.length - 1].replace(/```(?:json)?/g, '').replace(/```/g, '');
    const inner = lastBalancedObject(body);
    if (inner) return inner;
  }
  return lastBalancedObject(text);
}

const JSON_RULES = [
  'Reasoning: low',
  'Output the JSON object and nothing else after it.',
  'Wrap it exactly like this, on its own lines:',
  '<<<JSON',
  '{ ... }',
  'JSON>>>',
].join('\n');

export async function askJSON(prompt: string, role: string, attempt: number): Promise<any> {
  const nudge = attempt > 0
    ? '\n\nYour previous reply was not valid JSON. Output ONLY the JSON block, nothing else.'
    : '';
  const raw = await Loom.ai.complete(prompt + nudge, {
    provider: PROVIDER,
    model: MODEL,
    maxTokens: PLAN_TOKENS,
    instructions: `${role}\n${JSON_RULES}`,
  });
  const candidate = extractJSON(raw);
  if (!candidate) throw new Error('model reply contained no JSON object');
  try {
    return JSON.parse(candidate);
  } catch (e: any) {
    throw new Error(`model reply was not valid JSON: ${e.message}`);
  }
}

// Prose comes back inside a JSON envelope rather than between prose sentinels, and that is not a
// stylistic choice — it is the fix for a reproducible failure.
//
// Loom.ai.complete concatenates chain-of-thought into the returned string, so SOMETHING has to
// mark where the answer starts. gpt-oss obeys the `<<<JSON … JSON>>>` wrapper every single time,
// because a structured request reads as part of the task. Asked to wrap *prose* the same way, it
// writes a perfectly good article and silently omits the wrapper — verified live: finish_reason
// "stop", 1404 characters of clean copy, no sentinel anywhere. Every write unit then failed, which
// stalled the whole article at the research/write boundary.
//
// So: reuse the mechanism the model actually honours.
const PROSE_RULES = [
  'Reasoning: low',
  'Reply with a single JSON object and nothing else after it, wrapped exactly like this:',
  '<<<JSON',
  '{ "body": "the markdown article text" }',
  'JSON>>>',
  'The "body" value is a JSON string: escape newlines as \\n and double quotes as \\".',
].join('\n');

export async function askProse(prompt: string, role: string): Promise<string> {
  return parseProse(await Loom.ai.complete(prompt, {
    provider: PROVIDER,
    model: MODEL,
    maxTokens: SECTION_TOKENS,
    instructions: `${role}\n${PROSE_RULES}`,
  }));
}

// Every prompt in one batch. Loom.ai.complete blocks the script thread, so seven sequential
// section-writes cost the sum of their latencies — 67s measured, against 20s this way (ADR-025).
//
// Returns '' for any prompt that failed or came back unparseable, positionally. The caller decides
// what to do about the gaps; nothing here throws, because one bad section must not discard six
// good ones.
export async function askProseAll(prompts: string[], role: string): Promise<string[]> {
  if (!prompts.length) return [];
  const replies = await Loom.ai.completeAll(prompts, {
    provider: PROVIDER,
    model: MODEL,
    maxTokens: SECTION_TOKENS,
    instructions: `${role}\n${PROSE_RULES}`,
  });
  return replies.map((reply: any, i: number) => {
    if (reply.error) {
      Loom.log.warn(`askProseAll[${i}]: ${reply.error}`);
      return '';
    }
    try {
      return parseProse(reply.text);
    } catch (e: any) {
      Loom.log.warn(`askProseAll[${i}]: ${e.message}`);
      return '';
    }
  });
}

function parseProse(raw: string): string {
  const candidate = extractJSON(raw);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) return parsed.body.trim();
    } catch {
      // fall through to the salvage paths — a body full of quotes is the likely cause
    }
  }

  // The model used prose sentinels after all. Cheap to honour, and it costs a unit not to.
  const block = lastBlock(raw, 'ARTICLE');
  if (block && block.body) return trimToWholeParagraph(block.body, block.closed);

  // Last resort: the envelope opened but the JSON never closed — almost always maxTokens, since
  // reasoning spends the same budget. Retrying reproduces the identical truncation, so salvage
  // what arrived instead of burning four attempts on a guaranteed failure.
  const opened = raw.lastIndexOf('"body"');
  if (opened !== -1) {
    const quote = raw.indexOf('"', raw.indexOf(':', opened) + 1);
    if (quote !== -1) {
      const tail = raw.slice(quote + 1).replace(/"\s*\}?\s*(?:JSON>>>)?\s*$/, '');
      const unescaped = tail
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (unescaped.trim()) {
        Loom.log.warn('askProse: reply truncated, salvaging the complete paragraphs');
        return trimToWholeParagraph(unescaped, false);
      }
    }
  }

  throw new Error('model reply contained no usable article body');
}

function trimToWholeParagraph(text: string, closed: boolean): string {
  if (closed) return text.trim();
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length > 1) paras.pop();
  const out = paras.join('\n\n').trim();
  if (!out) throw new Error('truncated reply had no complete paragraph');
  return out;
}

// ---------------------------------------------------------------------------------------------
// Network

// Cached per run only — each run gets a fresh JSContext, so this is a within-run memo, not state.
let cachedKey = '';

export async function ollamaKey(): Promise<string> {
  if (cachedKey) return cachedKey;
  let raw: string;
  try {
    raw = await Loom.files.read('secrets.json');
  } catch {
    throw new Error('secrets.json unreadable — it may still be downloading from iCloud');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('secrets.json is not valid JSON yet — it may be mid-sync');
  }
  const key = String((parsed && parsed.ollama) || '').trim();
  if (!key) throw new Error('secrets.json has no "ollama" key — add it in the Loom editor');
  cachedKey = key;
  return key;
}

// Loom.network.fetch does NOT throw on non-2xx. Parsing a 429 body succeeds, `results` comes back
// undefined, and the stage advances with zero sources — producing a thin, confident article with
// no error anywhere. Every call site must check res.ok first.
async function postJSON(url: string, key: string, payload: object, label: string): Promise<any> {
  const res = await Loom.network.fetch(url, {
    method: 'POST',
    // Every value must be a string: one non-string drops the WHOLE headers object silently.
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${String(res._body).slice(0, 200)}`);
  return JSON.parse(res._body);
}

async function getJSON(url: string, label: string): Promise<any> {
  // Wikimedia 403s requests with a default user agent.
  const res = await Loom.network.fetch(url, {
    headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  return JSON.parse(res._body);
}

function toSources(payload: any): Source[] {
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return results
    .map((r: any) => ({
      title: String(r.title || '').slice(0, 200),
      url: String(r.url || ''),
      content: String(r.content || '').slice(0, SOURCE_CHARS),
    }))
    .filter((s: Source) => s.url && s.content);
}

// Every query in one batch. Loom.network.fetch blocks the script thread, so six sequential
// searches cost the sum of their latencies (~5.6s measured) and Promise.all cannot help — see
// ADR-025. fetchAll overlaps them for roughly the cost of the slowest.
//
// Returns per-query results so a partial failure keeps the searches that did land.
export async function webSearchAll(queries: string[], maxResults: number): Promise<(Source[] | null)[]> {
  const key = await ollamaKey();
  const responses = await Loom.network.fetchAll(queries.map((query) => ({
    url: 'https://ollama.com/api/web_search',
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: Math.min(maxResults, 10) }),
  })));

  const errors: string[] = [];
  const out = responses.map((res: any, i: number) => {
    const fail = (message: string) => {
      Loom.log.warn(`web_search "${queries[i]}": ${message}`);
      errors.push(message);
      return null;
    };
    if (res.error) return fail(res.error);
    // Non-2xx does not reject, and a 429 body parses perfectly well into an object with no
    // `results` — which would look like "this query found nothing" rather than a failure.
    if (!res.ok) return fail(`HTTP ${res.status}: ${String(res._body).slice(0, 120)}`);
    try {
      return toSources(JSON.parse(res._body));
    } catch (e: any) {
      return fail(`unparseable response: ${e.message}`);
    }
  });

  // Batching would otherwise destroy error classification. If every query failed, the caller has
  // to see WHY — a generic "they all failed" classifies as an ordinary retryable error, which on a
  // plane burns the attempt budget in one second, and against a bad key retries forever instead of
  // stopping. Re-throwing the first underlying message keeps classify() working.
  if (queries.length && out.every((x) => x === null)) {
    throw new Error(errors[0] || 'every web search failed');
  }
  return out;
}

// Every section's image in ONE request.
//
// The obvious implementation — list=search then a REST summary, per section — is 14 round trips
// and measured 3.8s. The Action API takes up to 50 titles at once and returns pageimages for all
// of them: 0.19s, and it resolved 7/7 model-generated titles in testing. Since bridge calls are
// strictly serial (NetworkBridge blocks the script thread on a semaphore and hands back an
// already-settled promise, so Promise.all buys nothing), collapsing round trips is the only
// speed-up available anywhere in this file.
//
// A title the model invented comes back `missing` and that section simply goes unillustrated.
export async function wikiImages(queries: string[]): Promise<Record<string, { url: string; page: string }>> {
  const wanted = queries.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 50);
  if (!wanted.length) return {};

  const data = await getJSON(
    'https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=original%7Cthumbnail'
      + '&pithumbsize=960&format=json&redirects=1&titles='
      + wanted.map(encodeURIComponent).join('%7C'),
    'wiki pageimages',
  );

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
    const thumb = page.thumbnail && page.thumbnail.source;
    const full = page.original && page.original.source;
    // Prefer the 960px thumbnail: `original` can be a 40 MP TIFF-scale JPEG that stalls the sheet.
    const url = String(thumb || full || '');
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
// Source selection and citation hygiene

function tokens(s: string): string[] {
  return String(s).toLowerCase().match(/[a-z]{4,}/g) || [];
}

// Token-set overlap. Deliberately not embeddings and not Loom.ai.search: the latter is the
// on-device Apple model and would add a blocking bridge call per section for a ranking that a
// dozen lines gets close enough on.
export function selectSources(sources: Source[], section: { heading: string; angle: string }): Source[] {
  const want = new Set(tokens(`${section.heading} ${section.angle}`));
  if (!want.size) return sources.slice(0, SOURCES_PER_SECTION);
  const scored = sources.map((s, i) => {
    const have = new Set(tokens(`${s.title} ${s.content.slice(0, 300)}`));
    let hits = 0;
    want.forEach((w) => { if (have.has(w)) hits++; });
    return { s, hits, i };
  });
  scored.sort((a, b) => (b.hits - a.hits) || (a.i - b.i));
  return scored.slice(0, SOURCES_PER_SECTION).map((x) => x.s);
}

// Citation hygiene. A hallucinated URL inside something that looks like journalism is the worst
// output this can produce, so links are checked against the sources the section was actually
// given; unknown hrefs keep their text and lose the link.
//
// The second pass handles the marker styles the model reaches for when it wants to cite but has
// not been given a link to use — observed live: 【2】. There is no footnote list to resolve them
// against, so they would render as literal junk mid-sentence.
export function stripUnknownLinks(markdown: string, allowed: Source[]): string {
  const ok = new Set(allowed.map((s) => s.url));
  return String(markdown)
    // FIRST, before anything reads a bracket. The model starts a section emitting proper
    // [text](url) and partway through drifts into fullwidth CJK brackets — 【text】(url) — which
    // marked does not recognise as a link, so it renders the brackets literally in the middle of
    // the article. Normalising them back to ASCII repairs the link instead of deleting it, and
    // makes a 【2】 citation marker fall through to the numeric rules below like any other.
    .replace(/[【〔［]/g, '[')
    .replace(/[】〕］]/g, ']')
    .replace(/\[([^\]]*)\]\s*[（(]\s*(https?:\/\/[^)）\s]+)[^)）]*[)）]/g, (whole, text, href) =>
      ok.has(href) ? `[${text}](${href})` : text)
    // Anything still bracketed that never became a link: numeric citation markers with no
    // footnote list to resolve against.
    .replace(/\[\^\d+\]/g, '')                          // [^2] footnote refs
    .replace(/\[\d+(?:\s*[,，]\s*\d+)*\](?!\()/g, '')    // bare [2], [1,3] — never a real link
    .replace(/[ \t]+([.,;:!?])/g, '$1')                 // tidy the space a removed marker leaves
    .replace(/[ \t]{2,}/g, ' ');
}

// marked does not sanitise, and the sheet has no CSP. Section bodies are model output derived from
// arbitrary web pages, so this closes the path from a prompt-injected page into the web view.
export function sanitiseMarkdown(markdown: string): string {
  return String(markdown)
    .replace(/<\s*\/?\s*(script|iframe|object|embed|style)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=/gi, ' data-blocked=')
    .replace(/javascript:/gi, '');
}

// ---------------------------------------------------------------------------------------------
// Error classification
//
// On a plane, five fetch rejections arrive inside a second. Counting those against a stage's
// attempt budget would exhaust it for an entirely transient reason, so transport failures back off
// without incrementing. Getting this wrong is easy precisely because the retry machinery *looks*
// like it already handles it.

type Kind = 'transient' | 'rateLimited' | 'hard' | 'normal';

export function classify(message: string): Kind {
  const m = String(message);
  if (/offline|Internet connection|network connection|hostname|timed out|not connected/i.test(m)) return 'transient';
  if (/still downloading from iCloud|mid-sync|not valid JSON yet/i.test(m)) return 'transient';
  if (/HTTP (429|5\d\d)/.test(m)) return 'rateLimited';
  if (/HTTP (401|403)/.test(m) || /no "ollama" key/.test(m)) return 'hard';
  // Verbatim from AIBridge.AIError and AIClient.ClientError — every one of these fails identically
  // on every subsequent unit, so there is nothing to gain by retrying.
  if (/no ai provider named|no api key stored|invalid provider base url|not available on this device/i.test(m)) {
    return 'hard';
  }
  return 'normal';
}

// ---------------------------------------------------------------------------------------------
// Row access

type Row = Record<string, any>;

function nowISO(): string { return new Date().toISOString(); }

function parse<T>(value: any, fallback: T): T {
  try {
    const out = JSON.parse(String(value || ''));
    return out === null || out === undefined ? fallback : out;
  } catch {
    return fallback;
  }
}

// Every column, every time. ScriptDB freezes column types on the first insert and rowToDict drops
// NULLs entirely, so a partial row means missing keys on read and an update against a column that
// does not exist.
function newRow(recipe: Recipe, date: string): Row {
  return {
    date,
    stage: 'pick',
    liked: 0,
    failed: 0,
    subjectId: '',
    title: '',
    standfirst: '',
    subject: '{}',
    queries: '[]',
    sources: '[]',
    sections: '[]',
    cursor: 0,
    unitsDone: 0,
    unitsTotal: 3 + recipe.searches + recipe.sections,
    attempts: 0,
    retryAfter: 0,
    lastError: '',
    lockedUntil: 0,
    notifiedAt: '',
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
}

// There is no unique constraint reachable through the bridge, so two runs that both see no row for
// today can both insert. De-dupe on every read — it rides along on a select we were doing anyway.
async function loadRow(t: any, date: string): Promise<Row | null> {
  const rows: Row[] = await t.select({ date });
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const keep = rows.reduce((a, b) => (a.id < b.id ? a : b));
  for (const r of rows) if (r.id !== keep.id) await t.delete({ id: r.id });
  Loom.log.warn(`Daily Building: removed ${rows.length - 1} duplicate row(s) for ${date}`);
  return keep;
}

async function ensure(t: any, recipe: Recipe, date: string): Promise<Row> {
  const existing = await loadRow(t, date);
  if (existing) return existing;
  await t.insert(newRow(recipe, date));
  const created = await loadRow(t, date);
  if (!created) throw new Error(`could not create article row for ${date}`);
  return created;
}

// ScriptDB.update is a single `UPDATE ... WHERE col = ?` returning changesCount, which makes this a
// genuine compare-and-swap: two racers both read `prev`, the winner's write makes the loser's WHERE
// match nothing, and the loser gets 0 back.
async function claim(t: any, row: Row): Promise<number | null> {
  const now = Date.now();
  const prev = row.lockedUntil || 0;
  if (prev > now) return null;
  const mine = now + LEASE_MS;
  const won = await t.update({ id: row.id, lockedUntil: prev }, { lockedUntil: mine });
  return won === 1 ? mine : null;
}

// Every persisting write carries the lease in its WHERE clause, so a unit that overran its lease
// (another run took over) discards its result instead of clobbering fresher work.
async function save(t: any, row: Row, mine: number, values: Row): Promise<boolean> {
  const wrote = await t.update(
    { id: row.id, lockedUntil: mine },
    { ...values, updatedAt: nowISO() },
  );
  if (wrote !== 1) Loom.log.warn(`Daily Building: lost lease mid-unit on ${row.date}, discarding result`);
  return wrote === 1;
}

async function release(t: any, id: number, mine: number): Promise<void> {
  await t.update({ id, lockedUntil: mine }, { lockedUntil: 0 });
}

// ---------------------------------------------------------------------------------------------
// Units

// research, write and illustrate each resolve their whole stage in one batched call, so every
// stage is now a single cursor step. unitsTotal still counts *items* rather than stages, so the
// progress bar keeps its resolution — stepCursor credits the batch size instead of 1.
function unitTotal(_row: Row): number {
  return 1;
}

// Shared by success and by a 'skip' exhaustion, so both paths move the cursor identically.
function stepCursor(row: Row, units = 1): Row {
  const total = unitTotal(row);
  const cursor = (row.cursor || 0) + 1;
  const unitsDone = (row.unitsDone || 0) + units;
  if (cursor < total) return { cursor, unitsDone, attempts: 0, retryAfter: 0 };
  const stage = NEXT[row.stage] || 'done';
  const out: Row = { cursor: 0, unitsDone, stage, attempts: 0, retryAfter: 0 };
  // Sources are ~45 KB of truncated page text per article and are never read again once every
  // section is written. Dropping them is what makes "keep liked articles forever" free.
  if (stage === 'done') out.sources = '[]';
  return out;
}

const UNITS: Record<string, (r: Recipe, t: any, row: Row, mine: number) => Promise<void>> = {
  async pick(recipe, t, row, mine) {
    const subject = await recipe.pick(row.date);
    await save(t, row, mine, {
      subject: JSON.stringify(subject),
      subjectId: String(subject.id || ''),
      title: String(subject.title || ''),
      ...stepCursor(row),
    });
  },

  async plan(recipe, t, row, mine) {
    const subject = parse<Subject>(row.subject, {} as Subject);
    const plan = await recipe.plan(subject, row.attempts || 0);
    const sections: Section[] = plan.sections.map((s) => ({
      heading: String(s.heading || '').slice(0, 120),
      angle: String(s.angle || '').slice(0, 400),
      imageQuery: String(s.imageQuery || '').slice(0, 120),
      body: '',
      imageUrl: '',
      imagePage: '',
    }));
    const queries = plan.queries.map((q) => String(q).slice(0, 300)).filter(Boolean);
    await save(t, row, mine, {
      title: String(plan.title || row.title).slice(0, 200),
      standfirst: String(plan.standfirst || '').slice(0, 500),
      queries: JSON.stringify(queries),
      sections: JSON.stringify(sections),
      // Correct the estimate now that the real counts are known.
      unitsTotal: 3 + queries.length + sections.length,
      ...stepCursor(row),
    });
  },

  // All six searches in one batch. A query that fails is dropped rather than retried: five good
  // searches is an article, and the write stage is where the time actually goes.
  async research(recipe, t, row, mine) {
    const queries = parse<string[]>(row.queries, []);
    const batches = await webSearchAll(queries, 6);
    const sources = parse<Source[]>(row.sources, []);
    const seen = new Set(sources.map((s) => s.url));
    for (const batch of batches) {
      for (const s of batch || []) {
        if (sources.length >= MAX_SOURCES) break;
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        sources.push(s);
      }
    }
    await save(t, row, mine, {
      sources: JSON.stringify(sources),
      ...stepCursor(row, queries.length),
    });
  },

  // All seven sections in one batch — 67s of sequential completions becomes ~20s (ADR-025).
  //
  // Only sections still missing a body are requested, so a retry after a partial failure re-runs
  // just the ones that failed rather than paying for the whole article again.
  async write(recipe, t, row, mine) {
    const sections = parse<Section[]>(row.sections, []);
    const sources = parse<Source[]>(row.sources, []);
    const subject = parse<Subject>(row.subject, {} as Subject);

    const pending = sections
      .map((section, index) => ({ section, index }))
      .filter((x) => !x.section.body);
    if (!pending.length) {
      await save(t, row, mine, stepCursor(row, 0));
      return;
    }

    const chosenFor = pending.map((x) => selectSources(sources, x.section));
    const written = await recipe.writeAll(pending.map((x, i) => ({
      subject,
      title: row.title,
      standfirst: row.standfirst,
      sections,
      index: x.index,
      sources: chosenFor[i],
      // Continuity without an extra call. Empty on the first pass of a batch, since neighbouring
      // sections are being written at the same moment — the shared outline carries the load.
      previous: x.index > 0 ? firstSentence(sections[x.index - 1].body) : '',
    })));

    let filled = 0;
    written.forEach((text, i) => {
      if (!text) return;
      sections[pending[i].index].body = stripUnknownLinks(sanitiseMarkdown(text), chosenFor[i]);
      filled++;
    });

    // Persist before deciding, so a partial batch is never thrown away — recordFailure's own save
    // only touches the retry columns.
    await save(t, row, mine, {
      sections: JSON.stringify(sections),
      ...(filled === pending.length ? stepCursor(row, pending.length) : { unitsDone: (row.unitsDone || 0) + filled }),
    });
    if (filled < pending.length) {
      throw new Error(`${pending.length - filled} of ${pending.length} sections failed to write`);
    }
  },

  // One unit for the whole article, not one per section — see wikiImages.
  async illustrate(recipe, t, row, mine) {
    const sections = parse<Section[]>(row.sections, []);
    try {
      const found = await wikiImages(sections.map((s) => s.imageQuery || s.heading));
      const used = new Set<string>();
      for (const section of sections) {
        const hit = found[(section.imageQuery || section.heading).trim()];
        if (!hit || used.has(hit.url)) continue;
        used.add(hit.url);
        section.imageUrl = hit.url;
        section.imagePage = hit.page;
      }
    } catch (e: any) {
      // An unillustrated article is fine; failing one over missing pictures is not.
      Loom.log.warn(`Daily Building: image lookup failed: ${e.message}`);
    }
    await save(t, row, mine, { sections: JSON.stringify(sections), ...stepCursor(row) });
  },
};

function firstSentence(text: string): string {
  const clean = String(text).replace(/[#*_`>]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^.{20,300}?[.!?](\s|$)/);
  return (m ? m[0] : clean.slice(0, 220)).trim();
}

async function recordFailure(t: any, row: Row, mine: number, err: any): Promise<void> {
  const msg = String((err && err.message) || err).slice(0, 400);
  const kind = classify(msg);
  const policy = POLICY[row.stage] || { max: 3, onExhausted: 'fail' as Exhausted };
  Loom.log.warn(`Daily Building ${row.date} ${row.stage}[${row.cursor}] ${kind}: ${msg}`);

  // Nothing downstream will work either — a wrong provider name or a bad key fails identically on
  // every subsequent unit, so burning the whole budget discovering that helps nobody.
  if (kind === 'hard') {
    await save(t, row, mine, { failed: 1, lastError: msg, retryAfter: 0 });
    return;
  }

  const attempts = kind === 'transient' ? (row.attempts || 0) : (row.attempts || 0) + 1;

  if (kind !== 'transient' && attempts >= policy.max) {
    if (policy.onExhausted === 'fail') {
      await save(t, row, mine, { failed: 1, lastError: msg, attempts, retryAfter: 0 });
      return;
    }
    if (policy.onExhausted === 'skip') {
      Loom.log.warn(`Daily Building ${row.date}: skipping ${row.stage}[${row.cursor}] after ${attempts} attempts`);
      await save(t, row, mine, { lastError: msg, ...stepCursor(row) });
      return;
    }
  }

  const backoff = kind === 'rateLimited'
    ? 60_000
    : Math.min(60_000, Math.pow(2, Math.max(attempts, 1)) * 2000);
  await save(t, row, mine, { attempts, retryAfter: Date.now() + backoff, lastError: msg });
}

// ---------------------------------------------------------------------------------------------
// Status

function label(row: Row): string {
  if (row.failed) return row.lastError ? `Stopped: ${row.lastError}` : 'Stopped';
  const sections = parse<Section[]>(row.sections, []);
  const queries = parse<string[]>(row.queries, []);
  const n = (row.cursor || 0) + 1;
  switch (row.stage) {
    case 'pick': return 'Choosing today’s subject…';
    case 'plan': return 'Planning the article…';
    case 'research': return `Researching ${queries.length || 6} threads at once…`;
    case 'write': {
      const left = sections.filter((x) => !x.body).length || sections.length;
      return `Writing ${left} section${left === 1 ? '' : 's'} at once…`;
    }
    case 'illustrate': return 'Finding pictures…';
    case 'done': return 'Ready';
    default: return 'Working…';
  }
}

function status(row: Row, busy = false): Status {
  return {
    date: row.date,
    stage: row.stage,
    done: row.stage === 'done',
    busy,
    failed: !!row.failed,
    unitsDone: row.unitsDone || 0,
    unitsTotal: Math.max(row.unitsTotal || 1, row.unitsDone || 1),
    // Describes the unit ABOUT to run, not the one that just finished — the user stares at this
    // label for the whole 5-20s duration of the next unit.
    nextLabel: label(row),
    error: row.lastError || '',
    retryInMs: Math.max(0, (row.retryAfter || 0) - Date.now()),
  };
}

// ---------------------------------------------------------------------------------------------
// Public API

export async function advance(recipe: Recipe, date: string, opts: AdvanceOpts = {}): Promise<Status> {
  const maxUnits = opts.maxUnits === undefined ? Infinity : opts.maxUnits;
  const deadlineMs = opts.deadlineMs === undefined ? 20_000 : opts.deadlineMs;
  const started = Date.now();
  const t = Loom.db.table(recipe.table);

  let row = await ensure(t, recipe, date);
  if (isTerminal(row)) return status(row);

  const mine = await claim(t, row);
  if (mine === null) return status(row, true);

  let units = 0;
  try {
    while (units < maxUnits && !isTerminal(row)) {
      if ((row.retryAfter || 0) > Date.now()) break;
      const unit = UNITS[row.stage];
      if (!unit) break;
      try {
        await unit(recipe, t, row, mine);
      } catch (e) {
        await recordFailure(t, row, mine, e);
        // Never burn a whole deadline looping on a failure — back off and let the next call retry.
        row = (await loadRow(t, date)) || row;
        break;
      }
      units++;
      row = (await loadRow(t, date)) || row;
      // Checked after the unit, so every call makes at least one unit of progress.
      if (Date.now() - started >= deadlineMs) break;
    }
  } finally {
    await release(t, row.id, mine);
  }
  return status(row);
}

export async function read(recipe: Recipe, date: string): Promise<Article | null> {
  const row = await loadRow(Loom.db.table(recipe.table), date);
  if (!row) return null;
  return {
    date: row.date,
    stage: row.stage,
    liked: !!row.liked,
    failed: !!row.failed,
    title: row.title || '',
    standfirst: row.standfirst || '',
    subject: parse<Subject>(row.subject, {} as Subject),
    sections: parse<Section[]>(row.sections, []),
    lastError: row.lastError || '',
  };
}

// Clears the failure flag without touching stage or cursor, so a run that died writing section 5
// resumes at section 5 rather than starting over.
export async function retry(recipe: Recipe, date: string): Promise<void> {
  await Loom.db.table(recipe.table).update({ date }, { failed: 0, attempts: 0, retryAfter: 0, lastError: '' });
}

export async function progress(recipe: Recipe, date: string): Promise<Status | null> {
  const row = await loadRow(Loom.db.table(recipe.table), date);
  return row ? status(row, (row.lockedUntil || 0) > Date.now()) : null;
}

export async function setLiked(recipe: Recipe, date: string, liked: boolean): Promise<boolean> {
  await Loom.db.table(recipe.table).update({ date }, { liked: liked ? 1 : 0 });
  return liked;
}

export async function listLiked(recipe: Recipe): Promise<Article[]> {
  const rows: Row[] = await Loom.db.table(recipe.table).select({ liked: 1 });
  return rows
    .map((row) => ({
      date: row.date,
      stage: row.stage as Stage,
      liked: true,
      failed: !!row.failed,
      title: row.title || '',
      standfirst: row.standfirst || '',
      subject: parse<Subject>(row.subject, {} as Subject),
      sections: [] as Section[],
      lastError: '',
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function remove(recipe: Recipe, date: string): Promise<void> {
  await Loom.db.table(recipe.table).delete({ date });
}

// Liked articles are kept forever; everything else is a day's reading. select() does the coarse
// filter in SQL and the date comparison is a string compare, which is correct for YYYY-MM-DD.
export async function prune(recipe: Recipe, keepDays: number): Promise<number> {
  const t = Loom.db.table(recipe.table);
  const cutoff = localDate(new Date(Date.now() - keepDays * 86_400_000));
  const rows: Row[] = await t.select({ liked: 0 });
  let removed = 0;
  for (const r of rows) {
    if (r.date < cutoff && r.date !== today()) {
      await t.delete({ id: r.id });
      removed++;
    }
  }
  if (removed) Loom.log.info(`Daily Building: pruned ${removed} unliked article(s) older than ${keepDays} days`);
  return removed;
}

// Idempotent under overlapping runs, which is why notifiedAt is a column rather than a comparison
// of the stage before and after.
export async function notifyOnce(recipe: Recipe, date: string): Promise<void> {
  const t = Loom.db.table(recipe.table);
  const row = await loadRow(t, date);
  if (!row || row.stage !== 'done' || row.notifiedAt) return;

  // A build that finishes at 03:00 must not buzz at 03:00. Note that an omitted or unparseable
  // trigger date silently means "five seconds from now", so the date has to be valid and future.
  const at = new Date();
  at.setHours(7, 0, 0, 0);
  const trigger = at.getTime() > Date.now() + 60_000 ? { date: at.toISOString() } : undefined;

  await Loom.notify.schedule({
    title: 'Today’s building',
    body: `${row.title} — ${parse<Subject>(row.subject, {} as Subject).author || ''}`.trim(),
    trigger,
  });
  await t.update({ id: row.id }, { notifiedAt: nowISO() });
}
