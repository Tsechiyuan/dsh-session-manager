/**
 * Host half of the dsh-session-manager bundle.
 *
 * Three jobs:
 *
 * 1. Read-only bridge for values the Client cannot read itself: the immutable
 *    session header `createdAt` (the Client session list exposes `updatedAt`
 *    only), served on `GET /_dsh/session-manager/times`.
 *
 * 2. 个性化 (session settings) storage and routes. Settings have two scopes:
 *    one global profile that applies to every session, and one optional
 *    profile per workspace. A workspace profile either *overrides* the global
 *    one (only the workspace profile is injected) or stacks with it. The
 *    store is a small JSON file keyed by scope under
 *    `$DSH_HOME/storages/session_manager_settings.json`.
 *
 * 3. System-prompt injection and two agent tools. A dynamic section resolves
 *    the current session's workspace (`ctx.workspaceRegistry`) on every
 *    assembly and injects the effective profile; the tools read the effective
 *    profile and write only the workspace profile of the calling session
 *    (the global profile is UI-only).
 *
 * Routes (registered on the raw webserver, fenced like dsh-prompt / the study
 * timer; see `isAllowed` below):
 *
 *   GET  /_dsh/session-manager/times
 *     -> 200 { ok: true, value: { times: { [sessionId]: number } } }
 *
 *   GET  /_dsh/session-manager/settings
 *     -> 200 { ok: true, value: { global: SessionSettings|null, workspaces: { [workspaceId]: SessionSettings } } }
 *
 *   POST /_dsh/session-manager/settings
 *     body { scope: 'global', settings: {...} }
 *     body { scope: 'workspace', workspaceId: string, settings: {...} }
 *     -> 200 { ok: true, value: { scope, workspaceId?, settings: SessionSettings } }
 *
 *   POST /_dsh/session-manager/settings/clear
 *     body { scope: 'global' } | { scope: 'workspace', workspaceId: string }
 *     -> 200 { ok: true, value: { scope, workspaceId?, cleared: true } }
 *
 *   GET  /_dsh/session-manager/features
 *     -> 200 { ok: true, value: { features: FeatureFlags } }
 *
 *   POST /_dsh/session-manager/features
 *     body { features: FeatureFlags }
 *     -> 200 { ok: true, value: { features: FeatureFlags } }
 *
 * SessionSettings shape:
 *   { enabled: boolean, name: string, occupation: string, instructions: string, updatedAt: number }
 * Workspace settings additionally carry `override: boolean`.
 *
 * FeatureFlags switches the merged bundle's four client features on or off.
 * They are read once at plugin start (changing them needs a dsh web restart
 * because the Host half registers routes/tools/sections at startup), and the
 * `/features` route itself always stays available so the Plugins page can
 * flip them back.
 *
 * Nothing here participates in archiving or agent wake-up: the store is plain
 * JSON, and the times route only lists the live-preferred corpus
 * (`listSessions`), so opening the manager page can never wake a cold session.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-session-manager';
export const inject = ['webServer', 'systemPrompt', 'tools'];

const ROUTE_PREFIX = '/_dsh/session-manager';
const DATA_FILE = 'session_manager_settings.json';
const MAX_BODY_BYTES = 64 * 1024;

const NAME_LIMIT = 40;
const OCCUPATION_LIMIT = 60;
const INSTRUCTIONS_LIMIT = 1500;

const PROFILE_SECTION = 'session-manager:profile';
/** Persona (0) → settings (450) → plan policy (500) → tool policy (1000+). */
const PROFILE_ORDER = 450;

const TOOL_GET = 'session_settings_get';
const TOOL_UPDATE = 'session_settings_update';

const WRITABLE_FIELDS = ['enabled', 'name', 'occupation', 'instructions', 'override'];

/** Four merged client features. Read once at startup (apply). */
const FEATURE_KEYS = ['page', 'settings', 'sidebarRecent', 'sidebarHide'];
const DEFAULT_FEATURES = { page: true, settings: true, sidebarRecent: true, sidebarHide: true };

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(host) {
  let hostname = String(host).trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end >= 0 ? hostname.slice(0, end + 1) : hostname;
    return hostname === '[::1]';
  }
  hostname = hostname.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || /^127\./.test(hostname);
}

