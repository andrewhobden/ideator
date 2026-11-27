// HTTP: routes onto the engine, live events (SSE), static files.
// createHandler() takes its dependencies so the tests can run it against an
// in-memory database and a fake LLM.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Repo, Idea, Board } from './db.ts';
import { AppError, type Engine } from './engine.ts';
import type { Autopilot } from './autopilot.ts';
import { mergeAppSettings, validModel, ROLES, CopilotError, type AppSettings, type Copilot } from './copilot.ts';
import { fitness, medal, scoreSum } from '../public/js/score.js';

export type Runtime = {
  get(): AppSettings;
  set(s: AppSettings): void;
  /** Are saved non-secret settings available? */
  received(): boolean;
};

type Deps = { repo: Repo; engine: Engine; autopilot: Autopilot; runtime: Runtime; copilot: Pick<Copilot, 'status' | 'models'>; publicDir: string; xSearchConfigured?: () => boolean };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const daysOf = (url: URL) => Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new AppError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'bad_json', 'Invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(payload);
}

const LABELS = {
  sv: {
    flow: 'Flöde', ideas: 'idéer', exported: 'Exporterad', seed: 'Frö', source: 'Källa', parents: 'Föräldrar',
    originality: 'Originalitet', feasibility: 'Genomförbarhet', impact: 'Effekt', unjudged: 'Ej bedömd',
    handset: 'satt för hand', guest: 'Gäst från tavlan', project: 'Copilot-projekt',
    summary: 'Sammanfattning', strongest: 'Starkast', gaps: 'Luckor', next: 'Nästa steg', stale: 'Sammanfattningen är äldre än tavlan',
  },
  en: {
    flow: 'Flow', ideas: 'ideas', exported: 'Exported', seed: 'Seed', source: 'Source', parents: 'Parents',
    originality: 'Originality', feasibility: 'Feasibility', impact: 'Impact', unjudged: 'Not judged',
    handset: 'set by hand', guest: 'Guest from board', project: 'Copilot project',
    summary: 'Summary', strongest: 'Strongest', gaps: 'Gaps', next: 'Next steps', stale: 'The summary is older than the board',
  },
};
const MEDAL_ICON = ['', '🥉 ', '🥈 ', '🥇 '];

export function boardMarkdown(board: Board, ideas: Idea[], edges: { from: number; to: number }[], lang: 'sv' | 'en') {
  const L = LABELS[lang];
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const parents = new Map<number, Idea[]>();
  for (const e of edges) {
    const p = byId.get(e.from);
    if (!p) continue;
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to)!.push(p);
  }
  const sorted = [...ideas].sort((a, b) => (fitness(b) ?? -1) - (fitness(a) ?? -1) || a.id - b.id);
  const out = [`# ${board.title}`, ''];
  if (board.goal) out.push(`> ${board.goal}`, '');
  out.push(`${L.flow}: ${board.config.flowName} · ${ideas.length} ${L.ideas} · ${L.exported} ${new Date().toISOString().slice(0, 10)}`, '');
  const s = board.summary;
  if (s) {
    out.push(`## ${L.summary}`, '', s.headline, '');
    for (const t of s.themes) out.push(`**${t.name}.** ${t.insight}`, '');
    if (s.strongest.length) out.push(`**${L.strongest}:**`, ...s.strongest.map((x) => `- ${x.title}: ${x.why}`), '');
    if (s.gaps.length) out.push(`**${L.gaps}:**`, ...s.gaps.map((x) => `- ${x}`), '');
    if (s.nextSteps.length) out.push(`**${L.next}:**`, ...s.nextSteps.map((x) => `- ${x}`), '');
    if (s.ideaCount !== ideas.length) out.push(`*${L.stale} (${s.ideaCount} → ${ideas.length} ${L.ideas})*`, '');
    out.push('---', '');
  }
  for (const i of sorted) {
    const m = medal(i);
    const sum = scoreSum(i);
    out.push(`## ${m ? MEDAL_ICON[m] : ''}${i.title}${sum != null ? ` — ${sum}/15` : ''}`, '');
    if (i.pitch) out.push(i.pitch, '');
    if (sum != null) {
      out.push(`*${L.originality} ${i.originality} · ${L.feasibility} ${i.feasibility} · ${L.impact} ${i.impact}.* ${i.reason ?? ''}`.trim(), '');
    } else if (i.medalOverride == null) {
      out.push(`*${L.unjudged}*`, '');
    }
    if (i.medalOverride != null) out.push(`*${MEDAL_ICON[i.medalOverride] || '–'} ${L.handset}*`, '');
    if (i.keywords.length) out.push(i.keywords.map((k) => `\`${k}\``).join(' '), '');
    const ps = parents.get(i.id);
    if (ps?.length) out.push(`${L.parents}: ${ps.map((p) => p.title).join(' × ')}`, '');
    else if (i.kind === 'guest') out.push(`${L.guest} ${i.originBoardTitle ?? '?'}`, '');
    else if (i.sourceUrl) out.push(`${L.seed} · ${L.source}: ${i.sourceUrl}`, '');
    else out.push(`${L.seed}`, '');
    if (i.projectPath) out.push(`${L.project}: \`${i.projectPath}\``, '');
  }
  return out.join('\n');
}

