#!/usr/bin/env node
// The gate between an agent's draft and the phone.
//
//   node tools/validate.mjs daily/poem/2026-08-18.json
//
// Reports EVERY failure rather than the first, so a fix pass can be a single edit. Exit 0 means
// the file is safe to commit.
//
// This is not a style critic — it only enforces things that are objectively checkable and that
// would otherwise become someone's bad morning: a hallucinated citation, an image pointed at an
// arbitrary host, a subject the model rewrote, a script tag heading for a web view with no CSP.
// The one taste rule here (BANNED) is the handful of phrases that reliably signal filler.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pick, KINDS } from './pick.mjs';

const SECTIONS_MIN = 5;
const SECTIONS_MAX = 8;
const BODY_MIN = 200;          // a section thinner than this is a stub, not a section
const BODY_TOTAL_MAX = 40_000; // runaway guard
const SOURCES_MIN = 2;

// Hotlinked straight into the sheet, so the host list is a security control, not tidiness.
const IMAGE_DOMAINS = ['wikimedia.org', 'wikipedia.org', 'wikiart.org'];

const DANGEROUS = [
  [/<\s*\/?\s*(script|iframe|object|embed)\b/i, 'embedded script/frame tag'],
  [/javascript:/i, 'javascript: URL'],
  [/\son\w+\s*=/i, 'inline event handler'],
];

const BANNED = [
  [/\bdelve\b/i, 'delve'],
  [/\btapestry\b/i, 'tapestry'],
  [/\bnestled\b/i, 'nestled'],
  [/stands? as a testament\b/i, 'stands as a testament'],
  [/\bit(?:'s| is) worth noting\b/i, "it's worth noting"],
  [/\bin conclusion\b/i, 'in conclusion'],
  [/\bat the end of the day\b/i, 'at the end of the day'],
];

const LABEL_HEADINGS = /^(background|introduction|overview|conclusion|context|analysis|summary|history)$/i;

// Key-sorted so a re-serialised subject with shuffled keys still compares equal — the check is
// about content, not formatting.
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  }
  return v;
}

function urlsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/https?:\/\/[^\s)<>"'\]]+/g)) {
    out.push(m[0].replace(/[.,;:!?]+$/, ''));
  }
  return out;
}