/**
 * Same-origin fence for the raw webserver route. The webserver does not
 * authenticate raw routes, so accept only requests that reached a loopback
 * host and do not originate from another site.
 */
function isAllowed(req) {
  try {
    const host = headerValue(req.headers.host);
    if (!host || !isLoopbackHost(host)) return false;
    const site = headerValue(req.headers['sec-fetch-site']);
    if (site === 'cross-site') return false;
    const origin = headerValue(req.headers.origin);
    if (!origin) return true;
    return new URL(origin).host.toLowerCase() === String(host).trim().toLowerCase();
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* settings store                                                      */
/* ------------------------------------------------------------------ */

function emptyFeatures() {
  return { ...DEFAULT_FEATURES };
}

function coerceFeatures(value) {
  const features = emptyFeatures();
  if (!value || typeof value !== 'object') return features;
  for (const key of FEATURE_KEYS) {
    if (typeof value[key] === 'boolean') features[key] = value[key];
  }
  return features;
}

function snapshotFeatures(store) {
  return { ...store.features };
}

function mergeFeatures(base, patch) {
  if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'invalid_features', 'features must be an object');
  }
  const next = { ...base };
  let touched = false;
  for (const key of FEATURE_KEYS) {
    if (!(key in patch)) continue;
    if (typeof patch[key] !== 'boolean') throw new HttpError(400, 'invalid_features', `${key} must be a boolean`);
    next[key] = patch[key];
    touched = true;
  }
  if (!touched) throw new HttpError(400, 'invalid_features', 'features does not contain any known field');
  return next;
}

function emptySettings(withOverride) {
  const settings = { enabled: true, name: '', occupation: '', instructions: '', updatedAt: 0 };
  if (withOverride) settings.override = false;
  return settings;
}

function coerceSettings(value, withOverride, now) {
  const base = emptySettings(withOverride);
  if (!value || typeof value !== 'object') return base;
  if (typeof value.enabled === 'boolean') base.enabled = value.enabled;
  if (typeof value.name === 'string') base.name = value.name.slice(0, NAME_LIMIT);
  if (typeof value.occupation === 'string') base.occupation = value.occupation.slice(0, OCCUPATION_LIMIT);
  if (typeof value.instructions === 'string') base.instructions = value.instructions.slice(0, INSTRUCTIONS_LIMIT);
  if (withOverride && value.override === true) base.override = true;
  base.updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now;
  return base;
}

function homePathResolver(ctx) {
  const raw = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined;
  if (typeof raw === 'function') return raw;
  return (segment) => join(process.env.DSH_HOME || join(homedir(), '.dsh'), segment);
}

function createStore(ctx) {
  const homePath = homePathResolver(ctx);
  const file = join(homePath('storages'), DATA_FILE);
  const store = {
    file,
    global: null,
    workspaces: {},
    features: emptyFeatures(),
    chain: Promise.resolve(),
  };

  try {
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    const extra = parsed && typeof parsed === 'object' ? parsed : null;
    if (extra && extra.features) store.features = coerceFeatures(extra.features);
    if (extra && extra.global && typeof extra.global === 'object') {
      store.global = coerceSettings(extra.global, false, 0);
    }
    const workspaces = extra && extra.workspaces && typeof extra.workspaces === 'object' ? extra.workspaces : null;
    if (workspaces) {
      for (const workspaceId of Object.keys(workspaces)) {
        if (typeof workspaceId !== 'string' || workspaceId === '') continue;
        store.workspaces[workspaceId] = coerceSettings(workspaces[workspaceId], true, 0);
      }
    }
    /* version 1 (per-session) entries under `sessions` are intentionally
     * ignored: per-session settings were replaced by the global/workspace
     * model. */
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      try {
        console.warn('[dsh-session-manager] could not read session settings; starting with an empty store', error);
      } catch {
        /* console may be stubbed */
      }
    }
  }

  return store;
}

function snapshotGlobal(store) {
  return store.global === null ? null : { ...store.global };
}

function snapshotWorkspaces(store) {
  const out = {};
  for (const workspaceId of Object.keys(store.workspaces)) out[workspaceId] = { ...store.workspaces[workspaceId] };
  return out;
}

