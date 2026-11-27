import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentParts, distinctDocumentIdeas } from '../public/js/document.js';
import { openDb, type Repo } from '../server/db.ts';
import { createEngine, type BoardEvent } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, CopilotError, type ChatRequest } from '../server/copilot.ts';

const first = 'Gateways persist signed replay receipts for offline delivery proofs.';
const tail = 'The final router shifts workloads to cool nodes before they throttle.';
const last = first + '\n' + tail;
const text = first.padEnd(10_000, 'x') + last;
const replay = { title: 'Replay receipts', pitch: 'Gateways retain signed receipts to prove delivery while offline.', evidence: first };
const thermal = { title: 'Thermal routing', pitch: 'Move workloads to cool machines before their thermal limits throttle processing.', evidence: tail };

function source(request: ChatRequest): { mainPart: string; precedingContext: string; followingContext: string } {
  return JSON.parse(request.user.split('Untrusted source data:\n')[1]);
}

function setup(repo: Repo, respond: (request: ChatRequest) => unknown | Promise<unknown>) {
  const calls: ChatRequest[] = [];
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  const engine = createEngine({
    repo, settings: () => settings,
    chat: async (request) => {
      calls.push(request);
      return { value: request.schemaName === 'document_ideas' ? await respond(request) : {
        reason: 'Concrete source mechanism.', originality: 2, feasibility: 3, impact: 2, keywords: ['architecture'],
      } };
    },
  });
  return { engine, calls, settings };
}

test('document parts cover the full maximum-size input without overlap, truncation or split surrogate pairs', () => {
  const document = ('a'.repeat(9_999) + '🧠\n' + 'Many complete words and paragraphs.\n'.repeat(3_000)).slice(0, 100_000);
  const parts = documentParts(document);
  assert.equal(document.length, 100_000);
  assert.equal(parts.join(''), document);
  assert.ok(parts.length > 1 && parts.length <= 14);
  assert.ok(parts.every((part) => part.length <= 10_000 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
  assert.deepEqual(documentParts('  Short architecture.  '), ['  Short architecture.  '], 'do not silently trim source content');
  assert.throws(() => documentParts('a'.repeat(100_001)), /limited/);
  assert.throws(() => documentParts(' \n '), /Paste/);
});

test('document candidates deduplicate case, punctuation, pitches and substantial paraphrase overlap against the wall', () => {
  const ideas = [
    replay,
    { ...replay, title: ' REPLAY—RECEIPTS ' },
    { title: 'New label', pitch: replay.pitch, evidence: first },
    thermal,
    { ...thermal, title: 'Other wording', pitch: thermal.pitch + ' safely' },
  ];
  assert.deepEqual(distinctDocumentIdeas(ideas), [replay, thermal]);
  assert.deepEqual(distinctDocumentIdeas(ideas, [replay]), [thermal]);
});

test('mining reads every part including the tail, publishes one distinct seed batch, and queues ordinary judging', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Architecture', config: { autoProjectOnGold: false, models: { distill: 'gpt-document' } } });
  repo.insertIdea({ boardId: board.id, title: 'Existing mechanism', pitch: 'Already on the wall.', kind: 'seed', x: 0, y: 0, generation: 0 });
  const seen: ReturnType<typeof source>[] = [];
  const { engine, calls } = setup(repo, (request) => {
    const part = source(request);
    seen.push(part);
    assert.equal(repo.listIdeas(board.id).length, 1, 'no partial seeds while mining');
    return { ideas: seen.length === 1 ? [replay, { ...replay, title: 'Existing mechanism' }] : [{ ...replay, title: 'replay—receipts' }, thermal] };
  });
  const events: BoardEvent[] = [];
  engine.bus.on(board.id, (event) => events.push(event));
  try {
    const result = await engine.mineDocument(board.id, { text, requestId: 'all-parts' });
    assert.equal(seen.map((part) => part.mainPart).join(''), text);
    assert.equal(seen[1].mainPart, last);
    assert.equal(seen[0].followingContext, last);
    assert.equal(seen[1].precedingContext.length, 500);
    assert.equal(result.ideas.length, 2);
    assert.equal(result.deduplicated, 2);
    assert.ok(result.ideas.every((idea) => idea.kind === 'seed' && idea.generation === 0 && idea.x > 0));
    assert.equal(events.find((event) => event.type === 'ideas')?.ideas instanceof Array, true);
    assert.ok(events.some((event) => event.type === 'document_progress' && event.requestId === 'all-parts' && event.completed === 2));
    assert.ok(calls.filter((call) => call.schemaName === 'document_ideas').every((call) => call.model === 'gpt-document'));
    await engine.idle();
    assert.ok(result.ideas.every((idea) => repo.getIdea(idea.id)?.judgedAt));
    assert.equal(repo.requestsOn(board.id), 4, 'two extraction requests plus two ordinary judges');
    const count = calls.length;
    const retry = await engine.mineDocument(board.id, { text });
    assert.equal(retry.reused, true);
    assert.equal(calls.length, count);
    assert.equal(repo.listIdeas(board.id).length, 3);
  } finally { await engine.idle(); repo.close(); }
});

test('completed parts and an atomic retry receipt survive restart after an extraction failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ideator-document-'));
  const file = join(root, 'ideas.sqlite');
  let repo = openDb(file);
  const board = repo.createBoard({ title: 'Resume', config: { autoProjectOnGold: false } });
  let count = 0;
  let current = setup(repo, () => {
    if (++count === 2) throw new CopilotError('copilot_auth', 'Sign-in expired');
    return { ideas: [replay] };
  });
  try {
    await assert.rejects(current.engine.mineDocument(board.id, { text }), { code: 'copilot_auth' });
    assert.equal(repo.listIdeas(board.id).length, 0);
    assert.equal(repo.requestsOn(board.id), 2);
    repo.close();
    repo = openDb(file);
    current = setup(repo, (request) => {
      assert.equal(source(request).mainPart, last, 'only the failed part is retried');
      return { ideas: [thermal] };
    });
    const result = await current.engine.mineDocument(board.id, { text });
    assert.equal(result.ideas.length, 2);
    await current.engine.idle();
    assert.equal(current.calls.filter((call) => call.schemaName === 'document_ideas').length, 1);
    assert.equal(repo.requestsOn(board.id), 5, 'failed attempts remain counted');
    const ids = result.ideas.map((idea) => idea.id);
    repo.close();
    repo = openDb(file);
    current = setup(repo, () => { throw new Error('Completed imports must not call Copilot'); });
    const retry = await current.engine.mineDocument(board.id, { text });
    assert.equal(retry.reused, true);
    assert.deepEqual(retry.ideas.map((idea) => idea.id), ids);
    assert.equal(current.calls.length, 0);
  } finally { await current.engine.idle(); repo.close(); rmSync(root, { recursive: true }); }
});