function hostAllowed(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return IMAGE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export function validate(path) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return [`not valid JSON: ${e.message}`];
  }

  // --- envelope ---------------------------------------------------------------------------
  if (doc.schemaVersion !== 1) fail(`schemaVersion must be 1, got ${JSON.stringify(doc.schemaVersion)}`);
  if (!KINDS[doc.kind]) fail(`kind must be one of ${Object.keys(KINDS).join(', ')}, got ${JSON.stringify(doc.kind)}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.date))) fail(`date must be YYYY-MM-DD, got ${JSON.stringify(doc.date)}`);

  const fromName = basename(path).replace(/\.json$/, '');
  if (doc.date !== fromName) fail(`date "${doc.date}" does not match the filename "${fromName}.json"`);

  // --- subject: re-derived, never trusted --------------------------------------------------
  if (KINDS[doc.kind] && /^\d{4}-\d{2}-\d{2}$/.test(String(doc.date))) {
    const expected = canon(pick(doc.kind, doc.date));
    if (JSON.stringify(canon(doc.subject)) !== JSON.stringify(expected)) {
      fail(
        'subject does not match tools/pick.mjs for this date — do not edit or retype it. '
        + `Re-run: node tools/pick.mjs ${doc.kind} ${doc.date} --stub ${path}`,
      );
    }
  }

  // --- headline and deck -------------------------------------------------------------------
  const title = String(doc.title || '');
  if (title.length < 8 || title.length > 120) fail(`title must be 8–120 chars, got ${title.length}`);
  if (doc.subject && title.trim().toLowerCase() === String(doc.subject.title || '').trim().toLowerCase()) {
    fail('title is just the subject\'s own title — write a magazine headline for the feature');
  }
  const standfirst = String(doc.standfirst || '');
  if (standfirst.length < 20 || standfirst.length > 400) {
    fail(`standfirst must be 20–400 chars, got ${standfirst.length}`);
  }

  // --- sources -----------------------------------------------------------------------------
  const sources = Array.isArray(doc.sources) ? doc.sources : [];
  if (sources.length < SOURCES_MIN) fail(`sources must list at least ${SOURCES_MIN} entries you actually read`);
  const allowed = new Set();
  sources.forEach((s, i) => {
    if (!s || !String(s.title || '').trim()) fail(`sources[${i}] has no title`);
    const url = String((s && s.url) || '');
    if (!/^https:\/\//.test(url)) fail(`sources[${i}].url must be an https URL, got ${JSON.stringify(url)}`);
    else allowed.add(url.replace(/[.,;:!?]+$/, ''));
  });

  // --- sections ----------------------------------------------------------------------------
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (sections.length < SECTIONS_MIN || sections.length > SECTIONS_MAX) {
    fail(`sections must number ${SECTIONS_MIN}–${SECTIONS_MAX}, got ${sections.length}`);
  }

  // The feature's own subject, in the forms an imageQuery might name it.
  const subjectNames = new Set(
    [doc.subject?.title, doc.subject?.name]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase()),
  );

  let totalBody = 0;
  const imageQueries = [];
  sections.forEach((s, i) => {
    const at = `sections[${i}]`;
    const heading = String((s && s.heading) || '');
    const body = String((s && s.body) || '');
    totalBody += body.length;

    if (heading.length < 2 || heading.length > 90) fail(`${at}.heading must be 2–90 chars, got ${heading.length}`);
    if (LABEL_HEADINGS.test(heading.trim())) {
      fail(`${at}.heading "${heading}" is a label, not a headline — say what this section argues`);
    }
    if (body.length < BODY_MIN) fail(`${at}.body is ${body.length} chars, under the ${BODY_MIN} minimum`);

    for (const [re, what] of DANGEROUS) if (re.test(body) || re.test(heading)) fail(`${at} contains ${what}`);
    for (const [re, what] of BANNED) if (re.test(body)) fail(`${at}.body uses "${what}" — rewrite the sentence`);

    for (const url of urlsIn(body)) {
      if (!allowed.has(url)) fail(`${at}.body links ${url}, which is not in sources[] — cite only what you read`);
    }

    // Illustration is a Wikipedia article title, resolved on the device — the sandbox cannot reach
    // the Wikipedia API, so a URL written here would be guessed rather than looked up.
    const query = String((s && s.imageQuery) || '').trim();
    if (query) {
      imageQueries.push(query);
      if (query.length > 120) fail(`${at}.imageQuery is ${query.length} chars — use an article title, not a description`);
      if (/^https?:\/\//i.test(query)) fail(`${at}.imageQuery must be a Wikipedia article title, not a URL`);
      if (doc.subject && subjectNames.has(query.toLowerCase())) {
        fail(`${at}.imageQuery is the subject of this feature — the reader is already looking at it`);
      }
    }
    // Tolerated if a run supplies them anyway, but then the host list applies: these are hotlinked
    // straight into a web view.
    for (const [field, url] of [['imageUrl', String((s && s.imageUrl) || '')], ['imagePage', String((s && s.imagePage) || '')]]) {
      if (url && !hostAllowed(url)) fail(`${at}.${field} host is not allowed: ${url}`);
    }
  });

  if (imageQueries.length > 4) {
    fail(`${imageQueries.length} sections carry an imageQuery — use two to four, sparse beats complete`);
  }
  const dupes = imageQueries.filter((q, i) => imageQueries.findIndex((o) => o.toLowerCase() === q.toLowerCase()) !== i);
  if (dupes.length) fail(`imageQuery repeated: ${[...new Set(dupes)].join(', ')}`);
  if (totalBody > BODY_TOTAL_MAX) fail(`total body is ${totalBody} chars, over the ${BODY_TOTAL_MAX} ceiling`);

  // --- provenance --------------------------------------------------------------------------
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(doc.generatedAt || ''))) fail('generatedAt must be an ISO timestamp');
  if (!String(doc.model || '').trim()) fail('model must name the model that wrote this');

  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error('usage: validate.mjs <file.json> [more.json ...]');
    process.exit(2);
  }
  let bad = 0;
  for (const p of paths) {
    let errors;
    try {
      errors = validate(p);
    } catch (e) {
      errors = [`could not validate: ${e.message}`];
    }
    if (errors.length) {
      bad++;
      console.error(`✗ ${p}`);
      for (const e of errors) console.error(`   - ${e}`);
    } else {
      console.log(`✓ ${p}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
