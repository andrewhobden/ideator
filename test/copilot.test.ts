import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCopilot, mergeAppSettings, DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/copilot.ts';
import type { SessionConfig } from '@github/copilot-sdk';

const request: ChatRequest = {
  model: 'gpt-6.1-sol', system: 'Be concise.', user: 'A seed', schemaName: 'seed',
  schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
};
function fixture() {
  const configs: SessionConfig[] = [];
  const deleted: string[] = [];
  let starts = 0, stops = 0, aborts = 0, sends = 0;
  let authenticated = true;
  let response = '{"title":"Idea"}';
  let error: Error | undefined;
  const client = {
    async start() { starts++; },
    async stop() { stops++; return []; },
    async getAuthStatus() { return { isAuthenticated: authenticated, authType: 'user' }; },
    async listModels() { return [{ id: 'gpt-6.1-sol' }, { id: 'local-model', provider: { kind: 'openai-compatible' } }]; },
    async createSession(config: SessionConfig) {
      configs.push(config);
      return {
        sessionId: `s${configs.length}`,
        async sendAndWait(options: { responseSchema: Record<string, unknown> }) {
          sends++;
          assert.deepEqual(options.responseSchema, request.schema);
          if (error) throw error;
          return { data: { content: response } };
        },
        async abort() { aborts++; },
      };
    },
    async deleteSession(id: string) { deleted.push(id); },
  };
  return {
    service: createCopilot(() => client), configs, deleted,
    counts: () => ({ starts, stops, aborts, sends }),
    signOut: () => { authenticated = false; },
    respond: (text: string) => { response = text; },
    fail: (e: Error) => { error = e; },
  };
}

test('Copilot sessions are isolated, structured, shared-client and deleted after use', async () => {
  const f = fixture();
  const results = await Promise.all([f.service.chat(request), f.service.chat(request)]);
  assert.deepEqual(results.map((r) => r.value), [{ title: 'Idea' }, { title: 'Idea' }]);
  assert.equal(f.counts().starts, 1, 'concurrent calls start one credential-reusing client');
  for (const config of f.configs) {
    assert.deepEqual(config.availableTools, []);
    assert.deepEqual(config.includedBuiltinAgents, []);
    assert.equal(config.skipCustomInstructions, true);
    assert.equal(config.enableConfigDiscovery, false);
    assert.equal(config.systemMessage?.mode, 'replace');
    assert.deepEqual(await config.onPermissionRequest!({ kind: 'read', path: '/private', intention: 'test' }, { sessionId: 's' }), { kind: 'denied-interactively-by-user' });
  }
  assert.deepEqual(f.deleted.sort(), ['s1', 's2']);
  assert.deepEqual(await f.service.models(), ['gpt-6.1-sol'], 'external provider models are excluded');
  await f.service.close();
  assert.equal(f.counts().stops, 1);
});

test('missing/revoked auth and invalid responses fail explicitly; failures abort and delete sessions', async () => {
  const missing = fixture();
  missing.signOut();
  await assert.rejects(missing.service.chat(request), { code: 'copilot_auth' });
  assert.equal(missing.configs.length, 0);
  const revoked = fixture();
  revoked.fail(new Error('401 token revoked'));
  await assert.rejects(revoked.service.chat(request), { code: 'copilot_auth' });
  assert.equal(revoked.counts().aborts, 1);
  assert.deepEqual(revoked.deleted, ['s1']);
  const invalid = fixture();
  invalid.respond('{"title":42}');
  await assert.rejects(invalid.service.chat(request), { code: 'invalid_response' });
  assert.equal(invalid.counts().aborts, 1);
  assert.deepEqual(invalid.deleted, ['s1']);
  await assert.rejects(invalid.service.chat({ ...request, model: 'ollama:qwen3' }), { code: 'bad_model' });
  const timeout = fixture();
  timeout.fail(new Error('Timed out waiting for response'));
  await assert.rejects(timeout.service.chat(request), /Timed out/);
  assert.equal(timeout.counts().aborts, 1, 'sendAndWait timeout must cancel the underlying work');
  assert.deepEqual(timeout.deleted, ['s1']);
  const nonJson = fixture();
  nonJson.respond('not JSON');
  await assert.rejects(nonJson.service.chat(request), { code: 'invalid_response' });
  const unavailable = fixture();
  await assert.rejects(unavailable.service.chat({ ...request, model: 'not-in-catalog' }), { code: 'bad_model' });
  await assert.rejects(unavailable.service.chat({ ...request, model: 'local-model' }), { code: 'bad_model' });
  assert.equal(unavailable.configs.length, 0, 'unknown/external models cannot create sessions');
});

test('a failed SDK startup is stopped and can be retried', async () => {
  let starts = 0, stops = 0;
  const service = createCopilot(() => ({
    async start() { if (++starts === 1) throw new Error('RPC connection failed'); },
    async stop() { stops++; return []; },
    async getAuthStatus() { return { isAuthenticated: true }; },
    async listModels() { return []; },
    async createSession() { throw new Error('not used'); },
    async deleteSession() {},
  }));
  await assert.rejects(service.status(), { code: 'copilot_failed' });
  assert.equal(stops, 1, 'a partially launched CLI must not be leaked');
  assert.equal((await service.status()).isAuthenticated, true);
  await service.close();
  assert.equal(stops, 2);
});

test('legacy provider secrets and routing are discarded, not persisted as Copilot settings', () => {
  const result = mergeAppSettings({
    keys: { openrouter: 'legacy-secret' }, baseUrls: { custom: 'https://example.test' },
    models: { expand: 'ollama:qwen3', judge: 'gpt-6.1-sol' }, maxUsdPerDay: 20,
    maxRequestsPerDay: 0, projectsRoot: '/tmp/projects',
  });
  assert.equal(result.models.expand, DEFAULT_APP_SETTINGS.models.expand);
  assert.equal(result.models.judge, 'gpt-6.1-sol');
  assert.equal(result.maxRequestsPerDay, 0);
  assert.equal(result.projectsRoot, '/tmp/projects');
  assert.ok(!JSON.stringify(result).includes('legacy-secret'));
  assert.ok(!('maxUsdPerDay' in result));
});