test('malformed, ungrounded and wholly empty extraction fails explicitly without publishing seeds', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Invalid', config: { autoProjectOnGold: false } });
  let value: unknown;
  const { engine, calls } = setup(repo, () => value);
  try {
    for (value of [
      undefined, {}, { ideas: 'not an array' }, { ideas: [null] },
      { ideas: [{ ...replay, title: 42 }] }, { ideas: [{ ...replay, title: '' }] },
      { ideas: [{ ...replay, evidence: 'Invented supporting text not in the document' }] },
      { ideas: Array.from({ length: 13 }, () => replay) },
    ]) {
      await assert.rejects(engine.mineDocument(board.id, { text: first }), { status: 502, code: 'llm_failed' });
      assert.equal(repo.listIdeas(board.id).length, 0);
    }
    value = { ideas: [] };
    await assert.rejects(engine.mineDocument(board.id, { text: first }), { code: 'document_no_ideas' });
    value = { ideas: [replay] };
    assert.equal((await engine.mineDocument(board.id, { text: first })).ideas.length, 1, 'an empty extraction can be retried, not cached forever');
    await engine.idle();
    const before = calls.length;
    await assert.rejects(engine.mineDocument(board.id, { text: 'a'.repeat(100_001) }), { status: 413, code: 'document_too_large' });
    await assert.rejects(engine.mineDocument(board.id, { text: ' \n ' }), { code: 'document_empty' });
    await assert.rejects(engine.mineDocument(board.id, { text: {} }), { code: 'document_empty' });
    assert.equal(calls.length, before, 'invalid input never consumes a request');
  } finally { await engine.idle(); repo.close(); }
});