const REPORT_LABELS = {
  sv: {
    title: 'Rapport', period: 'Senaste {n} dagarna', boards: 'tavlor', ideas: 'idéer', newIdeas: 'nya', projects: 'Copilot-projekt',
    spent: 'Historisk kostnad (före Copilot)', requests: 'Copilot-anrop', conclusions: 'Slutsatser', insights: 'Insikter', standouts: 'Mest värt att driva vidare', opportunities: 'Möjligheter',
    next: 'Nästa steg', goal: 'Mål', best: 'Bästa idéerna', summary: 'Sammanfattning', stale: 'äldre än tavlan', none: 'Inga ännu.',
    start: 'Starta',
  },
  en: {
    title: 'Report', period: 'Last {n} days', boards: 'boards', ideas: 'ideas', newIdeas: 'new', projects: 'Copilot projects',
    spent: 'Historical spend (pre-Copilot)', requests: 'Copilot requests', conclusions: 'Conclusions', insights: 'Insights', standouts: 'Most worth pursuing', opportunities: 'Opportunities',
    next: 'Next steps', goal: 'Goal', best: 'Best ideas', summary: 'Summary', stale: 'older than the board', none: 'None yet.',
    start: 'Start',
  },
};

export function reportMarkdown(r: ReturnType<Repo['report']>, lang: 'sv' | 'en') {
  const L = REPORT_LABELS[lang];
  const m = r.totals.medals;
  const out = [
    `# ${L.title} · ${new Date().toISOString().slice(0, 10)}`, '',
    `${L.period.replace('{n}', String(r.days))} · ${r.totals.boards} ${L.boards} · ${r.totals.ideas} ${L.ideas} (${r.totals.newIdeas} ${L.newIdeas}) · 🥇 ${m.gold} 🥈 ${m.silver} 🥉 ${m.bronze} · ${r.totals.projects} ${L.projects} · ${L.requests}: ${r.totals.requests} · ${L.spent} $${r.totals.spentUsd.toFixed(2)}`, '',
  ];
  const s = r.synthesis;
  if (s) {
    out.push(`## ${L.conclusions}`, '', s.headline, '');
    if (s.insights?.length) out.push(`### ${L.insights}`, '', ...s.insights.map((x: string) => `- ${x}`), '');
    if (s.standouts?.length) out.push(`### ${L.standouts}`, '', ...s.standouts.map((x: any) => `- **${x.title}** (${x.board}): ${x.why}`), '');
    if (s.opportunities?.length) out.push(`### ${L.opportunities}`, '', ...s.opportunities.map((x: string) => `- ${x}`), '');
    if (s.nextSteps?.length) out.push(`### ${L.next}`, '', ...s.nextSteps.map((x: string) => `- ${x}`), '');
  }
  out.push(`## ${L.projects}`, '');
  if (!r.projects.length) out.push(L.none, '');
  for (const p of r.projects) out.push(`- **${p.title}** (${p.boardTitle}${p.sum != null ? `, ${p.sum}/15` : ''}): \`cd "${p.path}" && copilot\``);
  out.push('');
  for (const b of r.boards) {
    out.push(`## ${b.title}`, '');
    if (b.goal) out.push(`> ${L.goal}: ${b.goal}`, '');
    out.push(`${b.ideaCount} ${L.ideas} (${b.newIdeas} ${L.newIdeas})`, '');
    if (b.summary) out.push(`**${L.summary}${b.summary.stale ? ` (${L.stale})` : ''}:** ${b.summary.headline}`, '');
    if (b.best.length) out.push(`**${L.best}:**`, ...b.best.map((i) => `- ${MEDAL_ICON[i.medal ?? 0]}${i.title}${i.sum != null ? ` — ${i.sum}/15` : ''}`), '');
  }
  return out.join('\n');
}

