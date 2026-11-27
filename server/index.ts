import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { mergeAppSettings, createCopilot, type AppSettings } from './copilot.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createHandler, type Runtime } from './app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8300);
// Local first: the app can use the operating-system user's Copilot identity.
const HOST = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(HOST)) throw new Error('HOST must be a loopback address: this app uses your local Copilot identity.');

mkdirSync(join(root, 'data'), { recursive: true });
const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));

// Persist non-secret limits so unattended restarts cannot reset them.
const saved = repo.getAppSettings();
let settings: AppSettings = mergeAppSettings(saved);
let received = !!saved;
const runtime: Runtime = {
  get: () => settings,
  set: (s) => {
    settings = s;
    repo.saveAppSettings(s);
    received = true;
  },
  received: () => received,
};

const copilot = createCopilot();
const engine = createEngine({ repo, chat: copilot.chat, settings: runtime.get });
const autopilot = createAutopilot({ repo, engine, settings: runtime.get }).start();

const handler = createHandler({ repo, engine, autopilot, runtime, copilot, publicDir: join(root, 'public') });
const server = createServer(handler).listen(PORT, HOST, () => {
  console.log(`Idégeneratorn: http://localhost:${PORT}`);
  const auto = repo.listBoards().filter((b) => b.config.mode === 'auto');
  if (auto.length) console.log(`Autopilot on for ${auto.length} board(s), using the existing Copilot sign-in and saved request limits.`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const stopped = autopilot.stop();
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  handler.closeStreams();
  try { await closed; await stopped; await engine.idle(); await copilot.close(); repo.close(); }
  catch (e) { console.error('[shutdown]', e); process.exitCode = 1; }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