function invalid(message) {
  return new HttpError(400, 'invalid_settings', message);
}

function readLimitedString(patch, field, limit, label) {
  if (!(field in patch)) return undefined;
  const value = patch[field];
  if (typeof value !== 'string') throw invalid(`${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw invalid(`${label} is longer than ${limit} characters`);
  return trimmed;
}

function mergeSettings(base, patch, withOverride) {
  if (patch === undefined || patch === null) patch = {};
  if (typeof patch !== 'object' || Array.isArray(patch)) throw invalid('settings must be an object');
  const next = { ...base };
  let touched = false;

  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw invalid('enabled must be a boolean');
    next.enabled = patch.enabled;
    touched = true;
  }
  const name = readLimitedString(patch, 'name', NAME_LIMIT, 'name');
  if (name !== undefined) {
    next.name = name;
    touched = true;
  }
  const occupation = readLimitedString(patch, 'occupation', OCCUPATION_LIMIT, 'occupation');
  if (occupation !== undefined) {
    next.occupation = occupation;
    touched = true;
  }
  const instructions = readLimitedString(patch, 'instructions', INSTRUCTIONS_LIMIT, 'instructions');
  if (instructions !== undefined) {
    next.instructions = instructions;
    touched = true;
  }
  if (withOverride && 'override' in patch) {
    if (typeof patch.override !== 'boolean') throw invalid('override must be a boolean');
    next.override = patch.override;
    touched = true;
  }

  if (!touched) {
    for (const field of WRITABLE_FIELDS) {
      if (field in patch) touched = true;
    }
    if (!touched) throw invalid('settings does not contain any known field');
  }

  next.updatedAt = Date.now();
  return next;
}

function normalizeWorkspaceId(value) {
  if (typeof value !== 'string' || value === '' || value.length > 200) {
    throw new HttpError(400, 'invalid_workspace', 'workspaceId must be a non-empty string');
  }
  return value;
}

/** Serialize every mutation through one chain so concurrent writes cannot lose updates. */
function enqueue(store, task) {
  const run = store.chain.then(task);
  store.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function persist(store) {
  return enqueue(store, async () => {
    const payload = JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      global: store.global,
      workspaces: store.workspaces,
      features: store.features,
    });
    await mkdir(dirname(store.file), { recursive: true });
    const temp = `${store.file}.tmp-${process.pid}-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)}`;
    await writeFile(temp, payload, 'utf8');
    await rename(temp, store.file);
  });
}

function workspaceRegistryOf(ctx) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    return registry && typeof registry.list === 'function' ? registry : null;
  } catch {
    return null;
  }
}

function findWorkspaceForSession(registry, sessionId) {
  if (!registry || typeof registry.list !== 'function') return undefined;
  try {
    for (const workspace of registry.list()) {
      if (!workspace || !Array.isArray(workspace.sessionIds)) continue;
      if (workspace.sessionIds.includes(sessionId)) return workspace;
    }
  } catch {
    /* registry unavailable; treat the session as ungrouped */
  }
  return undefined;
}

function workspaceExists(ctx, workspaceId) {
  const registry = workspaceRegistryOf(ctx);
  if (!registry) return true; /* cannot validate without a registry; accept */
  if (typeof registry.get !== 'function') return true;
  try {
    return registry.get(workspaceId) !== undefined;
  } catch {
    return false;
  }
}

async function updateSettings(store, ctx, scope, workspaceId, patch) {
  let saved;
  await enqueue(store, async () => {
    if (scope === 'global') {
      const base = store.global || emptySettings(false);
      saved = mergeSettings(base, patch, false);
      store.global = saved;
      return;
    }
    if (!workspaceExists(ctx, workspaceId)) {
      throw new HttpError(400, 'unknown_workspace', 'workspace does not exist');
    }
    const base = store.workspaces[workspaceId] || emptySettings(true);
    saved = mergeSettings(base, patch, true);
    store.workspaces[workspaceId] = saved;
  });
  await persist(store);
  return saved;
}

async function clearSettings(store, scope, workspaceId) {
  let cleared = false;
  await enqueue(store, async () => {
    if (scope === 'global') {
      if (store.global !== null) {
        store.global = null;
        cleared = true;
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(store.workspaces, workspaceId)) {
      delete store.workspaces[workspaceId];
      cleared = true;
    }
  });
  if (cleared) await persist(store);
  return cleared;
}

/* ------------------------------------------------------------------ */
/* effective profile                                                   */
/* ------------------------------------------------------------------ */

function settingsParts(settings) {
  const parts = [];
  if (typeof settings.name === 'string' && settings.name !== '') {
    parts.push(`- 会话称呼：请称呼我为「${settings.name}」。`);
  }
  if (typeof settings.occupation === 'string' && settings.occupation !== '') {
    parts.push(`- 我的职业：${settings.occupation}。请在讲解深度、术语和举例上适配这一身份。`);
  }
  if (typeof settings.instructions === 'string' && settings.instructions !== '') {
    const indented = settings.instructions
      .split('\n')
      .map((line) => (line === '' ? '' : `  ${line}`))
      .join('\n');
    parts.push(`- 给模型的指令（请严格遵守）：\n${indented}`);
  }
  return parts;
}

function formatSettingsBlock(heading, settings) {
  const parts = settingsParts(settings);
  if (parts.length === 0) return null;
  return [`### ${heading}`, ...parts].join('\n');
}