export function createHandler({ repo, engine, autopilot, runtime, copilot, publicDir, xSearchConfigured = () => !!process.env.BRAVE_SEARCH_API_KEY?.trim() }: Deps) {
  const root = resolve(publicDir);
  const streams = new Set<ServerResponse>();

  function usageStatus() {
    return {
      settingsReceived: runtime.received(),
      requestsToday: repo.requestsOn(null),
      historicalSpend: repo.spentTotal(),
      sources: { x: { configured: xSearchConfigured() } },
    };
  }

  type Handler = (p: string[], body: any, url: URL) => Promise<unknown> | unknown;
  const routes: [string, RegExp, Handler][] = [
    // ---- non-secret settings; authentication belongs exclusively to the CLI
    ['PUT', /^\/api\/runtime-settings$/, (_p, b) => {
      if (b.maxRequestsPerDay !== undefined && (!Number.isInteger(b.maxRequestsPerDay) || b.maxRequestsPerDay < 0 || b.maxRequestsPerDay > 100_000)) {
        throw new AppError(400, 'bad_limit', 'Daily Copilot request limit must be an integer from 0 to 100000.');
      }
      for (const role of ROLES) if (b.models?.[role] !== undefined && !validModel(b.models[role])) {
        throw new AppError(400, 'bad_model', 'Use a Copilot catalog model ID without a provider prefix.');
      }
      runtime.set(mergeAppSettings(b));
      return usageStatus();
    }],
    ['GET', /^\/api\/runtime-settings$/, () => ({ settings: runtime.get(), ...usageStatus() })],
    ['GET', /^\/api\/copilot\/status$/, async () => ({ auth: await copilot.status(), ...usageStatus() })],
    ['GET', /^\/api\/copilot\/models$/, async () => ({ models: await copilot.models() })],

    // ---- boards
    ['GET', /^\/api\/boards$/, () => ({ boards: repo.listBoards() })],
    ['POST', /^\/api\/boards$/, (_p, b) => {
      const lang = b.lang === 'en' ? 'en' : 'sv';
      return {
        board: repo.createBoard({
          title: str(b.title, 120) || (lang === 'en' ? 'New board' : 'Ny tavla'),
          goal: str(b.goal, 600),
          templateId: Number.isInteger(b.templateId) ? b.templateId : null,
          config: { lang },
        }),
      };
    }],
    ['GET', /^\/api\/boards\/(\d+)$/, ([id]) => {
      const board = repo.getBoard(+id);
      if (!board) throw new AppError(404, 'not_found', 'Board not found');
      const ideas = repo.listIdeas(board.id);
      return {
        board, ideas,
        edges: repo.listEdges(board.id),
        leads: repo.listLeads(board.id),
        spinoffs: repo.spinoffs(board.id),
        judging: ideas.filter((i) => engine.judging.has(i.id)).map((i) => i.id),
        autopilot: autopilot.status(board.id),
        requestsToday: repo.requestsOn(board.id),
      };
    }],
    ['PATCH', /^\/api\/boards\/(\d+)$/, ([id], b) => {
      const patch: any = {};
      if (typeof b.title === 'string' && b.title.trim()) patch.title = str(b.title, 120);
      if (typeof b.goal === 'string') patch.goal = str(b.goal, 600);
      if (b.config && typeof b.config === 'object') patch.config = b.config;
      return engine.updateBoard(+id, patch);
    }],
    ['DELETE', /^\/api\/boards\/(\d+)$/, ([id]) => ({ ok: repo.deleteBoard(+id) })],
    ['PUT', /^\/api\/boards\/(\d+)\/positions$/, ([id], b) => {
      if (!repo.getBoard(+id)) throw new AppError(404, 'not_found', 'Board not found');
      const positions = (Array.isArray(b.positions) ? b.positions : [])
        .filter((p: any) => Number.isInteger(p?.id) && Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map((p: any) => ({ id: p.id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
      repo.savePositions(+id, positions);
      return { ok: true, saved: positions.length };
    }],
    ['GET', /^\/api\/boards\/(\d+)\/export\.md$/, ([id], _b, url) => {
      const board = repo.getBoard(+id);
      if (!board) throw new AppError(404, 'not_found', 'Board not found');
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'sv';
      return { __raw: boardMarkdown(board, repo.listIdeas(board.id), repo.listEdges(board.id), lang), type: 'text/markdown; charset=utf-8' };
    }],
    ['POST', /^\/api\/boards\/(\d+)\/summary$/, ([id]) => engine.summarize(+id)],

    // ---- ideas
    ['POST', /^\/api\/boards\/(\d+)\/seed$/, ([id], b) => engine.seed(+id, b)],
    ['POST', /^\/api\/boards\/(\d+)\/documents$/, ([id], b) => engine.mineDocument(+id, b)],
    ['POST', /^\/api\/ideas\/(\d+)\/expand$/, ([id]) => engine.expand(+id)],
    ['POST', /^\/api\/boards\/(\d+)\/combine$/, ([id], b) => engine.combine(+id, b.a, b.b)],
    ['POST', /^\/api\/ideas\/(\d+)\/judge$/, ([id]) => engine.judge(+id)],
    ['PATCH', /^\/api\/ideas\/(\d+)$/, ([id], b) => {
      if (!('medalOverride' in b)) throw new AppError(400, 'bad_request', 'Nothing to change');
      return engine.setMedal(+id, b.medalOverride);
    }],
    ['DELETE', /^\/api\/ideas\/(\d+)$/, ([id]) => engine.deleteIdea(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/project$/, ([id]) => engine.createProject(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/reveal$/, ([id]) => engine.reveal(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/announce$/, ([id], b) => engine.announce(+id, b.boardIds)],
    ['POST', /^\/api\/ideas\/(\d+)\/spinoff$/, ([id]) => engine.spinoff(+id)],

    // ---- leads
    ['POST', /^\/api\/boards\/(\d+)\/leads\/(x|research)$/, ([id, source]) => engine.refreshLeads(+id, source as 'x' | 'research')],
    ['POST', /^\/api\/leads\/(\d+)\/seed$/, ([id], b) => engine.seedLead(+id, b)],
    ['DELETE', /^\/api\/leads\/(\d+)$/, ([id]) => ({ ok: repo.deleteLead(+id) })],

    // ---- dashboard: keyword trends across all boards
    ['GET', /^\/api\/dashboard$/, (_p, _b, url) => repo.dashboard(Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)))],
    ['GET', /^\/api\/keywords\/([^/]+)\/ideas$/, ([kw]) => ({ ideas: repo.ideasWithKeyword(decodeURIComponent(kw)) })],

    // ---- report: insights, ideas and projects across all boards
    ['GET', /^\/api\/report$/, (_p, _b, url) => repo.report(daysOf(url))],
    ['POST', /^\/api\/report\/synthesis$/, (_p, b) => engine.synthesize(Math.min(365, Math.max(1, Number(b.days) || 30)), b.lang === 'en' ? 'en' : 'sv')],
    ['GET', /^\/api\/report\.md$/, (_p, _b, url) => ({
      __raw: reportMarkdown(repo.report(daysOf(url)), url.searchParams.get('lang') === 'en' ? 'en' : 'sv'),
      type: 'text/markdown; charset=utf-8',
    })],

    // ---- flow templates
    ['GET', /^\/api\/templates$/, () => ({ templates: repo.listTemplates() })],
    ['POST', /^\/api\/templates$/, (_p, b) => ({ template: repo.createTemplate(templateBody(b)) })],
    ['PUT', /^\/api\/templates\/(\d+)$/, ([id], b) => ({ template: repo.updateTemplate(+id, templateBody(b)) })],
    ['DELETE', /^\/api\/templates\/(\d+)$/, ([id]) => {
      if (!repo.deleteTemplate(+id)) throw new AppError(400, 'last_template', 'The last template cannot be deleted');
      return { ok: true };
    }],
  ];

  function templateBody(b: any) {
    const t = { name: str(b.name, 80), system: str(b.system, 4000), expand: str(b.expand, 4000), combine: str(b.combine, 4000) };
    if (!t.name || !t.system || !t.expand || !t.combine) throw new AppError(400, 'bad_request', 'A template needs a name and all three prompts');
    return t;
  }

  /** Server-sent events: everything that happens on one board, live. */
  function events(boardId: number, req: IncomingMessage, res: ServerResponse) {
    if (!repo.getBoard(boardId)) return send(res, 404, { error: 'Board not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    streams.add(res);
    const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    write({ type: 'hello', autopilot: autopilot.status(boardId), ...usageStatus() });
    const off = engine.bus.on(boardId, write);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      off();
      clearInterval(ping);
      streams.delete(res);
    });
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(file);
      send(res, 200, data, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  const handler = async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const local = new URL(`http://${req.headers.host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(local.hostname) || Number(local.port || 80) !== req.socket.localPort) {
        throw new AppError(403, 'local_only', 'Use the local loopback address.');
      }
      const navigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' &&
        req.headers['sec-fetch-dest'] === 'document' && !url.pathname.startsWith('/api/');
      if ((req.headers['sec-fetch-site'] === 'cross-site' && !navigation) || (req.headers.origin && req.headers.origin !== local.origin)) {
        throw new AppError(403, 'bad_origin', 'Cross-origin access is not allowed.');
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(url.pathname, res);
      }
      if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '') && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        throw new AppError(415, 'json_required', 'Use application/json.');
      }
      const ev = url.pathname.match(/^\/api\/boards\/(\d+)\/events$/);
      if (ev && req.method === 'GET') return events(+ev[1], req, res);
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        const out: any = await fn(m.slice(1), body, url);
        if (out?.__raw !== undefined) return send(res, 200, out.__raw, out.type);
        return send(res, 200, out);
      }
      throw new AppError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
    } catch (e: any) {
      const status = e instanceof AppError ? e.status : e instanceof CopilotError ? 502 : 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e?.message ?? e);
      send(res, status, { error: e?.message ?? 'Server error', code: e?.code ?? 'server_error' });
    }
  };
  return Object.assign(handler, { closeStreams: () => { for (const stream of streams) stream.destroy(); } });
}
