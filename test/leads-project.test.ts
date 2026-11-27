import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPapers, fetchXSearchResults, xLeads } from '../server/leads.ts';
import { expandHome, renderAgentsMd, slugify, writeProject, type Brief } from '../server/project.ts';

test('X lead URLs come from retrieved numeric IDs, never fabricated IDs, duplicates or model URLs', async () => {
  const result = await xLeads({
    model: 'gpt-test', goal: 'Sound', lang: 'en',
    results: [{ id: '123', url: 'https://x.com/artist/status/123', title: 'Sound tool', snippet: 'A new sound tool.', retrievedAt: '2026-11-12', query: 'sound', indexAge: '1 day ago' }],
    chat: async (request) => {
      assert.match(request.user, /\[123\][\s\S]*A new sound tool/);
      assert.match(request.system, /Do not claim live X verification/);
      return { value: { leads: [
        { id: '123', title: 'Sound', summary: 'S', hook: 'H', url: 'https://evil.example' },
        { id: '123', title: 'Duplicate' },
        { id: '456', title: 'Invented' },
        { id: '../malicious', title: 'Invalid' },
      ] } };
    },
  });
  assert.equal(result.dropped, 3);
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].url, 'https://x.com/artist/status/123');
  assert.equal(result.leads[0].meta.evidence, 'indexed-snippet');
  const empty = await xLeads({
    model: 'gpt-test', goal: '', lang: 'en', results: [],
    chat: async () => { throw new Error('Empty retrieval must not submit an AI request'); },
  });
  assert.deepEqual(empty.leads, []);
});

test('Brave uses only non-AI web search and accepts unique HTTPS X status results with provenance', async () => {
  const fake = (async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.match(url.searchParams.get('q')!, /site:x.com OR site:twitter.com/);
    assert.match(url.searchParams.get('q')!, /sound/);
    assert.equal(url.searchParams.get('freshness'), 'pw');
    assert.equal(url.searchParams.get('result_filter'), 'web', 'no AI summarizer or LLM endpoint');
    assert.equal(new Headers(options?.headers).get('X-Subscription-Token'), 'test-key');
    assert.equal(options?.redirect, 'error', 'never redirect a credential-bearing request');
    return Response.json({ type: 'search', web: { results: [
      { url: 'https://x.com/artist/status/123?s=20', title: 'Sound &amp; light', description: '<strong>Sound</strong> tool', age: '2 days ago' },
      { url: 'https://twitter.com/artist/status/123', title: 'Duplicate', description: 'Same source' },
      { url: 'https://twitter.com/b/status/456', title: 'Other', description: 'Another result' },
      { url: 'https://x.com.evil.example/a/status/789', title: 'Fake host' },
      { url: 'https://x.com/search?q=tools', title: 'Not a status' },
      { url: 'http://x.com/a/status/789', title: 'Insecure' },
      { url: 'https://user@x.com/a/status/789', title: 'Userinfo' },
      { url: 'https://x.com:444/a/status/789', title: 'Unexpected port' },
    ] } });
  }) as typeof fetch;
  const results = await fetchXSearchResults('sound', fake, 'test-key');
  assert.deepEqual(results.map((r) => r.url), ['https://x.com/artist/status/123', 'https://twitter.com/b/status/456']);
  assert.equal(results[0].title, 'Sound & light');
  assert.equal(results[0].snippet, 'Sound tool');
  assert.equal(results[0].indexAge, '2 days ago', 'search age is not a verified post publication date');
  assert.ok(Number.isFinite(Date.parse(results[0].retrievedAt)));
});

test('Brave missing-key, auth, quota and invalid-response errors are explicit and never echo secrets', async () => {
  const noFetch = (async () => { throw new Error('Missing key must not make a network request'); }) as typeof fetch;
  await assert.rejects(fetchXSearchResults('sound', noFetch, ''), { code: 'x_not_configured' });
  for (const [status, code] of [[401, 'x_source_auth'], [403, 'x_source_auth'], [429, 'x_source_limit'], [503, 'x_source_failed']] as const) {
    const fake = (async () => new Response('secret-test-key', { status })) as typeof fetch;
    await assert.rejects(fetchXSearchResults('sound', fake, 'secret-test-key'), (error: Error & { code: string }) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('secret-test-key'));
      return true;
    });
  }
  for (const body of ['invalid json', JSON.stringify({ type: 'search', web: { results: {} } }), 'null']) {
    const fake = (async () => new Response(body)) as typeof fetch;
    await assert.rejects(fetchXSearchResults('sound', fake, 'test-key'), { code: 'x_source_failed' });
  }
  const empty = (async () => Response.json({ type: 'search', query: { original: 'sound' } })) as typeof fetch;
  assert.deepEqual(await fetchXSearchResults('sound', empty, 'test-key'), []);
});

