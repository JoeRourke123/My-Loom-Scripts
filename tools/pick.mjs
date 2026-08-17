#!/usr/bin/env node
// Which subject runs on which day — the one decision the writing agent is not allowed to make.
//
// The corpora are written in reading order by the build-*-corpus.py scripts (strands interleaved,
// artists round-robined, buildings dealt into era-strata), so the pick is a plain modulo over a
// pre-permuted file. That buys, for free: determinism for any date past or future, no repeats for
// a full corpus cycle, and the same subject again after a rebuild.
//
//   node tools/pick.mjs poem 2026-08-18            → print the subject as JSON
//   node tools/pick.mjs poem 2026-08-18 --stub out.json → write the article skeleton to fill in
//
// The --stub mode exists so the agent never types the subject at all. validate.mjs re-derives it
// and compares; an agent that "improves" a poem's text fails the build rather than publishing it.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const KINDS = {
  poem: 'poems.jsonl',
  artwork: 'artworks.jsonl',
  building: 'buildings.jsonl',
};

export function dayIndex(date) {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  return Math.floor(t / 86_400_000);
}

// Keep every corpus field and only ADD aliases. views.ts and widget.ts read the raw names
// directly — Artwork uses `art.author`, Building uses `b.name` and `b.architect` — while the
// notification body and the liked index want a generic title/author. Renaming instead of
// aliasing would silently blank half the UI.
function normalise(kind, s) {
  const base = { ...s, id: String(s.id) };
  if (kind === 'artwork') return { ...base, author: s.artist };
  if (kind === 'building') return { ...base, title: s.name, author: s.architect };
  return base;
}

export function pick(kind, date) {
  const file = KINDS[kind];
  if (!file) throw new Error(`unknown kind "${kind}" — expected one of ${Object.keys(KINDS).join(', ')}`);
  const raw = readFileSync(join(HERE, 'corpora', file), 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 1);
  if (!lines.length) throw new Error(`${file} is empty`);
  const i = ((dayIndex(date) % lines.length) + lines.length) % lines.length;
  return normalise(kind, JSON.parse(lines[i]));
}

export function stub(kind, date) {
  return {
    schemaVersion: 1,
    kind,
    date,
    subject: pick(kind, date),
    title: '',
    standfirst: '',
    sections: [],
    sources: [],
    generatedAt: '',
    model: '',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, date, flag, out] = process.argv.slice(2);
  if (!kind || !date) {
    console.error('usage: pick.mjs <poem|artwork|building> <YYYY-MM-DD> [--stub <outfile>]');
    process.exit(2);
  }
  try {
    if (flag === '--stub') {
      if (!out) throw new Error('--stub needs an output path');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(stub(kind, date), null, 2)}\n`);
      console.log(`wrote ${out}`);
    } else {
      console.log(JSON.stringify(pick(kind, date), null, 2));
    }
  } catch (e) {
    console.error(`pick: ${e.message}`);
    process.exit(1);
  }
}