/**
 * Resolve the effective profile for one session:
 * - workspace profile with `override: true` replaces the global profile;
 * - otherwise the global profile and the workspace profile stack
 *   (global first, then the workspace block);
 * - sessions outside every workspace (ungrouped / subagents) see global only.
 */
function effectiveSettings(store, registry, sessionId) {
  const workspace = findWorkspaceForSession(registry, sessionId);
  const workspaceSettings = workspace && store.workspaces[workspace.id] ? store.workspaces[workspace.id] : null;
  const globalSettings = store.global;

  if (workspaceSettings && workspaceSettings.override === true) {
    if (workspaceSettings.enabled === false) {
      return { text: '', sources: 'none', workspace, workspaceSettings, globalSettings, overridden: true };
    }
    const block = formatSettingsBlock(`工作区设定（${workspace.title}）`, workspaceSettings);
    return {
      text: block === null ? '' : ['## 个性化', '以下是用户为本会话保存的个性化设定，请按此调整回复：', block].join('\n'),
      sources: 'workspace',
      workspace,
      workspaceSettings,
      globalSettings,
      overridden: true,
    };
  }

  const blocks = [];
  if (globalSettings && globalSettings.enabled !== false) {
    const block = formatSettingsBlock('全局设定', globalSettings);
    if (block !== null) blocks.push(block);
  }
  if (workspaceSettings && workspaceSettings.enabled !== false) {
    const block = formatSettingsBlock(`工作区设定（${workspace.title}）`, workspaceSettings);
    if (block !== null) blocks.push(block);
  }

  const sources = [];
  if (blocks.length > 0 && globalSettings && globalSettings.enabled !== false && settingsParts(globalSettings).length > 0) {
    sources.push('global');
  }
  if (blocks.length > 0 && workspaceSettings && workspaceSettings.enabled !== false && settingsParts(workspaceSettings).length > 0) {
    sources.push('workspace');
  }

  return {
    text: blocks.length === 0 ? '' : ['## 个性化', '以下是用户为本会话保存的个性化设定，请按此调整回复：', ...blocks].join('\n'),
    sources: sources.length === 0 ? 'none' : sources.join('+'),
    workspace,
    workspaceSettings,
    globalSettings,
    overridden: false,
  };
}