test('papers: goal matches first, only from the last year, no duplicates', async () => {
  const recent = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 800 * 86_400_000).toISOString();
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(url);
    const body = url.includes('/search')
      ? [{ paper: { id: 's1', title: 'Spatial audio', summary: 'Original abstract', ai_summary: 'AI sum', publishedAt: recent, upvotes: 3 } },
         { paper: { id: 'old', title: 'Old', summary: 'x', publishedAt: old } },
         { paper: { id: 'd1', title: 'Dup', summary: 'x', publishedAt: recent } }]
      : [{ paper: { id: 'd1', title: 'Daily', summary: 'sum', publishedAt: recent, upvotes: 7 } }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const papers = await fetchPapers('ljud i offentliga rum', fake);
  assert.deepEqual(papers.map((p) => p.id), ['s1', 'd1']);
  assert.equal(papers[0].summary, 'Original abstract', 'uses the paper source, not another AI service summary');
  assert.ok(urls.some((u) => u.includes('q=ljud%20i%20offentliga%20rum')));
  assert.deepEqual((await fetchPapers('', fake)).map((p) => p.id), ['d1'], 'no goal: daily papers only');
});

test('slugs are ASCII; ~ expands to home', () => {
  assert.equal(slugify('Sjungande Bänk på Öland!'), 'sjungande-bank-pa-oland');
  assert.equal(slugify('!!!'), 'idea');
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
  assert.equal(expandHome('/abs'), '/abs');
});

test('paper-source errors are explicit, not disguised as an empty successful refresh', async () => {
  const unavailable = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
  await assert.rejects(fetchPapers('sound', unavailable), /Hugging Face 503/);
});

const brief: Brief = {
  name: 'Bänk', slug: 'bank', oneLiner: 'En bänk.', problem: 'P', audience: 'A', mvp: ['m'], outOfScope: ['o'],
  stack: 's', firstSteps: ['f1', 'f2'], openQuestions: ['q'], risks: ['r'],
};
const idea = {
  id: 1, title: 'Bänk', pitch: 'Sjunger.', kind: 'combine', sourceUrl: null, originality: 5, feasibility: 4, impact: 4,
  reason: 'Bra.', medalOverride: null,
};

test('AGENTS.md: verdict, goal, numbered steps, and lineage across boards', () => {
  const md = renderAgentsMd({
    brief, idea, goal: 'Ljud', lang: 'sv', date: '2026-11-02',
    lineage: [{ ...idea, id: 2, title: 'Gäst', pitch: 'G', kind: 'guest', originBoardTitle: 'Ljusbordet' }],
  });
  assert.match(md, /Originalitet 5 · Genomförbarhet 4 · Effekt 4 = 13\/15 🥇/);
  assert.match(md, /## Tavlans mål\n\nLjud/);
  assert.match(md, /1\. f1\n2\. f2/);
  assert.match(md, /- Gäst \(från tavlan Ljusbordet\): \*\*Gäst\*\* G/);
});

test('project folders never overwrite: a taken name gets -2', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ideagen-'));
  try {
    const a = await writeProject({ root, brief, idea, goal: '', lineage: [], lang: 'en', gitInit: false });
    const b = await writeProject({ root, brief, idea, goal: '', lineage: [], lang: 'en', gitInit: false });
    assert.deepEqual([a, b].map((p) => p.slice(root.length + 1)), ['bank', 'bank-2']);
    assert.deepEqual(readdirSync(a).sort(), ['.gitignore', 'AGENTS.md', 'README.md', 'idea.json', 'vault']);
    assert.match(readFileSync(join(a, 'README.md'), 'utf8'), new RegExp(`cd "${a}"\\ncopilot`));
    await assert.rejects(writeProject({ root: 'relative', brief, idea, goal: '', lineage: [], lang: 'en', gitInit: false }), /absolute/);
  } finally { rmSync(root, { recursive: true }); }
});
