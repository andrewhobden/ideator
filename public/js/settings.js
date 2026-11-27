// Only non-secret preferences live here. Copilot CLI owns authentication.
import { api } from './api.js';

const KEY = 'ideagen.settings.v2';
const LEGACY_KEY = 'ideagen.settings.v1';
export const ROLES = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief'];
export const DEFAULTS = {
  models: Object.fromEntries(ROLES.map((r) => [r, 'gpt-6.1-sol'])),
  projectsRoot: '~/Projekt/idea-projects',
  maxRequestsPerDay: 500,
};

export function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY) || '{}') || {};
  } catch {
    console.warn('Invalid saved settings; using Copilot defaults.');
  }
  const settings = {
    models: Object.fromEntries(ROLES.map((r) => [r, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(saved.models?.[r] ?? '') ? saved.models[r] : DEFAULTS.models[r]])),
    projectsRoot: typeof saved.projectsRoot === 'string' ? saved.projectsRoot : DEFAULTS.projectsRoot,
    maxRequestsPerDay: Number.isFinite(saved.maxRequestsPerDay) && saved.maxRequestsPerDay >= 0 ? Math.floor(saved.maxRequestsPerDay) : DEFAULTS.maxRequestsPerDay,
  };
  // Delete legacy browser API keys, including on an offline first load.
  localStorage.setItem(KEY, JSON.stringify(settings));
  localStorage.removeItem(LEGACY_KEY);
  return settings;
}

export function pushSettings(settings) {
  return api('PUT', '/api/runtime-settings', settings);
}

export async function saveSettings(settings) {
  const result = await pushSettings(settings);
  localStorage.setItem(KEY, JSON.stringify(settings));
  return result;
}