function createProfileSection(store, ctx) {
  return {
    name: PROFILE_SECTION,
    order: PROFILE_ORDER,
    interpolate: false,
    text: (context) => {
      try {
        if (snapshotFeatures(store).settings !== true) return '';
        const agent = context && context.agent;
        const session = agent && agent.session;
        const sessionId = session && session.id;
        if (typeof sessionId !== 'string' || sessionId === '') return '';
        return effectiveSettings(store, workspaceRegistryOf(ctx), sessionId).text;
      } catch {
        return '';
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* agent tools                                                         */
/* ------------------------------------------------------------------ */

function sessionIdOf(exec) {
  const agent = exec && exec.agent;
  const session = agent && agent.session;
  const id = session && session.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function settingsValue(settings, withOverride) {
  const value = {
    configured: settings !== undefined && settings !== null,
    enabled: settings ? settings.enabled !== false : true,
    name: settings && typeof settings.name === 'string' ? settings.name : '',
    occupation: settings && typeof settings.occupation === 'string' ? settings.occupation : '',
    instructions: settings && typeof settings.instructions === 'string' ? settings.instructions : '',
  };
  if (withOverride) value.override = settings ? settings.override === true : false;
  return value;
}

const SETTINGS_STATE_SCHEMA = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    workspaceId: { type: 'string' },
    workspaceTitle: { type: 'string' },
    sources: { type: 'string' },
    override: { type: 'boolean' },
    effectivePrompt: { type: 'string' },
    global: {
      type: 'object',
      properties: {
        configured: { type: 'boolean' },
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        occupation: { type: 'string' },
        instructions: { type: 'string' },
      },
      required: ['configured', 'enabled', 'name', 'occupation', 'instructions'],
      additionalProperties: false,
    },
    workspace: {
      type: 'object',
      properties: {
        configured: { type: 'boolean' },
        enabled: { type: 'boolean' },
        name: { type: 'string' },
        occupation: { type: 'string' },
        instructions: { type: 'string' },
        override: { type: 'boolean' },
      },
      required: ['configured', 'enabled', 'name', 'occupation', 'instructions', 'override'],
      additionalProperties: false,
    },
  },
  required: ['sessionId', 'workspaceId', 'workspaceTitle', 'sources', 'override', 'effectivePrompt', 'global', 'workspace'],
  additionalProperties: false,
};

function stateValue(store, registry, sessionId) {
  const effective = effectiveSettings(store, registry, sessionId);
  return {
    sessionId,
    workspaceId: effective.workspace ? effective.workspace.id : '',
    workspaceTitle: effective.workspace ? effective.workspace.title : '',
    sources: effective.sources,
    override: effective.overridden,
    effectivePrompt: effective.text,
    global: settingsValue(effective.globalSettings, false),
    workspace: settingsValue(effective.workspaceSettings, true),
  };
}

function renderState(args, value) {
  const lines = ['本会话生效的「个性化」：'];
  lines.push(`- 工作区：${value.workspaceId === '' ? '（不属于任何工作区）' : `${value.workspaceTitle}（${value.workspaceId}）`}`);
  lines.push(`- 生效来源：${value.sources}`);
  lines.push(`- 覆盖全局：${value.override ? '是（只使用工作区设定）' : '否（全局 + 工作区叠加）'}`);
  lines.push(`- 全局设定：${value.global.configured ? `名称「${value.global.name || '未设置'}」，职业「${value.global.occupation || '未设置'}」` : '未保存'}`);
  lines.push(`- 工作区设定：${value.workspace.configured ? `名称「${value.workspace.name || '未设置'}」，职业「${value.workspace.occupation || '未设置'}」` : '未保存'}`);
  lines.push(`- 注入系统提示的文本：${value.effectivePrompt === '' ? '（空，不会注入）' : '\n' + value.effectivePrompt.split('\n').map((line) => `  ${line}`).join('\n')}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

function createGetTool(store, ctx) {
  return {
    name: TOOL_GET,
    description:
      '读取当前会话生效的「个性化」（全局设定 + 工作区设定，返回 effectivePrompt 即本轮注入系统提示的文本）。设定由用户在 DSH 的「会话管理」/「个性化」页面按全局或工作区保存。只读取调用方所在的会话。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: SETTINGS_STATE_SCHEMA,
      render: renderState,
    },
    execute: async (args, exec) => {
      if (snapshotFeatures(store).settings !== true) throw new Error('个性化功能已在插件配置中关闭');
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('session_settings_get 只能在会话内调用');
      return stateValue(store, workspaceRegistryOf(ctx), sessionId);
    },
    isConcurrencySafe: () => true,
  };
}

function createUpdateTool(store, ctx) {
  return {
    name: TOOL_UPDATE,
    description:
      '修改当前会话所属工作区的「个性化」（不是全局设定，全局设定只能由用户在页面修改，因此不要尝试通过本工具改全局）。当用户在对话里表达称呼、职业或长期指令偏好（例如「请称呼我为…」「以后叫我…」「我的职业是…」「回答时请…」）时，不要直接调用本工具；先在回复中询问用户是否要把这条偏好写入当前工作区的「个性化」设定（例如：「要我把称呼『…』保存到当前工作区的个性化设定吗？保存后从下一轮请求生效。」）。只有用户明确确认写入，或用户本来就明确要求修改该工作区设定时，才调用本工具；用户未确认或拒绝时不要调用。未提供的工作区设定字段保持原值；override=true 表示只用工作区设定替换全局设定，false 表示与全局设定叠加。修改从下一轮请求开始生效，且只影响该工作区下的会话。字段：enabled 总开关、name 会话称呼（最多 40 字）、occupation 职业（最多 60 字）、instructions 给模型的指令（最多 1500 字）、override 是否覆盖全局。',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: '总开关；false 时该工作区设定不会注入系统提示。' },
        name: { type: 'string', maxLength: NAME_LIMIT, description: '会话称呼，最多 40 字。' },
        occupation: { type: 'string', maxLength: OCCUPATION_LIMIT, description: '职业，最多 60 字。' },
        instructions: { type: 'string', maxLength: INSTRUCTIONS_LIMIT, description: '给模型的指令，最多 1500 字。' },
        override: { type: 'boolean', description: 'true 表示只注入工作区设定（覆盖全局）；false 表示与全局设定叠加。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SETTINGS_STATE_SCHEMA,
      render: (args, value) => {
        const lines = ['已更新当前会话所属工作区的「个性化」，将从下一轮请求起生效：'];
        lines.push(`- 工作区：${value.workspaceTitle}（${value.workspaceId}）`);
        lines.push(`- 覆盖全局：${value.override ? '是' : '否'}`);
        lines.push(`- 工作区设定：总开关${value.workspace.enabled ? '开启' : '关闭'}，称呼「${value.workspace.name || '未设置'}」，职业「${value.workspace.occupation || '未设置'}」`);
        if (value.sources === 'none') lines.push('- 注意：当前工作区设定为空或已关闭，注入文本为空。');
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    execute: async (args, exec) => {
      if (snapshotFeatures(store).settings !== true) throw new Error('个性化功能已在插件配置中关闭');
      const sessionId = sessionIdOf(exec);
      if (sessionId === null) throw new Error('session_settings_update 只能在会话内调用');
      const registry = workspaceRegistryOf(ctx);
      const workspace = findWorkspaceForSession(registry, sessionId);
      if (!workspace) {
        throw new Error('session_settings_update: 当前会话不属于任何工作区，无法写入工作区设定；请让用户在页面上修改全局设定');
      }
      const patch = args === null || args === undefined ? {} : args;
      await updateSettings(store, ctx, 'workspace', workspace.id, patch);
      return stateValue(store, registry, sessionId);
    },
  };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read every corpus header and collect `createdAt`. Returns null when the
 * session-query service is missing (plain `dsh`, or a deployment without the
 * persistence/query bundle) so the route can answer "unavailable" honestly.
 */
async function collectCreationTimes(ctx) {
  const query = ctx.get('sessionQuery');
  if (query === undefined || query === null || typeof query.listSessions !== 'function') {
    return null;
  }
  const records = await query.listSessions();
  const times = {};
  for (const record of Array.isArray(records) ? records : []) {
    const header = record && record.header;
    if (!header || typeof header.id !== 'string' || header.id === '') continue;
    if (typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) && header.createdAt > 0) {
      times[header.id] = header.createdAt;
    }
  }
  return times;
}

function readScope(body) {
  if (!body || typeof body !== 'object') throw invalid('body must be an object');
  const scope = body.scope;
  if (scope === 'global') return { scope, workspaceId: '' };
  if (scope === 'workspace') {
    return { scope, workspaceId: normalizeWorkspaceId(body.workspaceId) };
  }
  throw invalid('scope must be "global" or "workspace"');
}

async function updateFeatures(store, patch) {
  const next = mergeFeatures(store.features, patch);
  store.features = next;
  await persist(store);
  return snapshotFeatures(store);
}

async function handleSettingsRoutes(ctx, store, req, res, path, method) {
  const features = snapshotFeatures(store);
  if (path === `${ROUTE_PREFIX}/features`) {
    if (method === 'GET' || method === 'HEAD') {
      writeJson(res, 200, { ok: true, value: { features: snapshotFeatures(store) } });
      return true;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.features) {
        throw new HttpError(400, 'invalid_features', 'body must be { features: {...} }');
      }
      const features = await updateFeatures(store, body.features);
      writeJson(res, 200, { ok: true, value: { features } });
      return true;
    }
    return false;
  }

  if (!features.page && path === `${ROUTE_PREFIX}/times`) return false;
  if (!features.settings && (path === `${ROUTE_PREFIX}/settings` || path === `${ROUTE_PREFIX}/settings/clear`)) {
    return false;
  }

  if (path === `${ROUTE_PREFIX}/times` && (method === 'GET' || method === 'HEAD')) {
    const times = await collectCreationTimes(ctx);
    if (times === null) {
      writeJson(res, 503, { ok: false, error: { code: 'unavailable', message: 'session query service is not available' } });
      return true;
    }
    writeJson(res, 200, { ok: true, value: { times } });
    return true;
  }

  if (path === `${ROUTE_PREFIX}/settings` && (method === 'GET' || method === 'HEAD')) {
    writeJson(res, 200, { ok: true, value: { global: snapshotGlobal(store), workspaces: snapshotWorkspaces(store) } });
    return true;
  }

  if (path === `${ROUTE_PREFIX}/settings` && method === 'POST') {
    const body = await readJsonBody(req);
    const scope = readScope(body);
    const settings = await updateSettings(store, ctx, scope.scope, scope.workspaceId, body && body.settings);
    writeJson(res, 200, {
      ok: true,
      value: scope.scope === 'global' ? { scope: 'global', settings } : { scope: 'workspace', workspaceId: scope.workspaceId, settings },
    });
    return true;
  }

  if (path === `${ROUTE_PREFIX}/settings/clear` && method === 'POST') {
    const body = await readJsonBody(req);
    const scope = readScope(body);
    const cleared = await clearSettings(store, scope.scope, scope.workspaceId);
    writeJson(res, 200, {
      ok: true,
      value: scope.scope === 'global' ? { scope: 'global', cleared } : { scope: 'workspace', workspaceId: scope.workspaceId, cleared },
    });
    return true;
  }

  return false;
}

function createRoute(ctx, store) {
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        if (!isAllowed(req)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'untrusted host' } });
          return;
        }
        const rawUrl = typeof req.url === 'string' ? req.url : '';
        const path = (rawUrl.split('?')[0] || '/').replace(/\/+$/, '') || '/';
        const method = String(req.method || 'GET').toUpperCase();
        const handled = await handleSettingsRoutes(ctx, store, req, res, path, method);
        if (!handled) writeJson(res, 404, { ok: false, error: { code: 'not_found', message: 'unknown route' } });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal';
        try {
          writeJson(res, status, {
            ok: false,
            error: { code, message: error instanceof Error ? error.message : String(error) },
          });
        } catch {
          /* response already gone */
        }
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

function effect(ctx, label, register) {
  try {
    ctx.effect(register, label);
  } catch (error) {
    try {
      console.warn(`[dsh-session-manager] could not register ${label}`, error);
    } catch {
      /* console may be stubbed */
    }
  }
}

export function apply(ctx) {
  const store = createStore(ctx);
  /* Feature switches are read live (store.features): the routes, the prompt
   * section and the tools stay registered and gate their own behavior, so
   * flipping a switch in the plugin config row takes effect immediately. */

  effect(ctx, 'dsh-session-manager: session routes', () => {
    const dispose = ctx.webServer.register(createRoute(ctx, store));
    return () => {
      try {
        dispose();
      } catch {
        /* already removed */
      }
    };
  });

  effect(ctx, 'dsh-session-manager: session profile section', () => {
    const section = createProfileSection(store, ctx);
    const dispose = ctx.systemPrompt.section(section);
    return () => {
      try {
        dispose();
      } catch {
        /* already removed */
      }
    };
  });

  effect(ctx, 'dsh-session-manager: session settings tools', () => {
    const disposers = [ctx.tools.register(createGetTool(store, ctx)), ctx.tools.register(createUpdateTool(store, ctx))];
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* already removed */
        }
      }
    };
  });
}