test('mining preflights remaining limits, permits empty boilerplate parts, and leaves seeds unjudged when allowance runs out', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Limits', config: { autoProjectOnGold: false, rate: { requestsPerDay: 1 } } });
  const { engine, calls, settings } = setup(repo, (request) => ({ ideas: source(request).mainPart === last ? [thermal] : [] }));
  try {
    await assert.rejects(engine.mineDocument(board.id, { text }), { code: 'board_requests' });
    assert.equal(calls.length, 0);
    repo.updateBoard(board.id, { config: { rate: { requestsPerDay: 100 } } });
    settings.maxRequestsPerDay = 1;
    await assert.rejects(engine.mineDocument(board.id, { text }), { code: 'global_requests' });
    assert.equal(calls.length, 0);
    settings.maxRequestsPerDay = 2;
    const result = await engine.mineDocument(board.id, { text });
    assert.equal(result.ideas.length, 1);
    assert.equal(result.judgingQueued, 0);
    await engine.idle();
    assert.equal(repo.getIdea(result.ideas[0].id)?.judgedAt, null);
    assert.equal(calls.length, 2);
    assert.equal(repo.requestsOn(null), 2);
    settings.maxRequestsPerDay = 0;
    assert.equal((await engine.mineDocument(board.id, { text })).reused, true, 'a receipt needs no allowance');
    assert.equal(calls.length, 2);
  } finally { await engine.idle(); repo.close(); }
});

test('a concurrent request can exhaust allowance between parts; retry resumes without duplicate or partial seeds', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Race', config: { autoProjectOnGold: false, rate: { requestsPerDay: 2 } } });
  let competing = true;
  const { engine, calls } = setup(repo, (request) => {
    if (competing) {
      competing = false;
      assert.equal(repo.reserveRequest(board.id, 2, 500), null);
    }
    return { ideas: source(request).mainPart === last ? [thermal] : [replay] };
  });
  try {
    await assert.rejects(engine.mineDocument(board.id, { text }), { code: 'board_requests' });
    assert.equal(repo.listIdeas(board.id).length, 0);
    repo.updateBoard(board.id, { config: { rate: { requestsPerDay: 4 } } });
    assert.equal((await engine.mineDocument(board.id, { text })).ideas.length, 2);
    await engine.idle();
    assert.equal(calls.filter((call) => call.schemaName === 'document_ideas').length, 2);
    assert.equal(repo.requestsOn(board.id), 4);
    assert.equal(repo.listIdeas(board.id).length, 2);
  } finally { await engine.idle(); repo.close(); }
});

test('simultaneous imports of the same document are explicit and cannot double-submit or duplicate seeds', async () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Concurrent', config: { autoProjectOnGold: false } });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<unknown>();
  const { engine, calls } = setup(repo, async () => { started.resolve(); return await release.promise; });
  const pending = engine.mineDocument(board.id, { text: first });
  let idleResolved = false;
  const idle = engine.idle().then(() => { idleResolved = true; });
  try {
    await started.promise;
    assert.equal(idleResolved, false, 'shutdown waits for mining even without active judges or a connected browser');
    await assert.rejects(engine.mineDocument(board.id, { text: first }), { status: 409, code: 'document_busy' });
    release.resolve({ ideas: [replay] });
    assert.equal((await pending).ideas.length, 1);
    await idle;
    assert.equal(idleResolved, true);
    assert.equal(calls.filter((call) => call.schemaName === 'document_ideas').length, 1);
    assert.equal(repo.listIdeas(board.id).length, 1);
  } finally { release.resolve({ ideas: [replay] }); await pending; await engine.idle(); repo.close(); }
});

test('a failed batch insertion rolls back every seed and the completion receipt together', () => {
  const repo = openDb(':memory:');
  try {
    const board = repo.createBoard({ title: 'Atomic' });
    repo.startDocumentImport(board.id, 'atomic-test', 1);
    repo.saveDocumentParts(board.id, 'atomic-test', [[replay]]);
    const draft = { boardId: board.id, title: replay.title, pitch: replay.pitch, kind: 'seed' as const, generation: 0, x: 0, y: 0 };
    assert.throws(() => repo.commitDocumentImport(board.id, 'atomic-test', [draft, { ...draft, x: Number.NaN }], 0), /NOT NULL/);
    assert.equal(repo.listIdeas(board.id).length, 0);
    assert.equal(repo.documentImport(board.id, 'atomic-test')?.ideaIds, null);
    const result = repo.commitDocumentImport(board.id, 'atomic-test', [draft], 0);
    assert.equal(result.ideas.length, 1);
    assert.equal(repo.commitDocumentImport(board.id, 'atomic-test', [draft], 0).reused, true);
    assert.equal(repo.listIdeas(board.id).length, 1);
  } finally { repo.close(); }
});
