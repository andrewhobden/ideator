import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS } from '../server/copilot.ts';
import { loadSettings } from '../public/js/settings.js';
import { XSearchError } from '../server/leads.ts';

test('daily reservations survive restart, preserve spend and migrate legacy board limits/models', () => {
  const root = mkdtempSync(join(tmpdir(), 'ideator-ledger-'));
  const path = join(root, 'test.sqlite');
  let repo = openDb(path);
  try {
    const board = repo.createBoard({
      title: 'Legacy', config: { rate: { usdPerDay: 1 }, models: { judge: 'openrouter:old-model' } },
    });
    assert.equal(board.config.rate.requestsPerDay, 100, 'do not convert dollars into a fake usage quota');
    assert.deepEqual(board.config.models, {});
    assert.ok(!('usdPerDay' in board.config.rate));
    repo.addSpend(board.id, 1.25, '2026-01-01');
    assert.equal(repo.reserveRequest(board.id, 2, 3, '2026-01-01'), null);
    repo.saveAppSettings({ ...DEFAULT_APP_SETTINGS, maxRequestsPerDay: 3 });
    repo.close();
    repo = openDb(path);
    assert.equal(repo.requestsOn(board.id, '2026-01-01'), 1);
    assert.equal(repo.spentOn(board.id, '2026-01-01'), 1.25);
    assert.equal(repo.spentTotal().calls, 1);
    assert.deepEqual(repo.getAppSettings(), { ...DEFAULT_APP_SETTINGS, maxRequestsPerDay: 3 });
    assert.equal(repo.reserveRequest(board.id, 2, 3, '2026-01-01'), null);
    assert.equal(repo.reserveRequest(board.id, 2, 3, '2026-01-01'), 'board');
    assert.equal(repo.reserveRequest(0, Infinity, 3, '2026-01-01'), null, 'reports count globally');
    assert.equal(repo.reserveRequest(99, 2, 3, '2026-01-01'), 'global');
    assert.equal(repo.reserveRequest(board.id, 2, 3, '2026-01-02'), null, 'new local calendar day resets allowance');
    assert.equal(repo.reserveRequest(board.id, 0, 3, '2026-01-03'), 'board');
    assert.equal(repo.reserveRequest(board.id, 2, 0, '2026-01-03'), 'global');
  } finally { repo.close(); rmSync(root, { recursive: true }); }
});

test('engine gates concurrent manual/background calls, failures, reports and briefs before submission', async () => {
  const repo = openDb(':memory:');
  let attempts = 0;
  const settings = { ...structuredClone(DEFAULT_APP_SETTINGS), maxRequestsPerDay: 10 };
  const engine = createEngine({
    repo, settings: () => settings,
    chat: async () => { attempts++; throw new Error('test failure'); },
  });
  const board = repo.createBoard({ title: 'Limited', config: { autoProjectOnGold: false, rate: { requestsPerDay: 2 } } });
  const idea = repo.insertIdea({ boardId: board.id, title: 'Idea', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => engine.judge(idea.id)));
  assert.equal(attempts, 2, 'synchronous reservations prevent parallel overshoot');
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'board_requests').length, 3);
  assert.equal(repo.requestsOn(board.id), 2, 'failed submissions still count');
  await assert.rejects(engine.createProject(idea.id), { code: 'board_requests' });
  settings.maxRequestsPerDay = 2;
  await assert.rejects(engine.synthesize(30, 'en'), { code: 'global_requests' });
  assert.equal(attempts, 2);
  repo.close();
});

test('browser migration deletes legacy API keys and provider URLs without losing the projects folder', () => {
  const data = new Map<string, string>([['ideagen.settings.v1', JSON.stringify({
    keys: { openai: 'old-secret' }, baseUrls: { custom: 'https://old.example' },
    models: { judge: 'ollama:old', expand: 'gpt-test' }, projectsRoot: '/tmp/my-projects', maxUsdPerDay: 0,
  })]]);
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const settings = loadSettings();
    assert.equal(settings.projectsRoot, '/tmp/my-projects');
    assert.equal(settings.models.expand, 'gpt-test');
    assert.equal(settings.models.judge, DEFAULT_APP_SETTINGS.models.judge);
    assert.equal(settings.maxRequestsPerDay, 500);
    assert.equal(data.has('ideagen.settings.v1'), false);
    assert.ok(!data.get('ideagen.settings.v2')!.includes('old-secret'));
    assert.ok(!data.get('ideagen.settings.v2')!.includes('old.example'));
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('X source setup/failure preserves saved leads without consuming AI requests; exhausted caps skip paid lookup', async () => {
  const repo = openDb(':memory:');
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  let lookups = 0;
  let sourceError = new XSearchError('x_not_configured', 'Configure BRAVE_SEARCH_API_KEY');
  const engine = createEngine({
    repo, settings: () => settings,
    chat: async () => { throw new Error('Source failure must not submit an AI request'); },
    fetchXSearchResults: async () => { lookups++; throw sourceError; },
  });
  try {
    const board = repo.createBoard({ title: 'Saved sources' });
    const saved = repo.replaceLeads(board.id, 'x', [{ title: 'Stored lead', summary: 'S', hook: 'H', url: 'https://x.com/a/status/123', meta: {} }]);
    await assert.rejects(engine.refreshLeads(board.id, 'x'), { status: 503, code: 'x_not_configured' });
    sourceError = new XSearchError('x_source_auth', 'Brave rejected credentials');
    await assert.rejects(engine.refreshLeads(board.id, 'x'), { status: 502, code: 'x_source_auth' });
    assert.deepEqual(repo.listLeads(board.id), saved);
    assert.equal(repo.requestsOn(null), 0);
    settings.maxRequestsPerDay = 0;
    await assert.rejects(engine.refreshLeads(board.id, 'x'), { code: 'global_requests' });
    assert.equal(lookups, 2, 'do not charge for search when Copilot is already blocked');
  } finally { repo.close(); }
});
