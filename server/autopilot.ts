// Server-side autopilot for boards in automatic mode, with a rate limiter.
//
// Limits, checked in this order before every step:
//   1. global application AI requests per local day (across all boards)
//   2. the board's application AI requests per local day
//   3. error backoff (30 s, doubling, max 15 min)
//   4. the board's steps per hour (sliding window)
//   5. the board's pace (seconds between steps)
// The engine also reserves each request, so parallel/manual calls obey the caps.

import type { Repo } from './db.ts';
import type { Engine } from './engine.ts';
import type { AppSettings } from './copilot.ts';

export type RateInput = {
  now: number;
  steps: number[];
  lastAt: number;
  paceSeconds: number;
  stepsPerHour: number;
  boardRequests: number;
  boardRequestsPerDay: number;
  globalRequests: number;
  globalRequestsPerDay: number;
  errors: number;
  lastErrorAt: number;
};
export type RateDecision =
  | { ok: true }
  | { ok: false; reason: 'global_requests' | 'board_requests' | 'backoff' | 'hourly' | 'pace'; until: number };

const HOUR = 3_600_000;

export function nextLocalMidnight(now: number) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function backoffMs(errors: number) {
  return errors > 0 ? Math.min(15 * 60_000, 30_000 * 2 ** (errors - 1)) : 0;
}

/** Pure: may this board take a step now? */
export function rateCheck(i: RateInput): RateDecision {
  if (i.globalRequests >= i.globalRequestsPerDay) return { ok: false, reason: 'global_requests', until: nextLocalMidnight(i.now) };
  if (i.boardRequests >= i.boardRequestsPerDay) return { ok: false, reason: 'board_requests', until: nextLocalMidnight(i.now) };
  if (i.errors > 0 && i.now < i.lastErrorAt + backoffMs(i.errors)) {
    return { ok: false, reason: 'backoff', until: i.lastErrorAt + backoffMs(i.errors) };
  }
  const recent = i.steps.filter((t) => t > i.now - HOUR);
  if (recent.length >= i.stepsPerHour) return { ok: false, reason: 'hourly', until: Math.min(...recent) + HOUR };
  if (i.now < i.lastAt + i.paceSeconds * 1000) return { ok: false, reason: 'pace', until: i.lastAt + i.paceSeconds * 1000 };
  return { ok: true };
}

export type AutopilotStatus = {
  /** manual | running | idle | error | pace | hourly | backoff | board_requests | global_requests */
  state: string;
  until?: number;
  code?: string;
  message?: string;
  last?: string;
  stepsLastHour?: number;
  requestsToday?: number;
};

type BoardState = { busy: boolean; steps: number[]; lastAt: number; errors: number; lastErrorAt: number; status: AutopilotStatus; sent: string };

export function createAutopilot(deps: { repo: Repo; engine: Engine; settings: () => AppSettings; now?: () => number; tickMs?: number }) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const states = new Map<number, BoardState>();
  const pending = new Set<Promise<void>>();

  function publish(boardId: number, s: BoardState, status: AutopilotStatus) {
    s.status = status;
    const json = JSON.stringify(status);
    if (json === s.sent) return; // do not repeat the same status every tick
    s.sent = json;
    engine.bus.emit(boardId, { type: 'autopilot', status });
  }

  async function tick() {
    const t = now();
    const globalRequests = repo.requestsOn(null);
    for (const b of repo.listBoards()) {
      if (b.config.mode !== 'auto') {
        if (states.delete(b.id)) engine.bus.emit(b.id, { type: 'autopilot', status: { state: 'manual' } });
        continue;
      }
      let s = states.get(b.id);
      if (!s) {
        s = { busy: false, steps: [], lastAt: 0, errors: 0, lastErrorAt: 0, status: { state: 'idle' }, sent: '' };
        states.set(b.id, s);
      }
      if (s.busy) continue;
      s.steps = s.steps.filter((x) => x > t - HOUR);
      const boardRequests = repo.requestsOn(b.id);
      const counts = { stepsLastHour: s.steps.length, requestsToday: boardRequests };
      const d = rateCheck({
        now: t, steps: s.steps, lastAt: s.lastAt, paceSeconds: b.config.autopilotSeconds,
        stepsPerHour: b.config.rate.stepsPerHour, boardRequests, boardRequestsPerDay: b.config.rate.requestsPerDay,
        globalRequests, globalRequestsPerDay: deps.settings().maxRequestsPerDay, errors: s.errors, lastErrorAt: s.lastErrorAt,
      });
      if (!d.ok) {
        // Keep the last result visible while merely pacing.
        if (d.reason === 'pace' && (s.status.state === 'idle' || s.status.state === 'error')) continue;
        publish(b.id, s, { state: d.reason, until: d.until, last: s.status.last, ...counts });
        continue;
      }
      s.busy = true;
      publish(b.id, s, { state: 'running', last: s.status.last, ...counts });
      const st = s;
      const task = engine
        .autoStep(b.id)
        .then((r) => {
          if (r.did !== 'idle') st.steps.push(now());
          st.lastAt = now();
          st.errors = 0;
          publish(b.id, st, {
            state: r.did === 'idle' ? 'idle' : 'pace', until: now() + b.config.autopilotSeconds * 1000,
            last: r.did === 'idle' ? r.reason : r.did, stepsLastHour: st.steps.length, requestsToday: repo.requestsOn(b.id),
          });
        })
        .catch((e: any) => {
          st.errors++;
          st.lastErrorAt = st.lastAt = now();
          publish(b.id, st, { state: 'error', code: e?.code ?? 'error', message: e?.message ?? String(e), until: now() + backoffMs(st.errors), ...counts });
        })
        .finally(() => {
          st.busy = false;
          pending.delete(task);
        });
      pending.add(task);
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    tick,
    start() {
      timer ??= setInterval(() => tick().catch((e) => console.error('[autopilot]', e)), deps.tickMs ?? 1000);
      return this;
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all(pending);
    },
    status(boardId: number): AutopilotStatus {
      return states.get(boardId)?.status ?? { state: 'manual' };
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
