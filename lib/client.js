/**
 * dsh-session-manager — client half.
 *
 * Two global main panels (registered on `main`, selected through `ctx.layout`):
 * 「会话管理」as a sidebar navigation entry (`sidebar.panellist`, order 11,
 * right below 「自动化任务」), and 「会话设定」as a row in the sidebar's
 * More menu (`sidebar.panellist.actions`, order 12).
 *
 * The page is a two-pane directory-picker shape: the left column lists
 * workspaces (plus 全部会话 / 未分组), the right column lists the sessions of
 * the selected workspace. Rows expose open / archive / pin / copy-id, and a
 * click opens a full-width, read-only second level that renders the recent
 * transcript through `remote.session.events` — never through
 * `ctx.sessions.retain()`, which would activate the session and wake its
 * agent. A selection mode turns the list into a batch surface for archive /
 * unarchive. Pinning goes through `ctx.workspaces.pinSession`, so the
 * manager and the workspace column share one Host-side pin set. Renames are
 * committed through `ctx.sessions.using(..., { source: 'workspaceOperation' })`
 * — the same sanctioned path the workspace browser uses; the manager never
 * retains a session with activation.
 *
 * Rows also show the creation time and the last-used time. Creation times
 * come from the host half's read-only `/_dsh/session-manager/times` bridge
 * (the client Session summary carries `updatedAt` only, never the immutable
 * header `createdAt`); the last-used time is
 * `sessionListMetadata.lastPromptAt`, falling back to `updatedAt`.
 *
 * v0.4.0 turns 「设定」 into global + workspace session settings (enabled /
 * 称呼 / 职业 / 给模型的指令, workspace may override global), stored by the host
 * half under `$DSH_HOME/storages/session_manager_settings.json` and injected
 * into the matching sessions' system prompts on every assembly. The page only
 * reads/writes `/_dsh/session-manager/settings`; nothing here can wake an
 * agent.
 *
 * v0.5.0 merges the former `dsh-workspace-focus` plugin (sidebar 「只显示最近
 * 工作区」 / 「手动隐藏工作区」 filters) into this single package and exposes
 * four feature switches through the `plugins.row.config` keyed slot. The
 * manager keeps its navigation entry; 「会话设定」 sits in the sidebar's More
 * menu (`sidebar.panellist.actions`). Feature state is read live by both
 * halves, so saving a switch takes effect immediately; only code changes need
 * a `dsh web` restart.
 *
 * v0.5.3 prefills an empty 「会话称呼」 from the signed-in DeepSeek account
 * profile (`ctx.remote.account.getProfile`, resolved lazily so a missing
 * account namespace or a signed-out state simply leaves the field empty). The
 * prefill only touches the form draft; the name is persisted when the user
 * saves the scope.
 *
 * This module is a lazy-CJS bundle: the factory only runs when the harness
 * materializes it. Only `react` and (best effort) the primitives passthrough
 * are required; both are runtime seed modules, not Harness plugin packages.
 */

(function () {
  var root = typeof window !== 'undefined' ? window : null;
  if (root === null || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-session-manager',
    factory(require) {
      var module = { exports: {} };
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useLayoutEffect = React.useLayoutEffect;
      var useRef = React.useRef;
      var useMemo = React.useMemo;
      var useCallback = React.useCallback;
      var useSyncExternalStore = React.useSyncExternalStore;

      var primitives = null;
      try {
        primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      } catch (error) {
        primitives = null;
      }

      var NS = 'dsh-session-manager';
      var NAV_ORDER = 11;
      var PANEL_ID = 'session-manager';
      var TIMES_ROUTE = '/_dsh/session-manager/times';
      var PAGE_SIZE = 30;
      var TOOL_TEXT_LIMIT = 4000;
      var SETTINGS_ROUTE = '/_dsh/session-manager/settings';
      var SETTINGS_CLEAR_ROUTE = '/_dsh/session-manager/settings/clear';
      var GLOBAL_SCOPE_KEY = '__global__';
      var FEATURES_ROUTE = '/_dsh/session-manager/features';
      var SETTINGS_PANEL_ID = 'session-settings';
      var SETTINGS_MENU_ORDER = 12;
      var BUNDLE_KEY = 'dsh-session-manager#dsh-session-manager';
      var FEATURE_DEFAULTS = { page: true, settings: true, sidebarRecent: true, sidebarHide: true };
      var openSettingsPanelFromMenu = null;
      var NAME_LIMIT = 40;
      var OCCUPATION_LIMIT = 60;
      var INSTRUCTIONS_LIMIT = 1500;
      var OCCUPATION_PRESET_KEYS = [
        'settings.occupation.teacher',
        'settings.occupation.student',
        'settings.occupation.engineer',
        'settings.occupation.product',
        'settings.occupation.designer',
        'settings.occupation.operations',
        'settings.occupation.researcher',
        'settings.occupation.freelance',
      ];

      /* ------------------------------------------------------------------ */
      /* copy                                                                */
      /* ------------------------------------------------------------------ */

      var UI_ZH = {
        'panel.title': '会话管理',
        'panel.caption': '按工作区浏览会话，或设置全局 / 工作区的会话设定',
        'scope.all': '全部会话',
        'scope.ungrouped': '未分组',
        'scope.count': '{n} 个会话',
        'scope.matches': '{n} 个匹配',
        'filter.active': '未归档',
        'filter.all': '全部',
        'filter.archived': '仅已归档',
        'search.placeholder': '搜索会话标题',
        'row.archived': '已归档',
        'row.running': '进行中',
        'row.tokens': '{n} tokens',
        'row.created': '创建 {time}',
        'row.createdUnknown': '创建时间未知',
        'row.createdTitle': '创建时间',
        'row.lastUsed': '上次使用 {time}',
        'action.open': '打开会话',
        'action.archive': '归档',
        'action.unarchive': '取消归档',
        'action.pin': '置顶',
        'action.unpin': '取消置顶',
        'action.copyId': '复制会话 ID',
        'action.more': '更多操作',
        'action.rename': '重命名',
        'rename.title': '重命名会话',
        'rename.field': '会话名称',
        'rename.confirm': '重命名',
        'rename.cancel': '取消',
        'rename.saving': '保存中…',
        'rename.unavailable': '当前环境不支持重命名',
        'action.retry': '重试',
        'toast.archived': '已归档',
        'toast.unarchived': '已取消归档',
        'toast.pinned': '已置顶',
        'toast.unpinned': '已取消置顶',
        'toast.idCopied': '已复制会话 ID',
        'toast.renamed': '已重命名',
        'toast.idCopyFailed': '复制失败',
        'toast.archivedOpen': '已归档的会话需先取消归档才能打开',
        'toast.actionFailed': '操作失败',
        'archive.confirmTitle': '会话仍在活动',
        'archive.confirmBody': '该会话还有进行中的工作。停止这些工作并归档吗？',
        'archive.stopAndArchive': '停止并归档',
        'archive.cancel': '取消',
        'batch.select': '多选',
        'batch.exit': '退出多选',
        'batch.selected': '已选 {n} 项',
        'batch.selectAll': '全选当前',
        'batch.clear': '清除选择',
        'batch.archiveN': '批量归档（{n}）',
        'batch.unarchiveN': '批量取消归档（{n}）',
        'batch.archivedN': '已归档 {n} 个会话',
        'batch.unarchivedN': '已取消归档 {n} 个会话',
        'batch.failedN': '{n} 个会话操作失败',
        'batch.confirmTitle': '部分会话仍在活动',
        'batch.confirmBody': '{n} 个会话还有进行中的工作。停止这些工作并归档吗？',
        'detail.back': '返回列表',
        'detail.open': '打开会话',
        'detail.role.user': '你',
        'detail.role.assistant': '助手',
        'detail.tool': '工具调用',
        'detail.toolPending': '进行中',
        'detail.toolDone': '完成',
        'detail.toolFailed': '失败',
        'detail.loadOlder': '加载更早的消息',
        'detail.loadingOlder': '加载中…',
        'detail.noMore': '已到最早的消息',
        'detail.empty': '暂无可显示的消息',
        'detail.emptyHint': '这个会话还没有可读取的对话记录',
        'detail.loadFailed': '读取会话内容失败',
        'detail.loading': '读取会话内容…',
        'detail.truncated': '（内容过长，已截断）',
        'detail.footer': '只读预览 · 已加载 {n} 条消息',
        'detail.created': '创建 {time}（{rel}）',
        'detail.lastUsed': '上次使用 {time}（{rel}）',
        'detail.attachments': '[{n}× 附件]',
        'loading.list': '加载会话列表…',
        'list.empty': '当前筛选下没有会话',
        'list.emptyHint': '试试切换归档筛选，或清空搜索',
        'list.workspaceEmpty': '这个工作区还没有会话',
        'md.code': '代码',
        'md.copy': '复制',
        'md.copied': '已复制',
        'md.wrap': '自动换行',
        'md.unwrap': '取消换行',
        'md.footnotes': '脚注',
        'rel.now': '刚刚',
        'rel.minutes': '{n} 分钟前',
        'rel.hours': '{n} 小时前',
        'rel.days': '{n} 天前',
        'rel.months': '{n} 个月前',
        'rel.years': '{n} 年前',
        'page.tab.sessions': '会话',
        'page.tab.settings': '设定',
        'settings.global.title': '全局设定',
        'settings.global.caption': '对所有会话生效；工作区开启「覆盖」后会替换它。',
        'settings.workspace.caption': '只对「{name}」工作区生效。',
        'settings.override': '覆盖全局设定',
        'settings.overrideHint': '开启后只注入这组工作区设定，不再叠加全局设定。',
        'settings.hintGlobal': '这些内容会注入到所有未覆盖它的会话。',
        'settings.tag.saved': '已设',
        'settings.tag.override': '覆盖',
        'settings.loading': '读取会话设定…',
        'settings.loadFailed': '读取会话设定失败',
        'settings.retry': '重试',
        'settings.enabled': '启用这组设定',
        'settings.enabledHint': '关闭后，这组内容不会注入系统提示，但会保留。',
        'settings.name': '会话称呼',
        'settings.namePlaceholder': '模型应该怎么称呼你？',
        'settings.nameAccountHint': '已登录 DeepSeek 时会默认使用登录用户名；可自行修改。',
        'settings.occupation': '职业',
        'settings.occupationPlaceholder': '选择职业，或自定义填写',
        'settings.occupation.custom': '自定义…',
        'settings.occupation.teacher': '教师',
        'settings.occupation.student': '学生',
        'settings.occupation.engineer': '工程师',
        'settings.occupation.product': '产品经理',
        'settings.occupation.designer': '设计师',
        'settings.occupation.operations': '运营',
        'settings.occupation.researcher': '研究员',
        'settings.occupation.freelance': '自由职业',
        'settings.instructions': '给模型的指令',
        'settings.instructionsPlaceholder': '例如：避免 AI 腔，禁止“不是…而是”的对比句式和排比三段式。',
        'settings.instructionsHint': '最多 {n} 字，会附加在会话的系统提示里。',
        'settings.effective': '保存后从下一轮请求开始生效：全局设定注入所有会话；工作区设定注入该工作区的会话，除非开启覆盖。',
        'settings.effectiveOverride': '覆盖模式已开启：只注入这组工作区设定，全局设定对这些会话不再生效。',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.clear': '清除设定',
        'settings.clearing': '清除中…',
        'settings.clearConfirm': '清除这组设定？',
        'settings.clearCancel': '取消',
        'settings.clearConfirmAction': '确认清除',
        'settings.saved': '会话设定已保存，将从下一轮请求开始注入',
        'settings.cleared': '会话设定已清除',
        'settings.errorInvalid': '设定内容不合法，请检查字数限制后再试。',
        'settings.errorUnknownWorkspace': '保存失败：这个工作区已不存在。',
        'settings.errorForbidden': '无法访问本地服务（同源校验失败）。',
        'settings.counter': '{n}/{max}',
        'panel.settingsTitle': '会话设定',
        'panel.settingsCaption': '全局与工作区的会话设定',
        'features.title': '功能开关',
        'features.caption': '四个功能共用一个插件。保存后立即生效：系统提示、工具与路由都会在下一次请求时读取新状态。',
        'features.page': '会话管理页',
        'features.pageHint': '「会话管理」页：会话列表、归档筛选、批量操作与详情；关闭后入口保留，点进去显示已关闭提示。',
        'features.settings': '会话设定页',
        'features.settingsHint': '「会话设定」页（入口在侧栏「更多」菜单里）：全局 / 工作区设定表单；关闭后入口保留，并停用系统提示注入与两个 agent 工具。',
        'features.sidebarRecent': '只显示最近的工作区',
        'features.sidebarRecentHint': '官方侧栏上的时钟过滤：只保留最近使用的 1–10 个工作区。',
        'features.sidebarHide': '主动隐藏工作区',
        'features.sidebarHideHint': '官方侧栏上的眼睛过滤：手动保留要显示的工作区。',
        'features.save': '保存',
        'features.saving': '保存中…',
        'features.saved': '已保存，立即生效。',
        'features.error': '保存失败',
        'features.errorInvalid': '开关内容不合法，请刷新页面后重试。',
        'features.summary': '{n}/4 项功能开启',
        'features.liveHint': '改动会立即生效；关闭页面功能后入口仍在，点进去会提示已关闭。',
        'featureOff.title': '功能已关闭',
        'featureOff.body': '此功能已在「插件 → dsh-session-manager → 配置」中关闭。回到插件页打开开关即可恢复。',
      };

      var UI_EN = {
        'panel.title': 'Session Manager',
        'panel.caption': 'Browse sessions by workspace, or edit global / workspace session settings',
        'scope.all': 'All sessions',
        'scope.ungrouped': 'Ungrouped',
        'scope.count': '{n} sessions',
        'scope.matches': '{n} matches',
        'filter.active': 'Active',
        'filter.all': 'All',
        'filter.archived': 'Archived',
        'search.placeholder': 'Search session titles',
        'row.archived': 'Archived',
        'row.running': 'Running',
        'row.tokens': '{n} tokens',
        'row.created': 'Created {time}',
        'row.createdUnknown': 'Created: unknown',
        'row.createdTitle': 'Created',
        'row.lastUsed': 'Last used {time}',
        'action.open': 'Open session',
        'action.archive': 'Archive',
        'action.unarchive': 'Unarchive',
        'action.pin': 'Pin',
        'action.unpin': 'Unpin',
        'action.copyId': 'Copy session ID',
        'action.more': 'More actions',
        'action.rename': 'Rename',
        'rename.title': 'Rename session',
        'rename.field': 'Session name',
        'rename.confirm': 'Rename',
        'rename.cancel': 'Cancel',
        'rename.saving': 'Saving…',
        'rename.unavailable': 'Renaming is not available in this build',
        'action.retry': 'Retry',
        'toast.archived': 'Archived',
        'toast.unarchived': 'Unarchived',
        'toast.pinned': 'Pinned',
        'toast.unpinned': 'Unpinned',
        'toast.idCopied': 'Session ID copied',
        'toast.renamed': 'Renamed',
        'toast.idCopyFailed': 'Copy failed',
        'toast.archivedOpen': 'Unarchive the session before opening it',
        'toast.actionFailed': 'Action failed',
        'archive.confirmTitle': 'Session is still active',
        'archive.confirmBody': 'This session still has running work. Stop it and archive the session?',
        'archive.stopAndArchive': 'Stop and archive',
        'archive.cancel': 'Cancel',
        'batch.select': 'Select',
        'batch.exit': 'Exit selection',
        'batch.selected': '{n} selected',
        'batch.selectAll': 'Select all shown',
        'batch.clear': 'Clear selection',
        'batch.archiveN': 'Archive ({n})',
        'batch.unarchiveN': 'Unarchive ({n})',
        'batch.archivedN': 'Archived {n}',
        'batch.unarchivedN': 'Unarchived {n}',
        'batch.failedN': '{n} failed',
        'batch.confirmTitle': 'Some sessions are still active',
        'batch.confirmBody': '{n} session(s) still have running work. Stop them and archive?',
        'detail.back': 'Back to list',
        'detail.open': 'Open session',
        'detail.role.user': 'You',
        'detail.role.assistant': 'Assistant',
        'detail.tool': 'Tool call',
        'detail.toolPending': 'running',
        'detail.toolDone': 'done',
        'detail.toolFailed': 'failed',
        'detail.loadOlder': 'Load earlier messages',
        'detail.loadingOlder': 'Loading…',
        'detail.noMore': 'Beginning of the session',
        'detail.empty': 'No messages to show',
        'detail.emptyHint': 'This session has no readable transcript yet',
        'detail.loadFailed': 'Could not read the session transcript',
        'detail.loading': 'Reading session transcript…',
        'detail.truncated': '(truncated)',
        'detail.footer': 'Read-only preview · {n} messages loaded',
        'detail.created': 'Created {time} ({rel})',
        'detail.lastUsed': 'Last used {time} ({rel})',
        'detail.attachments': '[{n} attachments]',
        'loading.list': 'Loading sessions…',
        'list.empty': 'No sessions under the current filter',
        'list.emptyHint': 'Try another archive filter, or clear the search',
        'list.workspaceEmpty': 'This workspace has no sessions yet',
        'md.code': 'Code',
        'md.copy': 'Copy',
        'md.copied': 'Copied',
        'md.wrap': 'Wrap lines',
        'md.unwrap': 'Unwrap lines',
        'md.footnotes': 'Footnotes',
        'rel.now': 'just now',
        'rel.minutes': '{n}m ago',
        'rel.hours': '{n}h ago',
        'rel.days': '{n}d ago',
        'rel.months': '{n}mo ago',
        'rel.years': '{n}y ago',
        'page.tab.sessions': 'Sessions',
        'page.tab.settings': 'Settings',
        'settings.global.title': 'Global settings',
        'settings.global.caption': 'Applies to every session; a workspace with Override replaces it.',
        'settings.workspace.caption': 'Applies only to the “{name}” workspace.',
        'settings.override': 'Override global settings',
        'settings.overrideHint': 'When on, only this workspace’s settings are injected; global settings are ignored.',
        'settings.hintGlobal': 'These settings are injected into every session that does not override them.',
        'settings.tag.saved': 'Set',
        'settings.tag.override': 'Override',
        'settings.loading': 'Loading session settings…',
        'settings.loadFailed': 'Could not load session settings',
        'settings.retry': 'Retry',
        'settings.enabled': 'Enable these settings',
        'settings.enabledHint': 'When off, these settings are not injected into the system prompt, but their content is kept.',
        'settings.name': 'Preferred name',
        'settings.namePlaceholder': 'What should the model call you? e.g. Alex',
        'settings.nameAccountHint': 'When signed in to DeepSeek, your login name is used by default; you can change it.',
        'settings.occupation': 'Occupation',
        'settings.occupationPlaceholder': 'Pick an occupation, or write your own',
        'settings.occupation.custom': 'Custom…',
        'settings.occupation.teacher': 'Teacher',
        'settings.occupation.student': 'Student',
        'settings.occupation.engineer': 'Engineer',
        'settings.occupation.product': 'Product manager',
        'settings.occupation.designer': 'Designer',
        'settings.occupation.operations': 'Operations',
        'settings.occupation.researcher': 'Researcher',
        'settings.occupation.freelance': 'Freelancer',
        'settings.instructions': 'Instructions for the model',
        'settings.instructionsPlaceholder': 'e.g. Avoid AI tone; no “not X but Y” contrasts or three-part parallelism.',
        'settings.instructionsHint': 'Up to {n} characters; appended to the session system prompt.',
        'settings.effective': 'Applies from the next request: global settings apply to every session; a workspace’s settings apply to its sessions unless Override is on.',
        'settings.effectiveOverride': 'Override is on: only this workspace’s settings are injected; global settings no longer apply to these sessions.',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.clear': 'Clear settings',
        'settings.clearing': 'Clearing…',
        'settings.clearConfirm': 'Clear these settings?',
        'settings.clearCancel': 'Cancel',
        'settings.clearConfirmAction': 'Clear',
        'settings.saved': 'Settings saved; they apply from the next request.',
        'settings.cleared': 'Session settings cleared',
        'settings.errorInvalid': 'Invalid settings. Check the length limits and try again.',
        'settings.errorUnknownWorkspace': 'This workspace no longer exists.',
        'settings.errorForbidden': 'Could not reach the local service (same-origin check failed).',
        'settings.counter': '{n}/{max}',
        'panel.settingsTitle': 'Session Settings',
        'panel.settingsCaption': 'Global and workspace session settings',
        'features.title': 'Features',
        'features.caption': 'Four features share one plugin. Changes apply immediately (prompt section, tools and routes read the new state on the next request).',
        'features.page': 'Session Manager page',
        'features.pageHint': 'The Session Manager page: session list, archive filter, batch actions and details; when off the entry stays and shows the disabled notice.',
        'features.settings': 'Session Settings page',
        'features.settingsHint': 'The Session Settings page (opened from the sidebar More menu); turning it off keeps the row but disables prompt injection and the two agent tools.',
        'features.sidebarRecent': 'Recent workspaces only',
        'features.sidebarRecentHint': 'Clock filter on the official sidebar: keep the 1–10 most recently used workspaces.',
        'features.sidebarHide': 'Hide workspaces manually',
        'features.sidebarHideHint': 'Eye filter on the official sidebar: keep only the workspaces you select.',
        'features.save': 'Save',
        'features.saving': 'Saving…',
        'features.saved': 'Saved and applied immediately.',
        'features.error': 'Save failed',
        'features.errorInvalid': 'Invalid switch payload. Refresh the page and try again.',
        'features.summary': '{n}/4 features on',
        'features.liveHint': 'Changes apply immediately; a disabled page keeps its sidebar entry and shows the disabled notice.',
        'featureOff.title': 'Feature is off',
        'featureOff.body': 'This feature is disabled in Plugins → dsh-session-manager → Config. Turn it back on there to restore it.',
      };

      var EMPTY_SESSIONS = { ids: [], byId: {}, phase: 'idle', projectionsBySession: {} };
      var EMPTY_WORKSPACES = {
        items: [],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: null,
        phase: 'idle',
        error: null,
      };

      /* Creation times come from the host half's read-only route: the client
       * session list carries updatedAt only (never the immutable header
       * createdAt). One fetch per page load; failures degrade to "unknown". */
      var createdAtById = {};
      var createdTimesPromise = null;

      function loadCreatedTimes() {
        if (createdTimesPromise !== null) return createdTimesPromise;
        if (typeof fetch !== 'function') return Promise.resolve(createdAtById);
        createdTimesPromise = fetch(TIMES_ROUTE, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(function (response) {
            if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'));
            return response.json();
          })
          .then(function (payload) {
            if (payload && payload.ok === true && payload.value && payload.value.times && typeof payload.value.times === 'object') {
              Object.keys(payload.value.times).forEach(function (sessionId) {
                var value = payload.value.times[sessionId];
                if (typeof value === 'number' && isFinite(value)) createdAtById[sessionId] = value;
              });
            }
            return createdAtById;
          })
          .catch(function (error) {
            createdTimesPromise = null;
            try {
              console.warn('[' + NS + '] creation times are unavailable', error);
            } catch (ignore) {
              /* console may be stubbed */
            }
            return createdAtById;
          });
        return createdTimesPromise;
      }

      /* 会话设定 live in two scopes: one global profile and one optional profile
       * per workspace (which can override the global one). The host half stores
       * them and injects the effective profile into each session's system
       * prompt; the client keeps a module-level cache so reopening the page does
       * not refetch, and writes go through the host routes. */
      var settingsByScope = {};
      var settingsPromise = null;
      /* The DeepSeek login name (account profile) is used only as the default
       * for an empty 「会话称呼」: it is fetched lazily, cached for the page,
       * and never persisted unless the user saves the form. */
      var accountCtx = null;
      var accountNamePromise = null;
      var accountNamePrefillSeq = 0;

      function normalizeClientSettings(value, withOverride) {
        if (!value || typeof value !== 'object') return null;
        var settings = {
          enabled: value.enabled !== false,
          name: typeof value.name === 'string' ? value.name : '',
          occupation: typeof value.occupation === 'string' ? value.occupation : '',
          instructions: typeof value.instructions === 'string' ? value.instructions : '',
          updatedAt: typeof value.updatedAt === 'number' && isFinite(value.updatedAt) ? value.updatedAt : 0,
        };
        if (withOverride) settings.override = value.override === true;
        return settings;
      }

      function replaceSettingsCache(value) {
        var next = {};
        if (value && typeof value === 'object') {
          var global = normalizeClientSettings(value.global, false);
          if (global !== null) next[GLOBAL_SCOPE_KEY] = global;
          var workspaces = value.workspaces && typeof value.workspaces === 'object' ? value.workspaces : null;
          if (workspaces !== null) {
            Object.keys(workspaces).forEach(function (workspaceId) {
              if (workspaceId === '') return;
              var settings = normalizeClientSettings(workspaces[workspaceId], true);
              if (settings !== null) next[workspaceId] = settings;
            });
          }
        }
        settingsByScope = next;
        return next;
      }

      function loadSettings(force) {
        if (!force && settingsPromise !== null) return settingsPromise;
        if (typeof fetch !== 'function') return Promise.resolve(Object.assign({}, settingsByScope));
        settingsPromise = fetch(SETTINGS_ROUTE, {
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(function (response) {
            if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'));
            return response.json();
          })
          .then(function (payload) {
            if (payload && payload.ok === true && payload.value && typeof payload.value === 'object') {
              return Object.assign({}, replaceSettingsCache(payload.value));
            }
            throw new Error('unexpected settings payload');
          })
          .catch(function (error) {
            settingsPromise = null;
            throw error;
          });
        return settingsPromise;
      }

      function hostErrorText(payload) {
        if (payload && payload.error && typeof payload.error.message === 'string' && payload.error.message !== '') {
          return payload.error.message;
        }
        return '';
      }

      function postSettings(path, scopeKey, settings) {
        var body;
        if (scopeKey === GLOBAL_SCOPE_KEY) {
          body = settings === undefined ? { scope: 'global' } : { scope: 'global', settings: settings };
        } else {
          body = settings === undefined ? { scope: 'workspace', workspaceId: scopeKey } : { scope: 'workspace', workspaceId: scopeKey, settings: settings };
        }
        return fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).then(function (response) {
          return response.json().then(
            function (payload) {
              if (!response.ok || !payload || payload.ok !== true) {
                var failure = new Error(hostErrorText(payload) || 'HTTP ' + response.status);
                failure.code = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : '';
                throw failure;
              }
              return payload.value;
            },
            function () {
              throw new Error('HTTP ' + response.status);
            },
          );
        });
      }

      function saveHostSettings(scopeKey, settings) {
        return postSettings(SETTINGS_ROUTE, scopeKey, settings);
      }

      function clearHostSettings(scopeKey) {
        return postSettings(SETTINGS_CLEAR_ROUTE, scopeKey);
      }

      function scopeIsGlobal(scopeKey) {
        return scopeKey === GLOBAL_SCOPE_KEY;
      }

      function occupationPresets() {
        return OCCUPATION_PRESET_KEYS.map(function (key) {
          return tr(key);
        });
      }

      function settingsToDraft(settings) {
        var occupation = settings && typeof settings.occupation === 'string' ? settings.occupation : '';
        var presets = occupationPresets();
        return {
          enabled: settings ? settings.enabled !== false : true,
          name: settings && typeof settings.name === 'string' ? settings.name : '',
          occupation: occupation,
          customOccupation: occupation !== '' && presets.indexOf(occupation) < 0,
          instructions: settings && typeof settings.instructions === 'string' ? settings.instructions : '',
          override: settings ? settings.override === true : false,
        };
      }

      function draftToSettings(draft, withOverride) {
        var settings = {
          enabled: draft.enabled !== false,
          name: typeof draft.name === 'string' ? draft.name : '',
          occupation: typeof draft.occupation === 'string' ? draft.occupation : '',
          instructions: typeof draft.instructions === 'string' ? draft.instructions : '',
        };
        if (withOverride) settings.override = draft.override === true;
        return settings;
      }

      function accountClientVersion() {
        try {
          var boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : null;
          var release = boot && boot.release && typeof boot.release.version === 'string' ? boot.release.version : '';
          return release !== '' ? release : '0.0.0';
        } catch (error) {
          return '0.0.0';
        }
      }

      function readAccountApi() {
        if (accountCtx === null) return null;
        var api = null;
        try {
          api = typeof accountCtx.get === 'function' ? accountCtx.get('remote.account') : null;
        } catch (error) {
          api = null;
        }
        if (!api || typeof api.getProfile !== 'function') {
          try {
            api = accountCtx.remote ? accountCtx.remote.account : null;
          } catch (error) {
            api = null;
          }
        }
        return api && typeof api.getProfile === 'function' ? api : null;
      }

      function loadAccountDisplayName() {
        if (accountNamePromise !== null) return accountNamePromise;
        var api = readAccountApi();
        if (api === null) return Promise.resolve('');
        var metadata = {
          version: accountClientVersion(),
          locale: currentLang(),
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        var request;
        try {
          request = api.getProfile(metadata);
        } catch (error) {
          return Promise.resolve('');
        }
        accountNamePromise = Promise.resolve(request).then(
          function (result) {
            /* dsh >=0.2 remote methods return a `{ ok, value }` envelope
             * (dsh-api-gateway/lib/types/client/index.js:293-297); the account
             * profile itself lives at `result.value`. Keep accepting the raw
             * profile shape for older hosts. */
            var profile = result;
            if (profile && typeof profile.ok === 'boolean') {
              if (profile.ok !== true) return '';
              profile = profile.value;
            }
            if (!profile || profile.status !== 'ready' || !profile.value) return '';
            if (typeof profile.value.name !== 'string') return '';
            return profile.value.name.trim().slice(0, NAME_LIMIT);
          },
          function () {
            /* Signed out, no account plugin, or a transient failure: keep the
             * field empty rather than blocking the form. Retry on next open. */
            accountNamePromise = null;
            return '';
          },
        );
        return accountNamePromise;
      }

      function prefillAccountName(seedDraft, setDraft) {
        if (!seedDraft || typeof seedDraft.name !== 'string' || seedDraft.name.trim() !== '') return;
        var seq = ++accountNamePrefillSeq;
        loadAccountDisplayName().then(function (name) {
          if (name === '' || seq !== accountNamePrefillSeq) return;
          setDraft(function (previous) {
            if (previous === null || typeof previous.name !== 'string' || previous.name.trim() !== '') return previous;
            return Object.assign({}, previous, { name: name });
          });
        });
      }

      function currentLang() {
        try {
          var lang = document.documentElement.getAttribute('lang') || '';
          return lang.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (error) {
          return 'en';
        }
      }

      function interpolate(text, params) {
        if (!params) return text;
        var result = text;
        Object.keys(params).forEach(function (name) {
          result = result.split('{' + name + '}').join(String(params[name]));
        });
        return result;
      }

      function fallbackTranslate(key, params) {
        var dict = currentLang() === 'zh' ? UI_ZH : UI_EN;
        var text = dict[key];
        if (typeof text !== 'string') text = UI_ZH[key];
        if (typeof text !== 'string') return key;
        return interpolate(text, params);
      }

      var translate = function (key, params) {
        return fallbackTranslate(key, params);
      };

      function tr(key, params) {
        try {
          var value = translate(key, params);
          return typeof value === 'string' && value !== '' ? value : fallbackTranslate(key, params);
        } catch (error) {
          return fallbackTranslate(key, params);
        }
      }

      /* ------------------------------------------------------------------ */
      /* small helpers                                                       */
      /* ------------------------------------------------------------------ */

      function Icon(name, extra) {
        var glyph = primitives === null ? undefined : primitives[name];
        if (glyph === undefined || glyph === null) return null;
        var props = { width: 16, height: 16, 'aria-hidden': 'true' };
        if (extra) {
          Object.keys(extra).forEach(function (key) {
            props[key] = extra[key];
          });
        }
        return h(glyph, props);
      }

      function basename(path) {
        if (typeof path !== 'string' || path === '') return '';
        var trimmed = path.replace(/\\\\+$/, '');
        var index = trimmed.lastIndexOf('/');
        if (index >= 0 && index < trimmed.length - 1) return trimmed.slice(index + 1);
        var winIndex = trimmed.lastIndexOf('\\\\');
        if (winIndex >= 0 && winIndex < trimmed.length - 1) return trimmed.slice(winIndex + 1);
        return trimmed;
      }

      function workspaceTitle(item) {
        if (!item) return '';
        if (typeof item.title === 'string' && item.title !== '') return item.title;
        return basename(item.path) || String(item.workspaceId || '');
      }

      function sessionTitle(row) {
        if (!row) return '';
        if (typeof row.displayTitle === 'string' && row.displayTitle !== '') return row.displayTitle;
        if (typeof row.title === 'string' && row.title !== '') return row.title;
        return String(row.id || '').slice(0, 8) + '…';
      }

      function relativeLabel(timestamp) {
        if (typeof timestamp !== 'number' || !isFinite(timestamp)) return '';
        var diff = Math.max(0, Date.now() - timestamp);
        if (diff < 60000) return tr('rel.now');
        if (diff < 3600000) return tr('rel.minutes', { n: Math.floor(diff / 60000) });
        if (diff < 86400000) return tr('rel.hours', { n: Math.floor(diff / 3600000) });
        if (diff < 30 * 86400000) return tr('rel.days', { n: Math.floor(diff / 86400000) });
        if (diff < 365 * 86400000) return tr('rel.months', { n: Math.floor(diff / (30 * 86400000)) });
        return tr('rel.years', { n: Math.floor(diff / (365 * 86400000)) });
      }

      function pad2(value) {
        return value < 10 ? '0' + value : String(value);
      }

      function formatDateTime(timestamp) {
        if (typeof timestamp !== 'number' || !isFinite(timestamp) || timestamp <= 0) return '';
        var date = new Date(timestamp);
        return (
          date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
        );
      }

      function lastUsedAt(row) {
        if (!row) return 0;
        var values = row.projectionValues;
        var metadata = values && values.sessionListMetadata;
        if (metadata && typeof metadata.lastPromptAt === 'number' && isFinite(metadata.lastPromptAt) && metadata.lastPromptAt > 0) {
          return metadata.lastPromptAt;
        }
        if (typeof row.updatedAt === 'number' && isFinite(row.updatedAt)) return row.updatedAt;
        return 0;
      }

      function tokenText(row) {
        var values = row && row.projectionValues;
        var usage = values && values.tokenUsage;
        if (!usage) return '';
        var total = 0;
        ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].forEach(function (key) {
          if (typeof usage[key] === 'number' && isFinite(usage[key])) total += usage[key];
        });
        if (total <= 0) return '';
        if (total >= 1000000) return (total / 1000000).toFixed(1) + 'M';
        if (total >= 1000) return (total / 1000).toFixed(1) + 'k';
        return String(total);
      }

      function truncate(text, limit) {
        var value = typeof text === 'string' ? text : '';
        if (value.length <= limit) return value;
        return value.slice(0, limit) + '\n' + tr('detail.truncated');
      }

      function formatArguments(raw) {
        if (typeof raw !== 'string' || raw === '') return '';
        var text = raw;
        try {
          var parsed = JSON.parse(raw);
          text = JSON.stringify(parsed, null, 2);
        } catch (error) {
          text = raw;
        }
        return truncate(text, TOOL_TEXT_LIMIT);
      }

      function isSessionActiveError(error) {
        if (!error) return false;
        if (error.name === 'WorkspaceArchiveError') {
          return !!(error.rpcError && error.rpcError.code === 'workspace/session-active');
        }
        return !!(error.rpcError && error.rpcError.code === 'workspace/session-active');
      }

      function errorText(error) {
        var code = error && typeof error.code === 'string' ? error.code : '';
        if (code === 'invalid_settings') return tr('settings.errorInvalid');
        if (code === 'unknown_workspace' || code === 'invalid_workspace') return tr('settings.errorUnknownWorkspace');
        if (code === 'forbidden') return tr('settings.errorForbidden');
        if (error && typeof error.message === 'string' && error.message !== '') return error.message;
        return tr('toast.actionFailed');
      }

      function markdownLabels() {
        return {
          code: {
            copyLabel: tr('md.copy'),
            copiedLabel: tr('md.copied'),
            toolbarLabels: {
              codeLabel: tr('md.code'),
              wrapLabel: tr('md.wrap'),
              unwrapLabel: tr('md.unwrap'),
            },
          },
          footnotes: tr('md.footnotes'),
        };
      }

      function hasPrimitive(name) {
        return primitives !== null && primitives !== undefined && primitives[name] !== undefined && primitives[name] !== null;
      }

      function renderMarkdown(text) {
        if (hasPrimitive('MarkdownText')) {
          try {
            return h(primitives.MarkdownText, { text: text, streaming: false, labels: markdownLabels() });
          } catch (error) {
            /* fall through to plain text */
          }
        }
        return h('div', { className: 'dsm-plain' }, text);
      }

      /**
       * Subscribe to one snapshot source (`.getSnapshot()` / `.subscribe()`)
       * through React's external store. Missing sources stay on a frozen empty
       * snapshot instead of throwing while the services are still loading.
       */
      function useServiceSnapshot(source, empty) {
        var subscribe = useCallback(
          function (listener) {
            if (!source || typeof source.subscribe !== 'function') return function () {};
            return source.subscribe(listener);
          },
          [source],
        );
        var getSnapshot = useCallback(
          function () {
            if (!source || typeof source.getSnapshot !== 'function') return empty;
            var snapshot = source.getSnapshot();
            return snapshot === undefined || snapshot === null ? empty : snapshot;
          },
          [source, empty],
        );
        return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      }

      function useErrorMessage(error) {
        var [text, setText] = useState('');
        useEffect(
          function () {
            setText(error ? errorText(error) : '');
          },
          [error],
        );
        return text;
      }

      /* ------------------------------------------------------------------ */
      /* feature switches (live: Host routes/section/tools read store each call) */
      /* ------------------------------------------------------------------ */

      var featureSnapshot = Object.assign({ loaded: false }, FEATURE_DEFAULTS);
      var featureListeners = [];

      function publishFeatures(next) {
        featureSnapshot = Object.assign({}, featureSnapshot, next || {}, { loaded: true });
        featureListeners.slice().forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            /* a listener must not break the others */
          }
        });
        refreshWorkspaceFocus();
      }

      function refreshWorkspaceFocus() {
        if (workspaceFocusMod && typeof workspaceFocusMod.refresh === 'function') {
          try {
            workspaceFocusMod.refresh();
          } catch (error) {
            /* the sidebar may not be mounted yet */
          }
        }
      }

      function useFeatures() {
        var pair = useState(0);
        var bump = pair[1];
        useEffect(function () {
          var listener = function () {
            bump(function (value) {
              return value + 1;
            });
          };
          featureListeners.push(listener);
          return function () {
            var index = featureListeners.indexOf(listener);
            if (index >= 0) featureListeners.splice(index, 1);
          };
        }, []);
        return featureSnapshot;
      }

      function featuresFromPayload(payload) {
        var value = payload && payload.ok === true && payload.value ? payload.value : null;
        var features = value && value.features ? value.features : null;
        return features !== null && typeof features === 'object' ? features : null;
      }

      function loadFeatures() {
        return fetch(FEATURES_ROUTE, { headers: { accept: 'application/json' } })
          .then(function (response) {
            return response.ok ? response.json() : null;
          })
          .then(function (payload) {
            var features = featuresFromPayload(payload);
            publishFeatures(features !== null ? features : {});
          })
          .catch(function () {
            publishFeatures({});
          });
      }

      function saveFeatures(next) {
        return fetch(FEATURES_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ features: next }),
        }).then(function (response) {
          return response.json().then(function (payload) {
            if (!response.ok || !payload || payload.ok !== true) {
              var reason = payload && payload.error && payload.error.message ? payload.error.message : 'HTTP ' + response.status;
              var failure = new Error(reason);
              failure.code = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code : '';
              throw failure;
            }
            var features = featuresFromPayload(payload);
            if (features !== null) publishFeatures(features);
            return payload;
          });
        });
      }

      function FeatureDisabled() {
        return h(
          'div',
          { className: 'dsm-featureOff' },
          h('div', { className: 'dsm-emptyTitle' }, tr('featureOff.title')),
          h('div', { className: 'dsm-emptyHint' }, tr('featureOff.body')),
        );
      }

      function SessionManagerNavEntry(props) {
        // 入口常驻：功能关闭时点进去显示「功能已关闭」，避免入口消失后找不到回来的路。
        return h(SessionManagerNavIcon, props);
      }

      function SessionSettingsMoreItem(props) {
        var dismiss = props && typeof props.onDismiss === 'function' ? props.onDismiss : null;
        function select() {
          if (dismiss !== null) dismiss();
          if (typeof openSettingsPanelFromMenu === 'function') openSettingsPanelFromMenu();
        }
        var label = tr('panel.settingsTitle');
        var icon = h(SessionSettingsNavIcon, { size: 16 });
        if (primitives && typeof primitives.MenuItemButton === 'function') {
          return h(
            primitives.MenuItemButton,
            { icon: icon, onSelect: select },
            h('span', { className: 'dsm-moreLabel' }, label),
          );
        }
        return h(
          'button',
          {
            type: 'button',
            className: 'dsm-moreItem',
            role: 'menuitem',
            onClick: select,
          },
          icon,
          h('span', { className: 'dsm-moreLabel' }, label),
        );
      }

      function SessionSettingsNavIcon(props) {
        var size = props && typeof props.size === 'number' && isFinite(props.size) ? props.size : 16;
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
          },
          h('rect', {
            x: 1.4,
            y: 1.4,
            width: 13.2,
            height: 13.2,
            rx: 4,
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          h('path', {
            d: 'M4.3 5.1h7.4v4.3H7.2l-2.1 1.5v-1.5H4.3V5.1Z',
            stroke: 'currentColor',
            strokeWidth: 1.1,
            strokeLinejoin: 'round',
          }),
          h('circle', { cx: 6.5, cy: 7.3, r: 0.85, fill: 'currentColor' }),
          h('circle', { cx: 9.5, cy: 7.3, r: 0.85, fill: 'currentColor' }),
        );
      }

      function SessionManagerSessionsPanel(props) {
        var features = useFeatures();
        if (!features.loaded) return null;
        if (!features.page) return h(FeatureDisabled);
        return h(SessionManagerPage, Object.assign({}, props, { standaloneTab: 'sessions' }));
      }

      function SessionSettingsPanel(props) {
        var features = useFeatures();
        if (!features.loaded) return null;
        if (!features.settings) return h(FeatureDisabled);
        return h(SessionManagerPage, Object.assign({}, props, { standaloneTab: 'settings' }));
      }

      function SessionManagerPluginConfig(props) {
        var features = useFeatures();
        var draftPair = useState(null);
        var draft = draftPair[0];
        var setDraft = draftPair[1];
        var savingPair = useState(false);
        var saving = savingPair[0];
        var setSaving = savingPair[1];
        var messagePair = useState('');
        var message = messagePair[0];
        var setMessage = messagePair[1];
        var errorPair = useState('');
        var error = errorPair[0];
        var setError = errorPair[1];

        useEffect(
          function () {
            if (!features.loaded) return;
            setDraft({
              page: features.page,
              settings: features.settings,
              sidebarRecent: features.sidebarRecent,
              sidebarHide: features.sidebarHide,
            });
          },
          [features.loaded, features.page, features.settings, features.sidebarRecent, features.sidebarHide],
        );

        var current = draft || { page: true, settings: true, sidebarRecent: true, sidebarHide: true };
        var enabledCount = (current.page ? 1 : 0) + (current.settings ? 1 : 0) + (current.sidebarRecent ? 1 : 0) + (current.sidebarHide ? 1 : 0);

        function toggle(key) {
          var next = Object.assign({}, current);
          next[key] = !next[key];
          setDraft(next);
          setMessage('');
          setError('');
        }

        function save() {
          setSaving(true);
          setError('');
          setMessage('');
          saveFeatures(current)
            .then(function () {
              setMessage(tr('features.saved'));
            })
            .catch(function (failure) {
              var detail =
                failure && failure.code === 'invalid_features'
                  ? tr('features.errorInvalid')
                  : failure && failure.message
                    ? failure.message
                    : String(failure);
              setError(tr('features.error') + '：' + detail);
            })
            .then(function () {
              setSaving(false);
            });
        }

        if (props && props.view === 'summary') {
          return h('span', { className: 'dsm-configSummary' }, tr('features.summary', { n: enabledCount }));
        }

        var rows = [
          ['page', 'features.page', 'features.pageHint'],
          ['settings', 'features.settings', 'features.settingsHint'],
          ['sidebarRecent', 'features.sidebarRecent', 'features.sidebarRecentHint'],
          ['sidebarHide', 'features.sidebarHide', 'features.sidebarHideHint'],
        ].map(function (row) {
          return h(
            'label',
            { className: 'dsm-configRow', key: row[0] },
            h('input', {
              type: 'checkbox',
              className: 'dsm-switch',
              checked: current[row[0]] === true,
              onChange: function () {
                toggle(row[0]);
              },
            }),
            h(
              'div',
              { className: 'dsm-configText' },
              h('span', { className: 'dsm-configTitle' }, tr(row[1])),
              h('span', { className: 'dsm-configHint' }, tr(row[2])),
            ),
          );
        });

        return h(
          'div',
          { className: 'dsm-configForm' },
          h('div', { className: 'dsm-configHead' }, h('h3', { className: 'dsm-configTitle' }, tr('features.title')), h('p', { className: 'dsm-configHint' }, tr('features.caption'))),
          rows,
          h('p', { className: 'dsm-configNote' }, tr('features.liveHint')),
          error !== '' ? h('p', { className: 'dsm-formError', role: 'alert' }, error) : null,
          message !== '' ? h('p', { className: 'dsm-configSaved' }, message) : null,
          h(
            'div',
            { className: 'dsm-configActions' },
            h(
              'button',
              { type: 'button', className: 'dsm-btn dsm-btnPrimary', disabled: saving, onClick: save },
              saving ? tr('features.saving') : tr('features.save'),
            ),
          ),
        );
      }

      /* ------------------------------------------------------------------ */
      /* sidebar navigation entry icon                                       */
      /* ------------------------------------------------------------------ */

      function SessionManagerNavIcon(props) {
        var size = props && typeof props.size === 'number' && isFinite(props.size) ? props.size : 16;
        if (hasPrimitive('IconFlatListOutlineRegular')) {
          return h(primitives.IconFlatListOutlineRegular, { size: size });
        }
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg',
            'aria-hidden': 'true',
          },
          h('rect', {
            x: 2.1,
            y: 2.6,
            width: 11.8,
            height: 10.8,
            rx: 2.6,
            stroke: 'currentColor',
            strokeWidth: 1.2,
          }),
          h('path', {
            d: 'M5.3 6h2.5M5.3 8.2h5.4M5.3 10.4h3.6',
            stroke: 'currentColor',
            strokeWidth: 1.2,
            strokeLinecap: 'round',
          }),
        );
      }

      /* ------------------------------------------------------------------ */
      /* transcript model                                                    */
      /* ------------------------------------------------------------------ */

      function contentText(content) {
        if (!Array.isArray(content)) return '';
        var parts = [];
        var images = 0;
        content.forEach(function (block) {
          if (!block || typeof block !== 'object') return;
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
            parts.push(block.text);
          } else if (block.type === 'image' || block.type === 'file') {
            images += 1;
          }
        });
        var text = parts.join('\n\n');
        if (images > 0) {
          var marker = tr('detail.attachments', { n: images });
          text = text === '' ? marker : text + '\n\n' + marker;
        }
        return text;
      }

      function unwrapRecord(record) {
        if (!record) return null;
        if (record.type === 'event' && record.event) return record.event;
        if (record.type !== undefined && record.seq !== undefined) return record;
        return null;
      }

      function buildItems(records) {
        var items = [];
        var tools = {};

        // One tool row per call id: an assistant message may embed a tool-call
        // block and the step may also emit a dedicated tool/call event; the
        // result must land on a single row regardless of which arrives first.
        function toolItem(callId, name, args, seq) {
          if (!callId) return null;
          var existing = tools[callId];
          if (existing) {
            if ((!existing.name || existing.name === 'tool') && typeof name === 'string' && name !== '') existing.name = name;
            if ((existing.arguments === undefined || existing.arguments === '') && args !== undefined) existing.arguments = args;
            return existing;
          }
          var item = { kind: 'tool', seq: seq, callId: callId, name: typeof name === 'string' && name !== '' ? name : 'tool', arguments: args };
          tools[callId] = item;
          items.push(item);
          return item;
        }

        records.forEach(function (record) {
          var event = unwrapRecord(record);
          if (!event) return;
          if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
          var data = event.data || {};
          var seq = typeof event.seq === 'number' ? event.seq : 0;

          if (event.type === 'user/message') {
            var userText = contentText(data.content);
            if (userText !== '') items.push({ kind: 'user', seq: seq, text: userText });
            return;
          }

          if (event.type === 'assistant/message') {
            var message = data.message || {};
            var assistantText = contentText(message.content);
            if (assistantText !== '') items.push({ kind: 'assistant', seq: seq, text: assistantText });
            if (Array.isArray(message.content)) {
              message.content.forEach(function (block) {
                if (!block || block.type !== 'tool-call' || !block.id) return;
                toolItem(block.id, block.name, block.arguments, seq);
              });
            }
            return;
          }

          if (event.type === 'tool/call') {
            toolItem(data.callId, data.name, data.arguments, seq);
            return;
          }

          if (event.type === 'tool/result') {
            var resultMessage = data.message || {};
            var callId = resultMessage.toolCallId;
            var target = callId ? tools[callId] : undefined;
            var text = contentText(resultMessage.content);
            var failed = data.error !== undefined && data.error !== null;
            if (resultMessage.isError === true) failed = true;
            if (target) {
              target.result = text;
              target.resultFailed = failed;
            } else {
              items.push({ kind: 'tool', seq: seq, callId: callId, name: tr('detail.tool'), arguments: '', result: text, resultFailed: failed });
            }
          }
        });

        return items;
      }

      function mergeRecords(older, current) {
        var map = {};
        var order = [];
        older.concat(current).forEach(function (record) {
          var event = unwrapRecord(record);
          var seq = event && typeof event.seq === 'number' ? event.seq : null;
          if (seq === null) return;
          if (map[seq] === undefined) order.push(seq);
          map[seq] = record;
        });
        order.sort(function (left, right) {
          return left - right;
        });
        return order.map(function (seq) {
          return map[seq];
        });
      }

      function callSessionEvents(remote, request, signal) {
        var sessionRemote = remote && remote.session;
        if (!sessionRemote) throw new Error('dsh-session-manager: remote.session is unavailable');
        var call = typeof sessionRemote.events === 'function' ? sessionRemote.events : sessionRemote.page;
        if (typeof call !== 'function') throw new Error('dsh-session-manager: session events RPC is unavailable');
        var result = call.call(sessionRemote, request, signal);
        return Promise.resolve(result).then(function (response) {
          if (response && response.ok === true) return response.value;
          throw (response && response.error) || new Error('dsh-session-manager: session events failed');
        });
      }

      /* ------------------------------------------------------------------ */
      /* tool call row                                                       */
      /* ------------------------------------------------------------------ */

      function ToolItem(props) {
        var item = props.item;
        var args = formatArguments(item.arguments);
        var result = item.result === undefined ? '' : truncate(item.result, TOOL_TEXT_LIMIT);
        var status = item.result === undefined ? tr('detail.toolPending') : item.resultFailed ? tr('detail.toolFailed') : tr('detail.toolDone');
        return h(
          'details',
          { className: 'dsm-tool' },
          h(
            'summary',
            { className: 'dsm-toolSummary' },
            h('span', { className: 'dsm-toolName' }, item.name || tr('detail.tool')),
            h('span', { className: 'dsm-toolState', 'data-failed': item.resultFailed ? 'true' : 'false' }, status),
          ),
          args !== '' ? h('pre', { className: 'dsm-toolBlock' }, args) : null,
          result !== '' ? h('pre', { className: 'dsm-toolBlock' }, result) : null,
        );
      }

      /* ------------------------------------------------------------------ */
      /* detail pane                                                         */
      /* ------------------------------------------------------------------ */

      function SessionDetail(props) {
        var sessionId = props.sessionId;
        var remote = props.remote;
        var session = props.session;
        var archived = props.archived;

        var [records, setRecords] = useState([]);
        var [state, setState] = useState({ phase: 'loading', hasMore: false, older: false, error: null });
        var [reloadKey, setReloadKey] = useState(0);

        var scrollRef = useRef(null);
        var initialScrolled = useRef(false);
        var pendingAnchor = useRef(null);
        var olderAbort = useRef(null);

        var items = useMemo(function () {
          return buildItems(records);
        }, [records]);

        useEffect(
          function () {
            var controller = new AbortController();
            initialScrolled.current = false;
            pendingAnchor.current = null;
            setRecords([]);
            setState({ phase: 'loading', hasMore: false, older: false, error: null });
            try {
              callSessionEvents(
                remote,
                { address: { kind: 'session', sessionId: sessionId }, maxMessages: PAGE_SIZE },
                controller.signal,
              )
                .then(function (page) {
                  if (controller.signal.aborted) return;
                  var pageRecords = (page && page.records) || [];
                  setRecords(pageRecords);
                  setState({ phase: 'ready', hasMore: page && page.hasMore === true, older: false, error: null });
                })
                .catch(function (error) {
                  if (controller.signal.aborted) return;
                  setState({ phase: 'error', hasMore: false, older: false, error: error });
                });
            } catch (error) {
              setState({ phase: 'error', hasMore: false, older: false, error: error });
            }
            return function () {
              controller.abort();
              if (olderAbort.current) {
                olderAbort.current.abort();
                olderAbort.current = null;
              }
            };
          },
          [sessionId, reloadKey, remote],
        );

        useLayoutEffect(
          function () {
            var element = scrollRef.current;
            if (!element) return;
            if (state.phase === 'ready' && !initialScrolled.current && items.length > 0) {
              initialScrolled.current = true;
              element.scrollTop = element.scrollHeight;
              return;
            }
            if (pendingAnchor.current !== null && items.length > 0) {
              var anchor = pendingAnchor.current;
              pendingAnchor.current = null;
              element.scrollTop = element.scrollHeight - anchor.height + anchor.top;
            }
          },
          [items, state.phase],
        );

        function loadOlder() {
          if (state.phase !== 'ready' || state.hasMore !== true || state.older === true) return;
          var first = records.length > 0 ? unwrapRecord(records[0]) : null;
          var beforeSeq = first && typeof first.seq === 'number' ? first.seq : undefined;
          if (beforeSeq === undefined) return;
          var element = scrollRef.current;
          if (element) pendingAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
          setState(function (previous) {
            return Object.assign({}, previous, { older: true });
          });
          if (olderAbort.current) olderAbort.current.abort();
          var controller = new AbortController();
          olderAbort.current = controller;
          try {
            callSessionEvents(
              remote,
              { address: { kind: 'session', sessionId: sessionId }, beforeSeq: beforeSeq, maxMessages: PAGE_SIZE },
              controller.signal,
            )
              .then(function (page) {
                if (controller.signal.aborted) return;
                var pageRecords = (page && page.records) || [];
                setRecords(function (current) {
                  return mergeRecords(pageRecords, current);
                });
                setState(function (previous) {
                  return Object.assign({}, previous, { older: false, hasMore: page && page.hasMore === true });
                });
              })
              .catch(function (error) {
                if (controller.signal.aborted) return;
                setState(function (previous) {
                  return Object.assign({}, previous, { older: false, error: error });
                });
              });
          } catch (error) {
            setState(function (previous) {
              return Object.assign({}, previous, { older: false, error: error });
            });
          }
        }

        function renderItem(item, index) {
          var key = String(item.kind) + ':' + String(item.seq) + ':' + String(index);
          if (item.kind === 'user') {
            return h(
              'div',
              { key: key, className: 'dsm-msg dsm-msgUser' },
              h('div', { className: 'dsm-msgRole' }, tr('detail.role.user')),
              h('div', { className: 'dsm-userText' }, item.text),
            );
          }
          if (item.kind === 'assistant') {
            return h(
              'div',
              { key: key, className: 'dsm-msg dsm-msgAssistant' },
              h('div', { className: 'dsm-msgRole' }, tr('detail.role.assistant')),
              h('div', { className: 'dsm-assistantText' }, renderMarkdown(item.text)),
            );
          }
          return h(ToolItem, { key: key, item: item });
        }

        var title = sessionTitle(session);
        var workspaceText = props.workspaceTitle;
        var meta = [];
        if (workspaceText) meta.push(h('span', { key: 'ws' }, workspaceText));
        var detailCreated = typeof props.createdAt === 'number' ? props.createdAt : 0;
        if (detailCreated > 0) {
          meta.push(h('span', { key: 'created' }, tr('detail.created', { time: formatDateTime(detailCreated), rel: relativeLabel(detailCreated) })));
        } else {
          meta.push(h('span', { key: 'created', className: 'dsm-metaMuted' }, tr('row.createdUnknown')));
        }
        var detailLastUsed = lastUsedAt(session);
        if (detailLastUsed > 0) {
          meta.push(h('span', { key: 'lastUsed' }, tr('detail.lastUsed', { time: formatDateTime(detailLastUsed), rel: relativeLabel(detailLastUsed) })));
        }
        if (session && session.running) meta.push(h('span', { key: 'running' }, tr('row.running')));
        if (archived) meta.push(h('span', { key: 'archived' }, tr('row.archived')));

        var loadErrorText = useErrorMessage(state.error);

        var body;
        if (state.phase === 'loading') {
          body = h('div', { className: 'dsm-loading' }, Icon('IconLoadingOutlineRegular', { className: 'dsm-spin' }), h('span', null, tr('detail.loading')));
        } else if (state.phase === 'error') {
          body = h(
            'div',
            { className: 'dsm-error' },
            h('span', { className: 'dsm-errorText' }, tr('detail.loadFailed') + (loadErrorText ? ' — ' + loadErrorText : '')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn',
                onClick: function () {
                  setReloadKey(function (value) {
                    return value + 1;
                  });
                },
              },
              tr('action.retry'),
            ),
          );
        } else if (items.length === 0) {
          body = h(
            'div',
            { className: 'dsm-empty' },
            h('div', { className: 'dsm-emptyTitle' }, tr('detail.empty')),
            h('div', { className: 'dsm-emptyHint' }, tr('detail.emptyHint')),
          );
        } else {
          body = items.map(renderItem);
        }

        return h(
          'section',
          { className: 'dsm-detail', 'aria-label': title },
          h(
            'header',
            { className: 'dsm-detailHead' },
            h(
              'div',
              { className: 'dsm-detailTop' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-iconBtn dsm-back',
                  title: tr('detail.back'),
                  'aria-label': tr('detail.back'),
                  onClick: props.onBack,
                },
                Icon('IconChevronLeftOutlineRegular'),
              ),
              h('h2', { className: 'dsm-detailTitle', title: title }, title),
              h(
                'div',
                { className: 'dsm-detailActions' },
                archived ? h('span', { className: 'dsm-rowTag' }, tr('row.archived')) : null,
                h(
                  'button',
                  { type: 'button', className: 'dsm-btn', disabled: archived, title: archived ? tr('toast.archivedOpen') : tr('detail.open'), onClick: props.onOpen },
                  Icon('IconRightUpOutlineRegular', { className: 'dsm-btnIcon' }),
                  tr('detail.open'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsm-btn', onClick: props.onArchive },
                  Icon(archived ? 'IconUnarchiveOutlineRegular' : 'IconArchiveOutlineRegular', { className: 'dsm-btnIcon' }),
                  archived ? tr('action.unarchive') : tr('action.archive'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsm-iconBtn', title: tr('action.copyId'), 'aria-label': tr('action.copyId'), onClick: props.onCopyId },
                  Icon('IconCopyOutlineRegular'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-iconBtn',
                    title: props.pinned ? tr('action.unpin') : tr('action.pin'),
                    'aria-label': props.pinned ? tr('action.unpin') : tr('action.pin'),
                    'aria-pressed': props.pinned ? 'true' : 'false',
                    onClick: props.onTogglePin,
                  },
                  Icon('IconPinOutlineRegular'),
                ),
              ),
            ),
            meta.length > 0 ? h('div', { className: 'dsm-detailMeta' }, meta) : null,
          ),
          h(
            'div',
            { className: 'dsm-detailScroll', ref: scrollRef },
            h(
              'div',
              { className: 'dsm-chat' },
              state.hasMore === true
                ? h(
                    'div',
                    { className: 'dsm-moreWrap' },
                    h(
                      'button',
                      { type: 'button', className: 'dsm-btn', disabled: state.older === true, onClick: loadOlder },
                      state.older === true ? tr('detail.loadingOlder') : tr('detail.loadOlder'),
                    ),
                  )
                : items.length > 0 && state.phase === 'ready'
                  ? h('p', { className: 'dsm-endNote' }, tr('detail.noMore'))
                  : null,
              body,
              items.length > 0 && state.phase === 'ready'
                ? h('p', { className: 'dsm-endNote' }, tr('detail.footer', { n: items.length }))
                : null,
            ),
          ),
        );
      }

      /* ------------------------------------------------------------------ */
      /* the page                                                            */
      /* ------------------------------------------------------------------ */

      /* Full-width editor for one settings scope: the global profile, or one
       * workspace profile that either stacks with the global profile or
       * overrides it. Saving goes to the host half, which injects the effective
       * profile into the matching sessions' system prompt on each assembly. */
      function SessionSettingsForm(props) {
        var draft = props.draft || settingsToDraft(null);
        var occupation = typeof draft.occupation === 'string' ? draft.occupation : '';
        var instructions = typeof draft.instructions === 'string' ? draft.instructions : '';
        var presets = occupationPresets();
        var custom = draft.customOccupation === true;
        var selectValue = custom ? '__custom__' : occupation;
        var withOverride = props.scopeKind === 'workspace';

        function onOccupationSelect(event) {
          var next = event.target.value;
          if (next === '__custom__') {
            props.onChange('customOccupation', true);
            if (presets.indexOf(occupation) >= 0) props.onChange('occupation', '');
            return;
          }
          props.onChange('customOccupation', false);
          props.onChange('occupation', next);
        }

        var clearRow = null;
        if (props.clearArmed) {
          clearRow = h(
            'div',
            { className: 'dsm-clearConfirm', role: 'alertdialog', 'aria-label': tr('settings.clearConfirm') },
            h('span', null, tr('settings.clearConfirm')),
            h(
              'span',
              { className: 'dsm-clearConfirmActions' },
              h('button', { type: 'button', className: 'dsm-btn', onClick: props.onCancelClear }, tr('settings.clearCancel')),
              h('button', { type: 'button', className: 'dsm-btn dsm-btnDanger', onClick: props.onClear }, tr('settings.clearConfirmAction')),
            ),
          );
        }

        var overrideRow = null;
        if (withOverride) {
          overrideRow = h(
            'label',
            { className: 'dsm-switchRow dsm-overrideRow' },
            h(
              'span',
              { className: 'dsm-switchText' },
              h('span', { className: 'dsm-fieldLabel' }, tr('settings.override')),
              h('span', { className: 'dsm-fieldHint' }, tr('settings.overrideHint')),
            ),
            h('input', {
              type: 'checkbox',
              className: 'dsm-switch',
              checked: draft.override === true,
              onChange: function (event) {
                props.onChange('override', event.target.checked);
              },
            }),
          );
        }

        var note = withOverride && draft.override === true ? tr('settings.effectiveOverride') : tr('settings.effective');

        return h(
          'div',
          { className: 'dsm-settingsPage' },
          h(
            'header',
            { className: 'dsm-settingsHead' },
            h(
              'div',
              { className: 'dsm-settingsTitleWrap' },
              h('h2', { className: 'dsm-settingsTitle' }, props.title),
              h('p', { className: 'dsm-settingsCaption', title: props.caption }, props.caption),
            ),
          ),
          h(
            'div',
            { className: 'dsm-settingsScroll' },
            h(
              'div',
              { className: 'dsm-settingsCard' },
              h(
                'label',
                { className: 'dsm-switchRow' },
                h(
                  'span',
                  { className: 'dsm-switchText' },
                  h('span', { className: 'dsm-fieldLabel' }, tr('settings.enabled')),
                  h('span', { className: 'dsm-fieldHint' }, tr('settings.enabledHint')),
                ),
                h('input', {
                  type: 'checkbox',
                  className: 'dsm-switch',
                  checked: draft.enabled !== false,
                  onChange: function (event) {
                    props.onChange('enabled', event.target.checked);
                  },
                }),
              ),
              overrideRow,
              h(
                'div',
                { className: 'dsm-field' },
                h('label', { className: 'dsm-fieldLabel', htmlFor: 'dsm-settings-name' }, tr('settings.name')),
                h('input', {
                  id: 'dsm-settings-name',
                  className: 'dsm-input',
                  type: 'text',
                  value: typeof draft.name === 'string' ? draft.name : '',
                  maxLength: NAME_LIMIT,
                  placeholder: tr('settings.namePlaceholder'),
                  onChange: function (event) {
                    props.onChange('name', event.target.value);
                  },
                }),
                h('p', { className: 'dsm-fieldHint' }, tr('settings.nameAccountHint')),
              ),
              h(
                'div',
                { className: 'dsm-field' },
                h('label', { className: 'dsm-fieldLabel' }, tr('settings.occupation')),
                h(
                  'div',
                  { className: 'dsm-occupation' },
                  h(
                    'select',
                    {
                      className: 'dsm-select',
                      value: selectValue,
                      'aria-label': tr('settings.occupation'),
                      onChange: onOccupationSelect,
                    },
                    h('option', { value: '' }, tr('settings.occupationPlaceholder')),
                    presets.map(function (label) {
                      return h('option', { key: label, value: label }, label);
                    }),
                    h('option', { value: '__custom__' }, tr('settings.occupation.custom')),
                  ),
                  custom
                    ? h('input', {
                        className: 'dsm-input',
                        type: 'text',
                        value: occupation,
                        maxLength: OCCUPATION_LIMIT,
                        placeholder: tr('settings.occupationPlaceholder'),
                        'aria-label': tr('settings.occupation'),
                        onChange: function (event) {
                          props.onChange('occupation', event.target.value);
                        },
                      })
                    : null,
                ),
              ),
              h(
                'div',
                { className: 'dsm-field' },
                h('label', { className: 'dsm-fieldLabel', htmlFor: 'dsm-settings-instructions' }, tr('settings.instructions')),
                h('textarea', {
                  id: 'dsm-settings-instructions',
                  className: 'dsm-textarea',
                  rows: 10,
                  value: instructions,
                  maxLength: INSTRUCTIONS_LIMIT,
                  placeholder: tr('settings.instructionsPlaceholder'),
                  onChange: function (event) {
                    props.onChange('instructions', event.target.value);
                  },
                }),
                h(
                  'div',
                  { className: 'dsm-fieldFoot' },
                  h('span', { className: 'dsm-counter' }, tr('settings.counter', { n: instructions.length, max: INSTRUCTIONS_LIMIT })),
                  h('span', { className: 'dsm-fieldHint' }, tr('settings.instructionsHint', { n: INSTRUCTIONS_LIMIT })),
                ),
              ),
              h('p', { className: 'dsm-settingsNote' }, note),
              props.error !== null && props.error !== undefined && props.error !== ''
                ? h('p', { className: 'dsm-formError', role: 'alert' }, props.error)
                : null,
              clearRow,
              h(
                'div',
                { className: 'dsm-formActions' },
                props.configured
                  ? h(
                      'button',
                      { type: 'button', className: 'dsm-btn', disabled: props.saving || props.clearing || props.clearArmed, onClick: props.onArmClear },
                      props.clearing ? tr('settings.clearing') : tr('settings.clear'),
                    )
                  : null,
                h(
                  'button',
                  { type: 'button', className: 'dsm-btn dsm-btnPrimary', disabled: props.saving || props.clearing, onClick: props.onSave },
                  props.saving ? tr('settings.saving') : tr('settings.save'),
                ),
              ),
            ),
          ),
        );
      }

      function SessionManagerPage(props) {
        var sessionsService = props.sessions;
        var workspacesService = props.workspaces;
        var uiWorkspace = props.uiWorkspace;
        var remote = props.remote;
        var pageFeatures = useFeatures();

        var sessionsState = useServiceSnapshot(sessionsService && sessionsService.list, EMPTY_SESSIONS);
        var workspaceState = useServiceSnapshot(workspacesService && workspacesService.list, EMPTY_WORKSPACES);

        var [archiveFilter, setArchiveFilter] = useState('active');
        var [search, setSearch] = useState('');
        var [scope, setScope] = useState('all');
        var [selectedId, setSelectedId] = useState(null);
        var [confirmArchive, setConfirmArchive] = useState(null);
        var [toast, setToast] = useState(null);
        var [rowMenu, setRowMenu] = useState(null);
        var [selectMode, setSelectMode] = useState(false);
        var [selected, setSelected] = useState({});
        var [batchConfirm, setBatchConfirm] = useState(null);
        var [createdTimes, setCreatedTimes] = useState(createdAtById);
        var [renameTarget, setRenameTarget] = useState(null);
        var [renameDraft, setRenameDraft] = useState('');
        var [renaming, setRenaming] = useState(false);
        var [renameError, setRenameError] = useState(null);
        var [pageTab, setPageTab] = useState(props && props.standaloneTab === 'settings' ? 'settings' : 'sessions');
        var [settingsMap, setSettingsMap] = useState(settingsByScope);
        var [settingsPhase, setSettingsPhase] = useState('idle');
        var [settingsError, setSettingsError] = useState(null);
        var [settingsTarget, setSettingsTarget] = useState(GLOBAL_SCOPE_KEY);
        var [settingsDraft, setSettingsDraft] = useState(null);
        var [settingsSaving, setSettingsSaving] = useState(false);
        var [settingsClearing, setSettingsClearing] = useState(false);
        var [settingsSaveError, setSettingsSaveError] = useState(null);
        var [settingsClearArmed, setSettingsClearArmed] = useState(false);

        var pageRef = useRef(null);
        var listScrollRef = useRef(null);
        var listScrollTop = useRef(0);
        var renameInputRef = useRef(null);
        var renameComposing = useRef(false);

        var byId = sessionsState.byId || {};
        var allIds = sessionsState.ids || [];
        var workspaceItems = workspaceState.items || [];
        var archivedIds = workspaceState.archivedSessionIds || [];
        var pinnedIds = workspaceState.pinnedSessionIds || [];
        var settingsMode = pageTab === 'settings';

        var archivedSet = useMemo(
          function () {
            var set = {};
            archivedIds.forEach(function (id) {
              set[id] = true;
            });
            return set;
          },
          [archivedIds],
        );

        var pinnedSet = useMemo(
          function () {
            var set = {};
            pinnedIds.forEach(function (id) {
              set[id] = true;
            });
            return set;
          },
          [pinnedIds],
        );

        var membership = useMemo(
          function () {
            var map = {};
            workspaceItems.forEach(function (item) {
              (item.sessionIds || []).forEach(function (id) {
                map[id] = item.workspaceId;
              });
            });
            return map;
          },
          [workspaceItems],
        );

        var workspaceById = useMemo(
          function () {
            var map = {};
            workspaceItems.forEach(function (item) {
              map[item.workspaceId] = item;
            });
            return map;
          },
          [workspaceItems],
        );

        var query = search.trim().toLowerCase();

        var eligible = useMemo(
          function () {
            return allIds.filter(function (id) {
              var row = byId[id];
              if (!row) return false;
              if (row.origin === 'subagent') return false;
              if (row.blank === true) return false;
              return true;
            });
          },
          [allIds, byId],
        );

        var filtered = useMemo(
          function () {
            return eligible.filter(function (id) {
              var archived = archivedSet[id] === true;
              if (archiveFilter === 'active' && archived) return false;
              if (archiveFilter === 'archived' && !archived) return false;
              if (query !== '') {
                var row = byId[id] || {};
                var title = (row.displayTitle || row.title || '').toLowerCase();
                if (title.indexOf(query) < 0 && id.toLowerCase().indexOf(query) < 0) return false;
              }
              return true;
            });
          },
          [eligible, archiveFilter, query, byId, archivedSet],
        );

        var counts = useMemo(
          function () {
            var perWorkspace = {};
            var ungrouped = 0;
            filtered.forEach(function (id) {
              var workspaceId = membership[id];
              if (workspaceId === undefined) ungrouped += 1;
              else perWorkspace[workspaceId] = (perWorkspace[workspaceId] || 0) + 1;
            });
            return { total: filtered.length, perWorkspace: perWorkspace, ungrouped: ungrouped };
          },
          [filtered, membership],
        );

        var sorted = useMemo(
          function () {
            var scopedIds = filtered.filter(function (id) {
              if (scope === 'all') return true;
              if (scope === '__ungrouped__') return membership[id] === undefined;
              return membership[id] === scope;
            });
            scopedIds.sort(function (left, right) {
              var leftPinned = pinnedSet[left] === true ? 0 : 1;
              var rightPinned = pinnedSet[right] === true ? 0 : 1;
              if (leftPinned !== rightPinned) return leftPinned - rightPinned;
              var leftTime = (byId[left] && byId[left].updatedAt) || 0;
              var rightTime = (byId[right] && byId[right].updatedAt) || 0;
              return rightTime - leftTime;
            });
            return scopedIds;
          },
          [filtered, scope, membership, pinnedSet, byId],
        );

        var groups = useMemo(
          function () {
            if (scope !== 'all' || query !== '') return null;
            var result = [];
            workspaceItems.forEach(function (item) {
              var ids = sorted.filter(function (id) {
                return membership[id] === item.workspaceId;
              });
              if (ids.length > 0) result.push({ key: item.workspaceId, title: workspaceTitle(item), ids: ids });
            });
            var ungroupedIds = sorted.filter(function (id) {
              return membership[id] === undefined;
            });
            if (ungroupedIds.length > 0) result.push({ key: '__ungrouped__', title: tr('scope.ungrouped'), ids: ungroupedIds });
            return result;
          },
          [scope, query, sorted, workspaceItems, membership],
        );

        var listedCount = sorted.length;

        var scopeTitle;
        if (scope === 'all') scopeTitle = tr('scope.all');
        else if (scope === '__ungrouped__') scopeTitle = tr('scope.ungrouped');
        else scopeTitle = workspaceTitle(workspaceById[scope]) || tr('scope.all');

        var loadingList =
          allIds.length === 0 &&
          (!sessionsState.phase || sessionsState.phase === 'loading' || sessionsState.phase === 'idle');

        /* ---- batch selection ---- */
        var selectedList = Object.keys(selected).filter(function (id) {
          return selected[id] === true && byId[id] !== undefined;
        });
        var selectedCount = selectedList.length;
        var selectedArchivedIds = selectedList.filter(function (id) {
          return archivedSet[id] === true;
        });
        var selectedActiveIds = selectedList.filter(function (id) {
          return archivedSet[id] !== true;
        });

        /* ---- host-served creation times ---- */
        useEffect(
          function () {
            var cancelled = false;
            loadCreatedTimes().then(function (map) {
              if (!cancelled) setCreatedTimes(Object.assign({}, map));
            });
            return function () {
              cancelled = true;
            };
          },
          [],
        );

        /* ---- feature switch: leave the settings tab if it was turned off ---- */
        useEffect(
          function () {
            if (!pageFeatures.settings && pageTab === 'settings') {
              setPageTab('sessions');
            }
          },
          [pageFeatures.settings, pageTab],
        );

        /* ---- rename dialog ---- */
        useEffect(
          function () {
            if (renameTarget !== null && renameInputRef.current !== null) {
              renameInputRef.current.focus();
              renameInputRef.current.select();
            }
          },
          [renameTarget],
        );

        /* ---- toasts ---- */
        useEffect(
          function () {
            if (!toast) return;
            var timer = setTimeout(function () {
              setToast(null);
            }, 3200);
            return function () {
              clearTimeout(timer);
            };
          },
          [toast],
        );

        function notify(text, tone) {
          setToast({ text: text, tone: tone || 'info' });
        }

        /* ---- row menu dismissal ---- */
        useEffect(
          function () {
            if (!rowMenu) return;
            function onPointerDown(event) {
              var target = event.target;
              if (target && target.closest && (target.closest('.dsm-rowMenu') || target.closest('[data-dsm-kebab]'))) return;
              setRowMenu(null);
            }
            function onScroll() {
              setRowMenu(null);
            }
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);
            return function () {
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('scroll', onScroll, true);
              window.removeEventListener('resize', onScroll);
            };
          },
          [rowMenu],
        );

        /* ---- 会话设定 (global + workspace scopes, host half) ---- */
        useEffect(
          function () {
            var cancelled = false;
            setSettingsPhase('loading');
            loadSettings(false).then(
              function (map) {
                if (cancelled) return;
                setSettingsMap(Object.assign({}, map));
                setSettingsPhase('ready');
              },
              function (error) {
                if (cancelled) return;
                setSettingsError(errorText(error));
                setSettingsPhase('error');
              },
            );
            return function () {
              cancelled = true;
            };
          },
          [],
        );

        /* ---- keep the settings draft in sync with the active scope ---- */
        useEffect(
          function () {
            if (!settingsMode || settingsPhase !== 'ready') return;
            var key = settingsTarget;
            if (!scopeIsGlobal(key) && workspaceById[key] === undefined) {
              setSettingsTarget(GLOBAL_SCOPE_KEY);
              setSettingsDraft(settingsToDraft(settingsMap[GLOBAL_SCOPE_KEY]));
              setSettingsClearArmed(false);
              setSettingsSaveError(null);
              return;
            }
            var seeded = settingsToDraft(settingsMap[key]);
            setSettingsDraft(seeded);
            prefillAccountName(seeded, setSettingsDraft);
          },
          [settingsMode, settingsPhase, settingsTarget, workspaceById, settingsMap],
        );

        /* ---- keep detail sane when the session disappears ---- */
        useEffect(
          function () {
            if (selectedId !== null && byId[selectedId] === undefined) setSelectedId(null);
          },
          [selectedId, byId],
        );


        /* ---- list scroll restore after returning from detail ---- */
        useLayoutEffect(
          function () {
            if (selectedId === null && listScrollRef.current) listScrollRef.current.scrollTop = listScrollTop.current;
          },
          [selectedId],
        );

        function openDetail(sessionId) {
          if (listScrollRef.current) listScrollTop.current = listScrollRef.current.scrollTop;
          setRowMenu(null);
          setSelectedId(sessionId);
        }

        function openSession(sessionId) {
          if (archivedSet[sessionId] === true) {
            notify(tr('toast.archivedOpen'), 'warning');
            return;
          }
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
            try {
              uiWorkspace.openSession(sessionId);
            } catch (error) {
              notify(errorText(error), 'error');
            }
          }
        }

        /* ---- 会话设定 (global + workspace scopes, host half) ---- */
        function switchTab(nextTab) {
          if (nextTab === pageTab) return;
          if (nextTab === 'settings' && !pageFeatures.settings) return;
          setRowMenu(null);
          setSelectMode(false);
          setSelected({});
          setSelectedId(null);
          setSettingsClearArmed(false);
          setSettingsSaveError(null);
          setPageTab(nextTab);
          if (nextTab === 'settings') {
            setSettingsTarget(GLOBAL_SCOPE_KEY);
            setSettingsDraft(settingsToDraft(settingsMap[GLOBAL_SCOPE_KEY]));
            if (settingsPhase === 'error') reloadSettings();
          }
        }

        function reloadSettings() {
          setSettingsPhase('loading');
          setSettingsError(null);
          loadSettings(true).then(
            function (map) {
              setSettingsMap(Object.assign({}, map));
              setSettingsPhase('ready');
            },
            function (error) {
              setSettingsError(errorText(error));
              setSettingsPhase('error');
            },
          );
        }

        function openScope(scopeKey) {
          if (scopeKey === settingsTarget) return;
          setSettingsTarget(scopeKey);
          setSettingsDraft(settingsToDraft(settingsMap[scopeKey]));
          setSettingsSaveError(null);
          setSettingsClearArmed(false);
        }

        function changeSettings(field, value) {
          setSettingsDraft(function (previous) {
            var next = Object.assign({}, previous || settingsToDraft(null));
            next[field] = value;
            return next;
          });
          setSettingsSaveError(null);
        }

        function saveSettingsForm() {
          if (settingsDraft === null || settingsPhase !== 'ready' || settingsSaving || settingsClearing) return;
          var scopeKey = settingsTarget;
          var withOverride = !scopeIsGlobal(scopeKey);
          var payload = draftToSettings(settingsDraft, withOverride);
          setSettingsSaving(true);
          setSettingsSaveError(null);
          saveHostSettings(scopeKey, payload).then(
            function (value) {
              setSettingsSaving(false);
              var saved = value && value.settings ? normalizeClientSettings(value.settings, withOverride) : null;
              var next = Object.assign({}, settingsMap);
              if (saved !== null) next[scopeKey] = saved;
              settingsByScope = next;
              settingsPromise = Promise.resolve(Object.assign({}, next));
              setSettingsMap(next);
              setSettingsClearArmed(false);
              notify(tr('settings.saved'), 'success');
            },
            function (error) {
              setSettingsSaving(false);
              setSettingsSaveError(errorText(error));
            },
          );
        }

        function clearSettingsForm() {
          if (settingsPhase !== 'ready' || settingsSaving || settingsClearing) return;
          var scopeKey = settingsTarget;
          setSettingsClearing(true);
          setSettingsSaveError(null);
          clearHostSettings(scopeKey).then(
            function () {
              setSettingsClearing(false);
              setSettingsClearArmed(false);
              var next = Object.assign({}, settingsMap);
              delete next[scopeKey];
              settingsByScope = next;
              settingsPromise = Promise.resolve(Object.assign({}, next));
              setSettingsMap(next);
              setSettingsDraft(settingsToDraft(null));
              notify(tr('settings.cleared'), 'success');
            },
            function (error) {
              setSettingsClearing(false);
              setSettingsSaveError(errorText(error));
            },
          );
        }

        function archiveSession(sessionId, isArchived) {
          if (!workspacesService) return;
          if (isArchived) {
            workspacesService
              .unarchiveSession(sessionId)
              .then(function () {
                notify(tr('toast.unarchived'), 'success');
              })
              .catch(function (error) {
                notify(errorText(error), 'error');
              });
            return;
          }
          workspacesService
            .archiveSession(sessionId)
            .then(function () {
              notify(tr('toast.archived'), 'success');
            })
            .catch(function (error) {
              if (isSessionActiveError(error)) {
                setConfirmArchive(sessionId);
                return;
              }
              notify(errorText(error), 'error');
            });
        }

        function stopAndArchive() {
          var sessionId = confirmArchive;
          setConfirmArchive(null);
          if (!sessionId || !workspacesService) return;
          workspacesService
            .archiveSession(sessionId, { stopActivity: true })
            .then(function () {
              notify(tr('toast.archived'), 'success');
            })
            .catch(function (error) {
              notify(errorText(error), 'error');
            });
        }

        function togglePin(sessionId) {
          if (!workspacesService) return;
          var pinned = pinnedSet[sessionId] === true;
          var action = pinned ? workspacesService.unpinSession(sessionId) : workspacesService.pinSession(sessionId);
          action
            .then(function () {
              notify(pinned ? tr('toast.unpinned') : tr('toast.pinned'), 'success');
            })
            .catch(function (error) {
              notify(errorText(error), 'error');
            });
        }

        /* ---- batch selection helpers ---- */
        function toggleSelected(sessionId) {
          setSelected(function (previous) {
            var next = {};
            Object.keys(previous).forEach(function (id) {
              if (previous[id] === true) next[id] = true;
            });
            if (next[sessionId] === true) delete next[sessionId];
            else next[sessionId] = true;
            return next;
          });
        }

        function selectAllVisible() {
          var next = {};
          sorted.forEach(function (id) {
            next[id] = true;
          });
          setSelected(next);
        }

        function clearSelected() {
          setSelected({});
        }

        function dropSelected(ids) {
          if (!ids || ids.length === 0) return;
          setSelected(function (previous) {
            var next = {};
            Object.keys(previous).forEach(function (id) {
              if (previous[id] === true && ids.indexOf(id) < 0) next[id] = true;
            });
            return next;
          });
        }

        function exitSelectMode() {
          setSelectMode(false);
          setSelected({});
        }

        function batchArchive() {
          if (!workspacesService) return;
          var ids = selectedActiveIds.slice();
          if (ids.length === 0) return;
          Promise.all(
            ids.map(function (id) {
              return workspacesService.archiveSession(id).then(
                function () {
                  return { id: id, ok: true };
                },
                function (error) {
                  return { id: id, ok: false, error: error };
                },
              );
            }),
          ).then(function (results) {
            var done = [];
            var stop = [];
            var failed = 0;
            results.forEach(function (result) {
              if (result.ok) done.push(result.id);
              else if (isSessionActiveError(result.error)) stop.push(result.id);
              else failed += 1;
            });
            if (done.length > 0) {
              dropSelected(done);
              notify(tr('batch.archivedN', { n: done.length }), 'success');
            }
            if (stop.length > 0) setBatchConfirm(stop);
            if (failed > 0) notify(tr('batch.failedN', { n: failed }), 'error');
          });
        }

        function stopAndBatchArchive() {
          var ids = Array.isArray(batchConfirm) ? batchConfirm.slice() : [];
          setBatchConfirm(null);
          if (ids.length === 0 || !workspacesService) return;
          Promise.all(
            ids.map(function (id) {
              return workspacesService.archiveSession(id, { stopActivity: true }).then(
                function () {
                  return { id: id, ok: true };
                },
                function (error) {
                  return { id: id, ok: false, error: error };
                },
              );
            }),
          ).then(function (results) {
            var done = [];
            var failed = 0;
            results.forEach(function (result) {
              if (result.ok) done.push(result.id);
              else failed += 1;
            });
            if (done.length > 0) {
              dropSelected(done);
              notify(tr('batch.archivedN', { n: done.length }), 'success');
            }
            if (failed > 0) notify(tr('batch.failedN', { n: failed }), 'error');
          });
        }

        function batchUnarchive() {
          if (!workspacesService) return;
          var ids = selectedArchivedIds.slice();
          if (ids.length === 0) return;
          Promise.all(
            ids.map(function (id) {
              return workspacesService.unarchiveSession(id).then(
                function () {
                  return { id: id, ok: true };
                },
                function (error) {
                  return { id: id, ok: false, error: error };
                },
              );
            }),
          ).then(function (results) {
            var done = [];
            var failed = 0;
            results.forEach(function (result) {
              if (result.ok) done.push(result.id);
              else failed += 1;
            });
            if (done.length > 0) {
              dropSelected(done);
              notify(tr('batch.unarchivedN', { n: done.length }), 'success');
            }
            if (failed > 0) notify(tr('batch.failedN', { n: failed }), 'error');
          });
        }

        function copySessionId(sessionId) {
          var text = String(sessionId);
          function done() {
            notify(tr('toast.idCopied'), 'success');
          }
          function failed() {
            notify(tr('toast.idCopyFailed'), 'error');
          }
          if (hasPrimitive('writeClipboard')) {
            try {
              Promise.resolve(primitives.writeClipboard(text)).then(done, failed);
              return;
            } catch (error) {
              /* fall through */
            }
          }
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(text).then(done, failed);
              return;
            }
          } catch (error) {
            /* fall through */
          }
          failed();
        }

        /* ---- rename ---- */
        function beginRename(sessionId) {
          var row = byId[sessionId] || {};
          setRenameTarget({ sessionId: sessionId });
          setRenameDraft(typeof row.title === 'string' ? row.title : '');
          setRenameError(null);
          setRenaming(false);
          setRowMenu(null);
        }

        function cancelRename() {
          if (renaming) return;
          setRenameTarget(null);
          setRenameDraft('');
          setRenameError(null);
        }

        function confirmRename() {
          if (renameTarget === null || renaming) return;
          var title = renameDraft.trim();
          if (title === '') return;
          var sessionsService = props.sessions;
          if (!sessionsService || typeof sessionsService.using !== 'function') {
            setRenameError(tr('rename.unavailable'));
            return;
          }
          setRenaming(true);
          setRenameError(null);
          sessionsService
            .using(
              renameTarget.sessionId,
              { source: 'workspaceOperation' },
              function (reference) {
                return reference.binding.session.rename(title);
              },
            )
            .then(
              function (result) {
                setRenaming(false);
                if (result && result.ok === false) {
                  setRenameError(errorText(result.error));
                  return;
                }
                setRenameTarget(null);
                setRenameDraft('');
                notify(tr('toast.renamed'), 'success');
              },
              function (error) {
                setRenaming(false);
                setRenameError(errorText(error));
              },
            );
        }

        function openRowMenu(sessionId, anchor) {
          if (!pageRef.current) return;
          if (rowMenu && rowMenu.id === sessionId) {
            setRowMenu(null);
            return;
          }
          var rect = anchor.getBoundingClientRect();
          var pageRect = pageRef.current.getBoundingClientRect();
          var width = 150;
          var left = rect.right - pageRect.left - width;
          if (left < 8) left = 8;
          var top = rect.bottom - pageRect.top + 4;
          setRowMenu({ id: sessionId, top: top, left: left });
        }

        /* ---- list rows ---- */
        function renderRow(sessionId) {
          var row = byId[sessionId] || {};
          var archived = archivedSet[sessionId] === true;
          var pinned = pinnedSet[sessionId] === true;
          var title = sessionTitle(row);
          var tokens = tokenText(row);
          var workspaceId = membership[sessionId];
          var workspaceLabel = scope === 'all' && query === '' && groups === null && workspaceId !== undefined ? workspaceTitle(workspaceById[workspaceId]) : '';
          var isSelected = selected[sessionId] === true;

          var metaParts = [];
          var created = row.id !== undefined && typeof createdTimes[row.id] === 'number' ? createdTimes[row.id] : 0;
          if (created > 0) {
            metaParts.push(
              h(
                'span',
                { key: 'created', title: tr('row.createdTitle') + ' ' + formatDateTime(created) + ' · ' + relativeLabel(created) },
                tr('row.created', { time: formatDateTime(created) }),
              ),
            );
          } else {
            metaParts.push(h('span', { key: 'created', className: 'dsm-metaMuted' }, tr('row.createdUnknown')));
          }
          var lastUsed = lastUsedAt(row);
          if (lastUsed > 0) {
            metaParts.push(h('span', { key: 'lastUsed', title: formatDateTime(lastUsed) }, tr('row.lastUsed', { time: relativeLabel(lastUsed) })));
          }
          if (workspaceLabel !== '') metaParts.push(h('span', { key: 'ws' }, workspaceLabel));
          if (tokens !== '') metaParts.push(h('span', { key: 'tokens' }, tr('row.tokens', { n: tokens })));

          var rowMain = h(
            'button',
            {
              key: 'main',
              type: 'button',
              className: 'dsm-rowMain',
              title: title,
              onClick: function () {
                if (selectMode) toggleSelected(sessionId);
                else openDetail(sessionId);
              },
            },
            h(
              'span',
              { className: 'dsm-rowTitleWrap' },
              pinned ? Icon('IconPinOutlineRegular', { className: 'dsm-rowPin' }) : null,
              h('span', { className: 'dsm-rowTitle' }, title),
              row.running ? h('span', { className: 'dsm-dot', title: tr('row.running') }) : null,
              archived ? h('span', { className: 'dsm-rowTag' }, tr('row.archived')) : null,
            ),
            metaParts.length > 0 ? h('span', { className: 'dsm-rowMeta' }, metaParts) : null,
          );

          var rowActions = null;
          if (!selectMode) {
            rowActions = h(
              'span',
              { key: 'actions', className: 'dsm-rowActions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-iconBtn',
                  title: tr('action.rename'),
                  'aria-label': tr('action.rename'),
                  onClick: function () {
                    beginRename(sessionId);
                  },
                },
                Icon('IconEditOutlineRegular'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-iconBtn',
                  title: tr('action.open'),
                  'aria-label': tr('action.open'),
                  disabled: archived,
                  onClick: function () {
                    openSession(sessionId);
                  },
                },
                Icon('IconRightUpOutlineRegular'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-iconBtn',
                  title: archived ? tr('action.unarchive') : tr('action.archive'),
                  'aria-label': archived ? tr('action.unarchive') : tr('action.archive'),
                  onClick: function () {
                    archiveSession(sessionId, archived);
                  },
                },
                Icon(archived ? 'IconUnarchiveOutlineRegular' : 'IconArchiveOutlineRegular'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsm-iconBtn',
                  title: tr('action.more'),
                  'aria-label': tr('action.more'),
                  'data-dsm-kebab': '1',
                  onClick: function (event) {
                    openRowMenu(sessionId, event.currentTarget);
                  },
                },
                Icon('IconEllipsisOutlineRegular'),
              ),
            );
          }

          var rowChildren = [];
          if (selectMode) {
            rowChildren.push(
              h('input', {
                key: 'check',
                type: 'checkbox',
                className: 'dsm-check',
                checked: isSelected,
                'aria-label': title,
                onChange: function () {
                  toggleSelected(sessionId);
                },
              }),
            );
          }
          rowChildren.push(rowMain);
          if (rowActions !== null) rowChildren.push(rowActions);

          return h(
            'li',
            {
              key: sessionId,
              className: 'dsm-rowItem' + (selectMode ? ' dsm-rowSelecting' : ''),
              'data-selected': isSelected ? 'true' : 'false',
            },
            h('div', { className: 'dsm-row' + (archived ? ' dsm-rowArchived' : '') }, rowChildren),
          );
        }

        /* ---- left column ---- */
        function renderNavItem(options) {
          var tags = Array.isArray(options.tags) ? options.tags : [];
          return h(
            'button',
            {
              key: options.key,
              type: 'button',
              className: 'dsm-navItem',
              'data-active': options.active ? 'true' : 'false',
              'aria-current': options.active ? 'page' : undefined,
              title: options.title,
              onClick: options.onClick,
            },
            Icon(options.icon, { className: 'dsm-navIcon' }),
            h('span', { className: 'dsm-navLabel' }, options.label),
            tags.length > 0
              ? h(
                  'span',
                  { className: 'dsm-navTags' },
                  tags.map(function (tag, index) {
                    return h('span', { key: index, className: 'dsm-navTag' }, tag);
                  }),
                )
              : null,
            typeof options.count === 'number' ? h('span', { className: 'dsm-navCount' }, String(options.count)) : null,
          );
        }

        var navItems = [];
        navItems.push(
          renderNavItem({
            key: 'all',
            icon: 'IconFlatListOutlineRegular',
            label: tr('scope.all'),
            count: counts.total,
            active: scope === 'all',
            title: tr('scope.all'),
            onClick: function () {
              setScope('all');
            },
          }),
        );
        workspaceItems.forEach(function (item) {
          navItems.push(
            renderNavItem({
              key: item.workspaceId,
              icon: 'IconWorkspaceTreeOutlineRegular',
              label: workspaceTitle(item),
              count: counts.perWorkspace[item.workspaceId] || 0,
              active: scope === item.workspaceId,
              title: workspaceTitle(item) + ' — ' + (item.path || ''),
              onClick: function () {
                setScope(item.workspaceId);
              },
            }),
          );
        });
        if (counts.ungrouped > 0) {
          navItems.push(
            renderNavItem({
              key: '__ungrouped__',
              icon: 'IconFolderOpenOutlineRegular',
              label: tr('scope.ungrouped'),
              count: counts.ungrouped,
              active: scope === '__ungrouped__',
              title: tr('scope.ungrouped'),
              onClick: function () {
                setScope('__ungrouped__');
              },
            }),
          );
        }

        var settingsScopeItems = [];
        settingsScopeItems.push(
          renderNavItem({
            key: GLOBAL_SCOPE_KEY,
            icon: 'IconFlatListOutlineRegular',
            label: tr('settings.global.title'),
            tags: settingsMap[GLOBAL_SCOPE_KEY] !== undefined ? [tr('settings.tag.saved')] : [],
            active: settingsTarget === GLOBAL_SCOPE_KEY,
            title: tr('settings.global.title') + ' — ' + tr('settings.hintGlobal'),
            onClick: function () {
              openScope(GLOBAL_SCOPE_KEY);
            },
          }),
        );
        workspaceItems.forEach(function (item) {
          var entry = settingsMap[item.workspaceId];
          var tags = [];
          if (entry !== undefined) tags.push(tr('settings.tag.saved'));
          if (entry !== undefined && entry.override === true) tags.push(tr('settings.tag.override'));
          settingsScopeItems.push(
            renderNavItem({
              key: item.workspaceId,
              icon: 'IconWorkspaceTreeOutlineRegular',
              label: workspaceTitle(item),
              tags: tags,
              active: settingsTarget === item.workspaceId,
              title: workspaceTitle(item) + ' — ' + (item.path || ''),
              onClick: function () {
                openScope(item.workspaceId);
              },
            }),
          );
        });

        /* ---- right column ---- */
        var listBody;
        if (loadingList) {
          listBody = h('div', { className: 'dsm-loading' }, Icon('IconLoadingOutlineRegular', { className: 'dsm-spin' }), h('span', null, tr('loading.list')));
        } else if (listedCount === 0) {
          listBody = h(
            'div',
            { className: 'dsm-empty' },
            h('div', { className: 'dsm-emptyTitle' }, scope === 'all' && query === '' ? tr('list.workspaceEmpty') : tr('list.empty')),
            h('div', { className: 'dsm-emptyHint' }, tr('list.emptyHint')),
          );
        } else if (groups !== null) {
          listBody = groups.map(function (group) {
            return h(
              'section',
              { key: group.key, className: 'dsm-group' },
              h(
                'h3',
                { className: 'dsm-groupHead' },
                h('span', { className: 'dsm-groupTitle' }, group.title),
                h('span', { className: 'dsm-groupCount' }, String(group.ids.length)),
              ),
              h('ul', { className: 'dsm-rows' }, group.ids.map(renderRow)),
            );
          });
        } else {
          listBody = h('ul', { className: 'dsm-rows' }, sorted.map(renderRow));
        }

        var rightHead = h(
          'header',
          { className: 'dsm-rightHead' },
          h(
            'div',
            { className: 'dsm-scopeRow' },
            h('h2', { className: 'dsm-scopeTitle', title: scopeTitle }, scopeTitle),
            h('span', { className: 'dsm-scopeCount' }, query !== '' ? tr('scope.matches', { n: listedCount }) : tr('scope.count', { n: listedCount })),
          ),
          h(
            'div',
            { className: 'dsm-tools' },
            h(
              'div',
              { className: 'dsm-tabs', role: 'tablist', 'aria-label': tr('panel.title') },
              [
                ['active', tr('filter.active')],
                ['all', tr('filter.all')],
                ['archived', tr('filter.archived')],
              ].map(function (pair) {
                return h(
                  'button',
                  {
                    key: pair[0],
                    type: 'button',
                    role: 'tab',
                    'aria-selected': archiveFilter === pair[0] ? 'true' : 'false',
                    className: 'dsm-tab',
                    'data-active': archiveFilter === pair[0] ? 'true' : 'false',
                    onClick: function () {
                      setArchiveFilter(pair[0]);
                    },
                  },
                  pair[1],
                );
              }),
            ),
            h(
              'label',
              { className: 'dsm-search' },
              Icon('IconSearchOutlineRegular', { className: 'dsm-searchIcon' }),
              h('input', {
                type: 'search',
                value: search,
                placeholder: tr('search.placeholder'),
                'aria-label': tr('search.placeholder'),
                onChange: function (event) {
                  setSearch(event.target.value);
                },
              }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn dsm-selectBtn',
                'aria-pressed': selectMode ? 'true' : 'false',
                title: selectMode ? tr('batch.exit') : tr('batch.select'),
                onClick: function () {
                  setRowMenu(null);
                  setSelectMode(function (value) {
                    return !value;
                  });
                  setSelected({});
                },
              },
              Icon(selectMode ? 'IconCloseOutlineRegular' : 'IconCheckOutlineRegular', { className: 'dsm-btnIcon' }),
              h('span', null, selectMode ? tr('batch.exit') : tr('batch.select')),
            ),
          ),
        );

        var batchBar = null;
        if (selectMode) {
          batchBar = h(
            'div',
            { className: 'dsm-batchBar', role: 'region', 'aria-label': tr('batch.selected', { n: selectedCount }) },
            h('span', { className: 'dsm-batchCount' }, tr('batch.selected', { n: selectedCount })),
            h(
              'button',
              { type: 'button', className: 'dsm-btn', onClick: selectAllVisible },
              tr('batch.selectAll'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsm-btn', disabled: selectedCount === 0, onClick: clearSelected },
              tr('batch.clear'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn',
                disabled: selectedActiveIds.length === 0,
                onClick: batchArchive,
              },
              tr('batch.archiveN', { n: selectedActiveIds.length }),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-btn',
                disabled: selectedArchivedIds.length === 0,
                onClick: batchUnarchive,
              },
              tr('batch.unarchiveN', { n: selectedArchivedIds.length }),
            ),
          );
        }

        /* ---- page body ---- */
        var standaloneSettings = props && props.standaloneTab === 'settings';
        var leftHead = h(
          'div',
          { className: 'dsm-leftHead' },
          h('h1', { className: 'dsm-leftTitle' }, tr(standaloneSettings ? 'panel.settingsTitle' : 'panel.title')),
          h('p', { className: 'dsm-leftCaption' }, tr(standaloneSettings ? 'panel.settingsCaption' : 'panel.caption')),
        );

        var pageTabs = h(
          'div',
          { className: 'dsm-pageTabs', role: 'tablist', 'aria-label': tr('panel.title') },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'dsm-pageTab',
              'data-active': settingsMode ? 'false' : 'true',
              'aria-selected': settingsMode ? 'false' : 'true',
              onClick: function () {
                switchTab('sessions');
              },
            },
            tr('page.tab.sessions'),
          ),
          pageFeatures.loaded && pageFeatures.settings
            ? h(
                'button',
                {
                  type: 'button',
                  role: 'tab',
                  className: 'dsm-pageTab',
                  'data-active': settingsMode ? 'true' : 'false',
                  'aria-selected': settingsMode ? 'true' : 'false',
                  onClick: function () {
                    switchTab('settings');
                  },
                },
                tr('page.tab.settings'),
              )
            : null,
        );

        var aside = h(
          'aside',
          { className: 'dsm-left' },
          leftHead,
          props && props.standaloneTab ? null : pageTabs,
          h('nav', { className: 'dsm-nav', 'aria-label': tr('panel.title') }, settingsMode ? settingsScopeItems : navItems),
        );

        var settingsPane = null;
        if (settingsMode) {
          if (settingsPhase === 'error') {
            settingsPane = h(
              'div',
              { className: 'dsm-settingsState' },
              h(
                'div',
                { className: 'dsm-empty' },
                h('div', { className: 'dsm-emptyTitle' }, tr('settings.loadFailed')),
                h('div', { className: 'dsm-emptyHint' }, settingsError || ''),
                h('button', { type: 'button', className: 'dsm-btn', onClick: reloadSettings }, tr('settings.retry')),
              ),
            );
          } else if (settingsPhase !== 'ready') {
            settingsPane = h(
              'div',
              { className: 'dsm-settingsState' },
              h('div', { className: 'dsm-loading' }, Icon('IconLoadingOutlineRegular', { className: 'dsm-spin' }), h('span', null, tr('settings.loading'))),
            );
          } else {
            var scopeKey = settingsTarget;
            var globalScope = scopeIsGlobal(scopeKey);
            var scopeWorkspace = globalScope ? null : workspaceById[scopeKey];
            var scopeTitle = globalScope ? tr('settings.global.title') : workspaceTitle(scopeWorkspace) || tr('settings.global.title');
            var scopeCaption = globalScope ? tr('settings.global.caption') : tr('settings.workspace.caption', { name: scopeTitle });
            var scopeSettings = settingsMap[scopeKey];
            settingsPane = h(SessionSettingsForm, {
              key: 'settings:' + scopeKey,
              scopeKind: globalScope ? 'global' : 'workspace',
              title: scopeTitle,
              caption: scopeCaption,
              draft: settingsDraft || settingsToDraft(scopeSettings),
              configured: scopeSettings !== undefined,
              saving: settingsSaving,
              clearing: settingsClearing,
              clearArmed: settingsClearArmed,
              error: settingsSaveError,
              onChange: changeSettings,
              onSave: saveSettingsForm,
              onClear: clearSettingsForm,
              onArmClear: function () {
                setSettingsClearArmed(true);
              },
              onCancelClear: function () {
                setSettingsClearArmed(false);
              },
            });
          }
        }

        var pageClass = 'dsm-page';
        var content;

        if (settingsMode) {
          content = h('div', { className: 'dsm-twoPane' }, aside, h('div', { className: 'dsm-right' }, settingsPane));
        } else if (selectedId !== null && byId[selectedId] !== undefined) {
          var selectedRow = byId[selectedId];
          var selectedArchived = archivedSet[selectedId] === true;
          var selectedWorkspaceId = membership[selectedId];
          content = h(SessionDetail, {
            key: selectedId,
            remote: remote,
            sessionId: selectedId,
            session: selectedRow,
            archived: selectedArchived,
            createdAt: typeof createdTimes[selectedId] === 'number' ? createdTimes[selectedId] : 0,
            workspaceTitle: selectedWorkspaceId !== undefined ? workspaceTitle(workspaceById[selectedWorkspaceId]) : tr('scope.ungrouped'),
            onBack: function () {
              setSelectedId(null);
            },
            onOpen: function () {
              openSession(selectedId);
            },
            onArchive: function () {
              archiveSession(selectedId, archivedSet[selectedId] === true);
            },
            onCopyId: function () {
              copySessionId(selectedId);
            },
            pinned: pinnedSet[selectedId] === true,
            onTogglePin: function () {
              togglePin(selectedId);
            },
          });
        } else {
          content = h(
            'div',
            { className: 'dsm-twoPane' },
            aside,
            h(
              'div',
              { className: 'dsm-right' },
              rightHead,
              batchBar,
              h('div', { className: 'dsm-scroll', ref: listScrollRef }, listBody),
            ),
          );
        }

        var dialog = null;
        if (confirmArchive !== null) {
          var targetRow = byId[confirmArchive];
          dialog = h(
            'div',
            { className: 'dsm-overlay', role: 'presentation' },
            h(
              'div',
              { className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsm-archive-title' },
              h('h3', { className: 'dsm-dialogTitle', id: 'dsm-archive-title' }, tr('archive.confirmTitle')),
              h('p', { className: 'dsm-dialogText' }, tr('archive.confirmBody')),
              targetRow ? h('p', { className: 'dsm-dialogText' }, sessionTitle(targetRow)) : null,
              h(
                'div',
                { className: 'dsm-dialogActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn',
                    onClick: function () {
                      setConfirmArchive(null);
                    },
                  },
                  tr('archive.cancel'),
                ),
                h('button', { type: 'button', className: 'dsm-btn dsm-dialogPrimary', onClick: stopAndArchive }, tr('archive.stopAndArchive')),
              ),
            ),
          );
        }

        var batchDialog = null;
        if (Array.isArray(batchConfirm) && batchConfirm.length > 0) {
          batchDialog = h(
            'div',
            { className: 'dsm-overlay', role: 'presentation' },
            h(
              'div',
              { className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsm-batch-title' },
              h('h3', { className: 'dsm-dialogTitle', id: 'dsm-batch-title' }, tr('batch.confirmTitle')),
              h('p', { className: 'dsm-dialogText' }, tr('batch.confirmBody', { n: batchConfirm.length })),
              h(
                'div',
                { className: 'dsm-dialogActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn',
                    onClick: function () {
                      setBatchConfirm(null);
                    },
                  },
                  tr('archive.cancel'),
                ),
                h('button', { type: 'button', className: 'dsm-btn dsm-dialogPrimary', onClick: stopAndBatchArchive }, tr('archive.stopAndArchive')),
              ),
            ),
          );
        }

        var renameDialog = null;
        if (renameTarget !== null) {
          var renameRow = byId[renameTarget.sessionId];
          renameDialog = h(
            'div',
            { className: 'dsm-overlay', role: 'presentation' },
            h(
              'div',
              { className: 'dsm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsm-rename-title' },
              h('h3', { className: 'dsm-dialogTitle', id: 'dsm-rename-title' }, tr('rename.title')),
              renameRow ? h('p', { className: 'dsm-dialogText' }, sessionTitle(renameRow)) : null,
              h('input', {
                ref: renameInputRef,
                className: 'dsm-renameInput',
                type: 'text',
                value: renameDraft,
                maxLength: 200,
                'aria-label': tr('rename.field'),
                disabled: renaming,
                onChange: function (event) {
                  setRenameDraft(event.target.value);
                  setRenameError(null);
                },
                onCompositionStart: function () {
                  renameComposing.current = true;
                },
                onCompositionEnd: function () {
                  renameComposing.current = false;
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter' && !renameComposing.current) {
                    event.preventDefault();
                    confirmRename();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelRename();
                  }
                },
              }),
              renameError !== null ? h('p', { className: 'dsm-dialogError', role: 'alert' }, renameError) : null,
              h(
                'div',
                { className: 'dsm-dialogActions' },
                h('button', { type: 'button', className: 'dsm-btn', disabled: renaming, onClick: cancelRename }, tr('rename.cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-btn dsm-dialogPrimary',
                    disabled: renaming || renameDraft.trim() === '',
                    onClick: confirmRename,
                  },
                  renaming ? tr('rename.saving') : tr('rename.confirm'),
                ),
              ),
            ),
          );
        }

        var menu = null;
        if (rowMenu !== null && byId[rowMenu.id] !== undefined) {
          var menuRow = byId[rowMenu.id];
          var menuTitle = sessionTitle(menuRow);
          menu = h(
            'div',
            { className: 'dsm-rowMenu', role: 'menu', 'aria-label': menuTitle, style: { top: rowMenu.top + 'px', left: rowMenu.left + 'px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-menuItem',
                role: 'menuitem',
                onClick: function () {
                  var sessionId = rowMenu.id;
                  setRowMenu(null);
                  togglePin(sessionId);
                },
              },
              pinnedSet[rowMenu.id] === true ? tr('action.unpin') : tr('action.pin'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-menuItem',
                role: 'menuitem',
                onClick: function () {
                  var sessionId = rowMenu.id;
                  setRowMenu(null);
                  copySessionId(sessionId);
                },
              },
              tr('action.copyId'),
            ),
          );
        }

        return h(
          'div',
          { className: pageClass, ref: pageRef },
          content,
          menu,
          dialog,
          batchDialog,
          renameDialog,
          toast ? h('div', { className: 'dsm-toast', 'data-tone': toast.tone, role: 'status' }, toast.text) : null,
        );
      }

      /* ------------------------------------------------------------------ */
      /* styles                                                              */
      /* ------------------------------------------------------------------ */

      var CSS = [
        '.dsm-page{position:relative;display:flex;width:100%;min-width:0;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}',
        '.dsm-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
        '.dsm-twoPane{display:flex;flex:1;min-width:0;min-height:0}',
        '.dsm-left{display:flex;flex:0 0 236px;flex-direction:column;min-width:0;min-height:0;border-right:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1)}',
        '.dsm-leftHead{flex:none;padding:22px 16px 8px}',
        '.dsm-leftTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}',
        '.dsm-leftCaption{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
        '.dsm-nav{display:flex;flex:1;flex-direction:column;gap:2px;min-height:0;padding:6px 8px 16px;overflow:auto;scrollbar-gutter:stable}',
        '.dsm-navItem{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:7px 10px;border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
        '.dsm-navItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-navItem[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dsm-navIcon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary)}',
        '.dsm-navItem[data-active=true] .dsm-navIcon{color:var(--dsw-alias-label-secondary)}',
        '.dsm-navLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-navCount{flex:none;color:var(--dsw-alias-label-caption);font-size:12px;font-variant-numeric:tabular-nums}',
        '.dsm-right{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}',
        '.dsm-rightHead{display:flex;flex:none;flex-direction:column;gap:14px;padding:22px clamp(20px,3vw,36px) 0}',
        '.dsm-scopeRow{display:flex;align-items:baseline;gap:10px;min-width:0}',
        '.dsm-scopeTitle{min-width:0;margin:0;font-size:20px;font-weight:500;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-scopeCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}',
        '.dsm-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding-bottom:2px}',
        '.dsm-tabs{display:flex;flex:none;gap:2px}',
        '.dsm-tab{height:28px;padding:0 10px;border:0;border-radius:14px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer}',
        '.dsm-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-tab[data-active=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dsm-search{display:flex;flex:1;align-items:center;gap:6px;min-width:170px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;color:var(--dsw-alias-label-tertiary)}',
        '.dsm-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}',
        '.dsm-searchIcon{flex:none;width:14px;height:14px}',
        '.dsm-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
        '.dsm-search input::placeholder{color:var(--dsw-alias-label-caption)}',
        '.dsm-search input::-webkit-search-cancel-button{display:none}',
        '.dsm-scroll{flex:1;min-height:0;padding:8px clamp(20px,3vw,36px) 40px;overflow:auto;scrollbar-gutter:stable}',
        '.dsm-group{margin-top:16px}',
        '.dsm-groupHead{display:flex;align-items:center;gap:8px;margin:0 0 6px;padding:0 8px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500;letter-spacing:.02em}',
        '.dsm-groupTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-groupCount{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
        '.dsm-rows{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}',
        '.dsm-row{position:relative;display:flex;align-items:center;border-radius:10px}',
        '.dsm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-rowMain{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0;padding:8px 10px;border:0;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.dsm-rowTitleWrap{display:flex;align-items:center;gap:6px;min-width:0}',
        '.dsm-rowPin{flex:none;width:13px;height:13px;color:var(--dsw-alias-label-tertiary)}',
        '.dsm-rowTitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;line-height:22px}',
        '.dsm-rowArchived .dsm-rowTitle{color:var(--dsw-alias-label-tertiary)}',
        '.dsm-rowTag{flex:none;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}',
        '.dsm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary)}',
        '.dsm-rowMeta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden}',
        '.dsm-rowMeta>span+span:before{content:"·";margin-right:6px;color:var(--dsw-alias-label-caption)}',
        '.dsm-metaMuted{color:var(--dsw-alias-label-caption)}',
        '.dsm-rowActions{display:flex;flex:none;align-items:center;gap:2px;padding-right:6px}',
        '.dsm-iconBtn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
        '.dsm-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
        '.dsm-iconBtn:disabled{opacity:.4;cursor:not-allowed}',
        '.dsm-rowMenu{position:absolute;z-index:30;display:flex;flex-direction:column;min-width:150px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 8px 24px rgba(0,0,0,.18)}',
        '.dsm-menuItem{padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
        '.dsm-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-check{flex:none;width:16px;height:16px;margin:0 2px 0 8px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
        '.dsm-rowItem[data-selected=true] .dsm-row{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-batchBar{display:flex;flex:none;flex-wrap:wrap;align-items:center;gap:8px;padding:10px clamp(20px,3vw,36px) 2px}',
        '.dsm-batchCount{margin-right:2px;color:var(--dsw-alias-label-tertiary);font-size:13px;font-variant-numeric:tabular-nums}',
        '.dsm-selectBtn[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}',
        '.dsm-detail{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0}',
        '.dsm-detailHead{display:flex;flex:none;flex-direction:column;gap:8px;padding:20px clamp(20px,4vw,40px) 14px;border-bottom:.5px solid var(--dsw-alias-border-l4)}',
        '.dsm-detailTop{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dsm-back{margin-left:-6px}',
        '.dsm-detailTitle{flex:1;min-width:0;margin:0;font-size:20px;font-weight:500;line-height:28px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-detailActions{display:flex;flex:none;align-items:center;gap:6px}',
        '.dsm-btn{display:inline-flex;flex:none;align-items:center;gap:5px;height:30px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:15px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
        '.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsm-btn:disabled{opacity:.45;cursor:not-allowed}',
        '.dsm-btnIcon{width:14px;height:14px}',
        '.dsm-detailMeta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
        '.dsm-detailMeta>span+span:before{content:"·";margin-right:8px;color:var(--dsw-alias-label-caption)}',
        '.dsm-detailScroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}',
        '.dsm-chat{display:flex;flex-direction:column;gap:16px;max-width:860px;margin:0 auto;padding:18px clamp(20px,4vw,40px) 48px}',
        '.dsm-moreWrap{display:flex;justify-content:center}',
        '.dsm-endNote{margin:0;text-align:center;color:var(--dsw-alias-label-caption);font-size:12px}',
        '.dsm-msg{display:flex;flex-direction:column;gap:5px}',
        '.dsm-msgRole{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;letter-spacing:.02em;text-transform:uppercase}',
        '.dsm-userText{white-space:pre-wrap;overflow-wrap:anywhere;border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px}',
        '.dsm-assistantText{overflow-wrap:anywhere}',
        '.dsm-plain{white-space:pre-wrap;overflow-wrap:anywhere}',
        '.dsm-tool{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-base)}',
        '.dsm-toolSummary{display:flex;align-items:center;gap:8px;padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;cursor:pointer;list-style:none}',
        '.dsm-toolSummary::-webkit-details-marker{display:none}',
        '.dsm-toolName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:500;font-family:var(--dsw-font-mono,ui-monospace,monospace)}',
        '.dsm-toolState{flex:none;color:var(--dsw-alias-label-tertiary)}',
        '.dsm-toolState[data-failed=true]{color:var(--dsw-alias-state-error-primary)}',
        '.dsm-toolBlock{max-height:280px;margin:0 10px 10px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}',
        '.dsm-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:56px 20px;color:var(--dsw-alias-label-tertiary);text-align:center}',
        '.dsm-emptyTitle{color:var(--dsw-alias-label-secondary);font-size:14px;font-weight:500}',
        '.dsm-emptyHint{color:var(--dsw-alias-label-caption);font-size:12px}',
        '.dsm-loading{display:flex;align-items:center;justify-content:center;gap:8px;padding:40px 20px;color:var(--dsw-alias-label-tertiary);font-size:13px}',
        '.dsm-spin{width:14px;height:14px;animation:dsm-spin 1s linear infinite}',
        '@keyframes dsm-spin{to{transform:rotate(360deg)}}',
        '.dsm-error{display:flex;align-items:flex-start;gap:10px;margin:24px 0;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-size:13px}',
        '.dsm-errorText{flex:1;min-width:0;overflow-wrap:anywhere}',
        '.dsm-overlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32)}',
        '.dsm-dialog{display:flex;flex-direction:column;gap:12px;width:min(420px,100%);padding:20px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:0 18px 48px rgba(0,0,0,.28)}',
        '.dsm-dialogTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}',
        '.dsm-dialogText{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}',
        '.dsm-dialogActions{display:flex;justify-content:flex-end;gap:8px}',
        '.dsm-dialogPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}',
        '.dsm-dialogPrimary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary);opacity:.9}',
        '.dsm-renameInput{box-sizing:border-box;width:100%;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;outline:none}',
        '.dsm-renameInput:focus{border-color:var(--dsw-alias-state-business-primary)}',
        '.dsm-renameInput:disabled{opacity:.55;cursor:not-allowed}',
        '.dsm-dialogError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dsm-toast{position:absolute;bottom:28px;left:50%;z-index:50;max-width:min(560px,calc(100% - 48px));padding:8px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 10px 30px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow-wrap:anywhere;transform:translateX(-50%)}',
        '.dsm-toast[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
        '[data-platform=darwin] .dsm-leftHead{padding-top:calc(22px + var(--dsh-frame-top-clearance,0px))}',
        '[data-platform=darwin] .dsm-rightHead{padding-top:calc(22px + var(--dsh-frame-top-clearance,0px))}',
        '[data-platform=darwin] .dsm-detailHead{padding-top:calc(20px + var(--dsh-frame-top-clearance,0px))}',
        '.dsm-hidden{display:none!important}',
        '.dsm-pageTabs{display:flex;flex:none;gap:2px;margin:6px 12px 8px;padding:3px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
        '.dsm-pageTab{flex:1;min-width:0;padding:5px 10px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:18px;cursor:pointer}',
        '.dsm-pageTab:hover{color:var(--dsw-alias-label-primary)}',
        '.dsm-pageTab[data-active=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}',
        '.dsm-settingsPage{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;width:100%}',
        '.dsm-settingsHead{display:flex;flex:none;align-items:center;gap:14px;padding:18px clamp(20px,4vw,40px) 12px;border-bottom:.5px solid var(--dsw-alias-border-l4)}',
        '.dsm-settingsTitleWrap{display:flex;flex-direction:column;min-width:0;gap:2px}',
        '.dsm-settingsTitle{margin:0;font-size:18px;font-weight:500;line-height:26px}',
        '.dsm-settingsCaption{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-settingsScroll{flex:1;min-height:0;overflow:auto;padding:20px clamp(20px,4vw,40px) 36px}',
        '.dsm-settingsCard{display:flex;flex-direction:column;gap:18px;max-width:760px;margin:0 auto}',
        '.dsm-switchRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}',
        '.dsm-switchText{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.dsm-switch{flex:none;width:18px;height:18px;margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
        '.dsm-field{display:flex;flex-direction:column;gap:6px;min-width:0}',
        '.dsm-fieldLabel{font-size:13px;font-weight:500;line-height:20px}',
        '.dsm-fieldHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dsm-fieldFoot{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
        '.dsm-counter{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
        '.dsm-input,.dsm-select,.dsm-textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;outline:none}',
        '.dsm-input:focus,.dsm-select:focus,.dsm-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
        '.dsm-textarea{resize:vertical;min-height:180px;line-height:22px}',
        '.dsm-occupation{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dsm-occupation .dsm-select{flex:0 0 168px}',
        '.dsm-occupation .dsm-input{flex:1;min-width:0}',
        '.dsm-settingsNote{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dsm-formError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dsm-formActions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}',
        '.dsm-btnPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}',
        '.dsm-btnPrimary:hover:not(:disabled){opacity:.9}',
        '.dsm-btnDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}',
        '.dsm-btnDanger:hover:not(:disabled){opacity:.9}',
        '.dsm-clearConfirm{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px}',
        '.dsm-clearConfirmActions{display:flex;flex:none;gap:8px}',
        '.dsm-navTags{display:flex;flex:none;gap:3px}',
        '.dsm-navTag{padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;white-space:nowrap}',
        '.dsm-settingsState{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;justify-content:center}',
        '.dsm-overrideRow{border-color:var(--dsw-alias-state-business-primary)}',
        '[data-platform=darwin] .dsm-settingsHead{padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}',
        '.dsm-featureOff{display:flex;flex:1;flex-direction:column;justify-content:center;align-items:center;gap:6px;padding:40px;text-align:center}',
        '.dsm-configForm{display:flex;flex-direction:column;gap:12px;padding:4px 0;max-width:560px}',
        '.dsm-configHead{display:flex;flex-direction:column;gap:2px}',
        '.dsm-configTitle{margin:0;font-size:13px;font-weight:500;line-height:20px}',
        '.dsm-configHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
        '.dsm-configRow{display:flex;align-items:flex-start;gap:10px;padding:9px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}',
        '.dsm-configText{display:flex;flex-direction:column;gap:1px;min-width:0}',
        '.dsm-configNote{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.dsm-configSaved{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
        '.dsm-configActions{display:flex;justify-content:flex-end;gap:8px}',
        '.dsm-configSummary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.dsm-moreItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
        '.dsm-moreItem:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.dsm-moreLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '@media (width<=760px){.dsm-left{flex-basis:190px;padding-right:4px}.dsm-detailActions{flex-wrap:wrap}.dsm-occupation{flex-wrap:wrap}.dsm-occupation .dsm-select{flex:1 1 100%}.dsm-navTags{display:none}}',
      ].join('');

      function injectStyles() {
        try {
          if (document.querySelector('style[data-dsh-session-manager-style]')) return function () {};
          var style = document.createElement('style');
          style.setAttribute('data-dsh-session-manager-style', '1');
          style.textContent = CSS;
          document.head.appendChild(style);
          return function () {
            try {
              style.remove();
            } catch (error) {
              /* already removed */
            }
          };
        } catch (error) {
          return function () {};
        }
      }

      /* ------------------------------------------------------------------ */
      /* merged dsh-workspace-focus (ported from v1.0.5, gated by features)  */
      /* ------------------------------------------------------------------ */

      var createWorkspaceFocus = function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    // ---------------------------------------------------------------- 常量
    const PLUGIN_ID = "dsh-workspace-focus";
    const NS = "dsh-workspace-focus";
    const PREFS_KEY = "dsh-workspace-focus.prefs.v1";
    const VIEW_STORE_KEY = "dsh.workspace.view.v5";
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 10;
    const DEFAULT_PREFS = { recentOnly: false, limit: 5, hideActive: false, keepWorkspaces: [], keepUngrouped: true };
    const OUTLET_SELECTOR = '[data-slot="sidebar.workspaces"]';
    const HEADER_SELECTOR = '[data-row-key^="workspace:"][role="treeitem"]';
    const GROUP_SECTION_SELECTOR = '[class*="_groupSection"]';
    const HEADER_ACTIONS_SUFFIX = "_headerActions";
    const RAIL_SUFFIX = "_rail";
    const FILTER_STYLE_ID = PLUGIN_ID + "-filter";

    // -------------------------------------------------------------- 字典
    const zh = {
      "settings.title": "只显示最近工作区",
      "settings.description": "开启后自动只保留最近使用的若干个工作区；数量在右侧调节。与标题栏的「隐藏工作区」按钮独立生效；两者同时开启时，只显示两边都保留的工作区。",
      "settings.toggle": "只显示最近工作区",
      "settings.increase": "增加一个工作区",
      "settings.decrease": "减少一个工作区",
      "settings.unit": "个",
      "header.open": "隐藏工作区（选择需要保留的工作区）",
      "header.active": "隐藏模式已开启，点击调整",
      "header.disabledFlat": "「单列表」分组下不可用，请切换到按工作区分组",
      "panel.title": "隐藏时保留的工作区",
      "panel.description": "勾选需要保留的工作区，其余工作区将从侧边栏隐藏。当前会话所在工作区会自动保留。",
      "panel.hintEmpty": "未勾选任何工作区：应用后将隐藏全部工作区（当前会话所在工作区除外）。",
      "panel.selectAll": "全选",
      "panel.selectNone": "清空",
      "panel.ungrouped": "未分组会话",
      "panel.ungroupedDesc": "不属于任何工作区的会话",
      "panel.current": "当前",
      "panel.apply": "隐藏其他工作区",
      "panel.showAll": "全部显示",
      "panel.close": "关闭",
      "panel.count": "已选 {selected} / {total}",
      "header.recentOpen": "最近使用的工作区（显示 {limit} 个）",
      "header.recentActive": "最近使用模式已开启，点击调整",
      "recentPanel.title": "最近使用的工作区",
            "recentPanel.toggle": "只显示最近工作区",
      "recentPanel.toggleDesc": "按最近使用时间过滤侧边栏；当前会话所在工作区始终显示。",
      "recentPanel.countLabel": "显示数量",
      "recentPanel.countDesc": "1–10 个，数字越小越紧凑",
      "recentPanel.unit": "个",
      "recentPanel.tipOff": "开启后，侧边栏只保留最近使用的 {limit} 个工作区。",
      "recentPanel.hint": "与眼睛按钮的隐藏模式相互独立；两者同时开启时，只显示两边都保留的工作区。",
    };
    const en = {
      "settings.title": "Recent workspaces only",
      "settings.description": "Automatically keep only the most recently used workspaces; set how many on the right. Independent of the header hide button — when both are on, only workspaces kept by both filters stay visible.",
      "settings.toggle": "Recent workspaces only",
      "settings.increase": "Show one more workspace",
      "settings.decrease": "Show one fewer workspace",
      "settings.unit": "",
      "header.open": "Hide workspaces (choose the ones to keep)",
      "header.active": "Hide mode is on — click to adjust",
      "header.disabledFlat": "Unavailable in the single-list grouping; switch to a workspace grouping",
      "panel.title": "Keep while hiding",
      "panel.description": "Check the workspaces to keep; all other workspaces are hidden from the sidebar. The workspace of the current session is always kept.",
      "panel.hintEmpty": "No workspace selected: applying hides every workspace except the current session's workspace.",
      "panel.selectAll": "Select all",
      "panel.selectNone": "Clear",
      "panel.ungrouped": "Ungrouped sessions",
      "panel.ungroupedDesc": "Sessions that do not belong to any workspace",
      "panel.current": "Current",
      "panel.apply": "Hide other workspaces",
      "panel.showAll": "Show all",
      "panel.close": "Close",
      "panel.count": "{selected} / {total} selected",
      "header.recentOpen": "Recent workspaces ({limit} shown)",
      "header.recentActive": "Recent-only mode is on — click to adjust",
      "recentPanel.title": "Recent workspaces",
            "recentPanel.toggle": "Recent workspaces only",
      "recentPanel.toggleDesc": "Filter the sidebar by last-used time; the current session's workspace always stays visible.",
      "recentPanel.countLabel": "How many",
      "recentPanel.countDesc": "1–10; lower is more compact",
      "recentPanel.unit": "",
      "recentPanel.tipOff": "When on, the sidebar keeps only the {limit} most recently used workspaces.",
      "recentPanel.hint": "Independent of the eye button's hide mode; when both are on, only workspaces kept by both filters stay visible.",
    };

    // ---------------------------------------------------------------- 图标
    const EYE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.7 8s2.4-4.3 6.3-4.3S14.3 8 14.3 8 11.9 12.3 8 12.3 1.7 8 1.7 8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.05" stroke="currentColor" stroke-width="1.3"/></svg>';
    const EYE_OFF_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.35 3.85A7.2 7.2 0 0 1 8 3.7c3.9 0 6.3 4.3 6.3 4.3a11.6 11.6 0 0 1-2.45 2.95" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.75 12.15A7.2 7.2 0 0 1 8 12.3C4.1 12.3 1.7 8 1.7 8a11.6 11.6 0 0 1 2.45-2.95" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.6 2.6 13.4 13.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    const RECENT_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.55" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.9V8l2.1 1.35" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function closeIcon() {
      return React.createElement(
        "svg",
        { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", focusable: "false" },
        React.createElement("path", {
          d: "M3.6 3.6 12.4 12.4",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        }),
        React.createElement("path", {
          d: "M12.4 3.6 3.6 12.4",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
        }),
      );
    }

    // ---------------------------------------------------------------- 样式
    const COMPONENT_CSS = `
      .wsf-header-button {
        box-sizing: border-box;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        margin: 0;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .wsf-header-button[hidden] { display: none !important; }
      .wsf-header-button:hover:not(:disabled) { background-color: var(--dsw-alias-interactive-bg-hover); }
      .wsf-header-button:disabled { cursor: default; opacity: 0.45; }
      .wsf-header-button:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .wsf-header-button[data-active="true"] { color: var(--dsw-alias-brand-primary); }
      .wsf-header-button svg { display: block; }

      [data-wsf-container="1"] > [data-row-key^="session:"] { display: none !important; }
      [data-wsf-container="1"] > [data-row-key^="overflow:"] { display: none !important; }

      .wsf-panel {
        box-sizing: border-box;
        position: fixed;
        z-index: 30;
        display: flex;
        flex-direction: column;
        width: 300px;
        max-height: min(60vh, 460px);
        padding: 6px;
        border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
        box-shadow: var(--dsw-shadow-lv3);
        color: var(--dsw-alias-label-primary);
        pointer-events: auto;
      }
      .wsf-panel-head {
        position: relative;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 38px 4px 10px;
      }
      .wsf-panel-headText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .wsf-panel-title { font-size: 13px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-primary); }
      .wsf-panel-desc { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
      .wsf-panel-head--compact { min-height: 4px; padding: 0 30px 0 10px; }
      .wsf-panel-head--compact .wsf-panel-close {
        top: -4px;
        right: -2px;
        width: 20px;
        height: 20px;
      }
      .wsf-icon-button {
        box-sizing: border-box;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-tertiary);
        cursor: pointer;
        font-size: 15px;
        line-height: 1;
      }
      .wsf-icon-button:hover { background-color: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .wsf-icon-button:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .wsf-panel-close {
        position: absolute;
        top: -4px;
        right: 0;
        width: 28px;
        height: 28px;
      }
      .wsf-panel-tools {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 2px 10px 6px;
      }
      .wsf-panel-count { font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
      .wsf-link-button {
        padding: 0;
        border: none;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font-size: 12px;
        line-height: 17px;
        cursor: pointer;
      }
      .wsf-link-button:hover { color: var(--dsw-alias-label-primary); }
      .wsf-link-button:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
        border-radius: var(--dsw-radius-xs);
      }
      .wsf-hint {
        margin: 0 10px 6px;
        padding: 6px 8px;
        border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-module-platform);
        font-size: 12px;
        line-height: 17px;
        color: var(--dsw-alias-label-secondary);
      }
      .wsf-list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 2px 0;
      }
      .wsf-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: var(--dsw-radius-sm);
        cursor: pointer;
      }
      .wsf-item:hover { background-color: var(--dsw-alias-interactive-bg-hover); }
      .wsf-item input[type="checkbox"] {
        flex: none;
        width: 14px;
        height: 14px;
        margin: 0;
        accent-color: var(--dsw-alias-brand-primary);
        cursor: pointer;
      }
      .wsf-itemText { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 1px; }
      .wsf-itemTitle {
        font-size: 13px;
        line-height: 18px;
        color: var(--dsw-alias-label-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wsf-itemPath {
        font-size: 11px;
        line-height: 15px;
        color: var(--dsw-alias-label-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wsf-badge {
        flex: none;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
        font-size: 11px;
        line-height: 16px;
      }
      .wsf-panel-footer {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;
        padding: 8px 8px 4px;
        border-top: 0.5px solid var(--dsw-alias-border-l2);
      }
      .wsf-btn {
        box-sizing: border-box;
        height: 30px;
        padding: 0 12px;
        border: 0.5px solid transparent;
        border-radius: var(--dsw-radius-sm);
        font-size: 13px;
        line-height: 18px;
        cursor: pointer;
      }
      .wsf-btn:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      .wsf-btn-primary {
        background: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .wsf-btn-primary:hover { filter: brightness(1.06); }
      .wsf-btn-ghost {
        background: transparent;
        border-color: var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary);
      }
      .wsf-btn-ghost:hover { background-color: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

      .wsf-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 0;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2);
      }
      .wsf-rowText {
        display: flex;
        flex-direction: column;
        flex: 1;
        gap: 4px;
        min-width: 0;
        padding-right: 48px;
      }
      .wsf-title {
        color: var(--dsw-alias-label-primary);
        font-size: 14px;
        font-weight: 400;
        line-height: 22px;
      }
      .wsf-desc {
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
        font-weight: 400;
        line-height: 18px;
      }
      .wsf-control {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .wsf-switch {
        box-sizing: border-box;
        position: relative;
        flex: 0 0 auto;
        width: 36px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: var(--dsw-alias-border-l3);
        cursor: pointer;
        transition: background-color 0.12s ease;
      }
      .wsf-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .wsf-switch:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      .wsf-thumb {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--dsw-alias-label-primary-foreground);
        transition: transform 0.12s ease;
      }
      .wsf-switch[aria-checked="false"] .wsf-thumb { background: var(--dsw-alias-switch-thumb); }
      .wsf-switch[aria-checked="true"] .wsf-thumb { transform: translate(16px); }

      .wsf-stepper {
        box-sizing: border-box;
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 72px;
        height: 36px;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-module-platform);
      }
      .wsf-value {
        min-width: 18px;
        text-align: center;
        color: var(--dsw-alias-label-primary);
        font-size: 14px;
        line-height: 22px;
        font-variant-numeric: tabular-nums;
      }
      .wsf-arrows {
        position: absolute;
        right: 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        opacity: 0;
      }
      .wsf-stepper:hover .wsf-arrows,
      .wsf-stepper:focus-within .wsf-arrows { opacity: 1; }
      @media (hover: none) { .wsf-arrows { opacity: 1; } }
      .wsf-arrow {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 17px;
        height: 12px;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-xs);
        background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .wsf-arrow:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1); }
      .wsf-arrow:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
      .wsf-arrow svg { display: block; }
      .wsf-unit { color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 22px; }

      .wsf-panel--recent { max-height: none; }
      .wsf-popover-section {
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 10px;
        border-radius: var(--dsw-radius-sm);
      }
      .wsf-popover-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .wsf-popover-labelTitle { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); }
      .wsf-popover-labelDesc { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
      .wsf-step {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        height: 30px;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-module-platform);
      }
      .wsf-step-btn {
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: none;
        border-radius: var(--dsw-radius-sm);
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
      }
      .wsf-step-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .wsf-step-btn:disabled { color: var(--dsw-alias-label-caption); cursor: default; }
      .wsf-step-btn:focus-visible {
        outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .wsf-step-value {
        min-width: 22px;
        text-align: center;
        font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 18px;
      }
    `;

    // -------------------------------------------------------------- 帧调度
    const scheduleFrame = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback) => setTimeout(callback, 16);
    const cancelFrame = typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window)
      : clearTimeout;

    // ---------------------------------------------------------------- 偏好
    function clampLimit(value) {
      const parsed = Math.round(Number(value));
      if (!Number.isFinite(parsed)) return DEFAULT_PREFS.limit;
      return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
    }

    function sanitizeKeepList(value) {
      if (!Array.isArray(value)) return [];
      const seen = new Set();
      const result = [];
      for (const entry of value) {
        if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) continue;
        seen.add(entry);
        result.push(entry);
      }
      return result;
    }

    function loadPrefs() {
      const fallback = {
        recentOnly: DEFAULT_PREFS.recentOnly,
        limit: DEFAULT_PREFS.limit,
        hideActive: DEFAULT_PREFS.hideActive,
        keepWorkspaces: DEFAULT_PREFS.keepWorkspaces.slice(),
        keepUngrouped: DEFAULT_PREFS.keepUngrouped,
      };
      try {
        const raw = window.localStorage.getItem(PREFS_KEY);
        if (raw === null) return fallback;
        const stored = JSON.parse(raw);
        if (stored === null || typeof stored !== "object") return fallback;
        return {
          recentOnly: stored.recentOnly === true,
          limit: clampLimit(stored.limit),
          hideActive: stored.hideActive === true,
          keepWorkspaces: sanitizeKeepList(stored.keepWorkspaces),
          keepUngrouped: stored.keepUngrouped !== false,
        };
      } catch {
        return fallback;
      }
    }

    let prefs = loadPrefs();
    const prefsListeners = new Set();

    function samePrefs(left, right) {
      if (left.recentOnly !== right.recentOnly) return false;
      if (left.limit !== right.limit) return false;
      if (left.hideActive !== right.hideActive) return false;
      if (left.keepUngrouped !== right.keepUngrouped) return false;
      if (left.keepWorkspaces.length !== right.keepWorkspaces.length) return false;
      for (let index = 0; index < left.keepWorkspaces.length; index += 1) {
        if (left.keepWorkspaces[index] !== right.keepWorkspaces[index]) return false;
      }
      return true;
    }

    function persistPrefs() {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* 存储不可用时保持内存态 */
      }
    }

    function setPrefs(patch) {
      const next = {
        recentOnly: patch.recentOnly === undefined ? prefs.recentOnly : patch.recentOnly === true,
        limit: patch.limit === undefined ? prefs.limit : clampLimit(patch.limit),
        hideActive: patch.hideActive === undefined ? prefs.hideActive : patch.hideActive === true,
        keepWorkspaces: patch.keepWorkspaces === undefined ? prefs.keepWorkspaces : sanitizeKeepList(patch.keepWorkspaces),
        keepUngrouped: patch.keepUngrouped === undefined ? prefs.keepUngrouped : patch.keepUngrouped !== false,
      };
      if (samePrefs(next, prefs)) return;
      prefs = next;
      persistPrefs();
      for (const listener of Array.from(prefsListeners)) listener();
    }

    function usePrefs() {
      const [, forceRender] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        prefsListeners.add(forceRender);
        return () => {
          prefsListeners.delete(forceRender);
        };
      }, []);
      return prefs;
    }

    // -------------------------------------------------------- 面板开关状态
    let panelState = { open: false, kind: null, rect: null };
    const panelListeners = new Set();

    function setPanelState(next) {
      panelState = next;
      for (const listener of Array.from(panelListeners)) listener();
    }

    function openPanel(rect, kind) {
      setPanelState({ open: true, kind: kind === "recent" ? "recent" : "hide", rect });
    }

    function closePanel() {
      if (!panelState.open) return;
      setPanelState({ open: false, kind: null, rect: null });
    }

    function usePanelState() {
      const [, forceRender] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        panelListeners.add(forceRender);
        return () => {
          panelListeners.delete(forceRender);
        };
      }, []);
      return panelState;
    }

    // -------------------------------------------------------------- 样式标签
    let filterStyleTag = null;
    let panelElement = null;

    function findStyleTag(id) {
      if (typeof document === "undefined") return null;
      return document.querySelector('style[data-plugin-css="' + id + '"]');
    }

    function ensureComponentStyle() {
      const existing = findStyleTag(PLUGIN_ID);
      if (existing !== null) return existing;
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = PLUGIN_ID;
      tag.textContent = COMPONENT_CSS;
      document.head.appendChild(tag);
      return tag;
    }

    function ensureFilterStyle() {
      if (typeof document === "undefined") return null;
      if (filterStyleTag !== null && filterStyleTag.isConnected) return filterStyleTag;
      const existing = findStyleTag(FILTER_STYLE_ID);
      if (existing !== null) {
        filterStyleTag = existing;
        return existing;
      }
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = FILTER_STYLE_ID;
      document.head.appendChild(tag);
      filterStyleTag = tag;
      return tag;
    }

    // ------------------------------------------------------------ DOM 工具
    function browserOutlet() {
      if (typeof document === "undefined") return null;
      return document.querySelector(OUTLET_SELECTOR);
    }

    function classOf(element) {
      if (element === null || element === undefined) return "";
      return typeof element.className === "string" ? element.className : "";
    }

    // 兼容跨 realm 传入的 Set（测试沙箱/宿主快照都可能是别的 Realm 的 Set 实例）。
    function toIdSet(value) {
      if (value !== null && value !== undefined && typeof value === "object" && typeof value.has === "function") return value;
      return new Set(Array.isArray(value) ? value : []);
    }

    function escapeAttributeValue(value) {
      const text = String(value);
      if (typeof CSS !== "undefined" && CSS !== null && typeof CSS.escape === "function") {
        try {
          return CSS.escape(text);
        } catch {
          /* 回退到手写转义 */
        }
      }
      // 覆盖引号、反斜杠、换行与其它控制字符，避免拼出非法选择器。
      return text.replace(/["\\\n\r\f]/g, (character) => "\\" + character.charCodeAt(0).toString(16) + " ");
    }

    function rowKeySelector(rowKey) {
      return '[data-row-key="' + escapeAttributeValue(rowKey) + '"]';
    }

    let hasSelectorSupport = null;
    function supportsHasSelector() {
      if (hasSelectorSupport !== null) return hasSelectorSupport;
      try {
        hasSelectorSupport = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("selector(:has(*))");
      } catch {
        hasSelectorSupport = false;
      }
      return hasSelectorSupport;
    }

    function readViewMode() {
      try {
        const raw = window.localStorage.getItem(VIEW_STORE_KEY);
        if (typeof raw === "string" && raw.length > 0) {
          const stored = JSON.parse(raw);
          const groupBy = stored === null || typeof stored !== "object" ? null : stored.groupBy;
          if (groupBy === "workspace" || groupBy === "workspace-tree" || groupBy === "flat") return groupBy;
        }
      } catch {
        /* 存储不可用时退回 DOM 探测 */
      }
      const outlet = browserOutlet();
      if (outlet === null) return null;
      const headers = outlet.querySelectorAll(HEADER_SELECTOR);
      if (headers.length === 0) {
        return outlet.querySelector('[data-row-key^="session:"]') === null ? null : "flat";
      }
      return outlet.querySelector('div[role="group"] [data-row-key^="workspace:"]') === null ? "workspace" : "workspace-tree";
    }

    function ownHeaderOfSection(section) {
      for (const child of section.children) {
        const rowKey = child.getAttribute("data-row-key");
        if (typeof rowKey === "string" && rowKey.startsWith("workspace:")) return child;
      }
      return null;
    }

    function normalizePath(path) {
      return String(path === undefined || path === null ? "" : path).replace(/\\/g, "/").replace(/\/+$/g, "");
    }

    function owningParent(workspace, items) {
      const childPath = normalizePath(workspace.path);
      if (childPath.length === 0) return null;
      let best = null;
      let bestLength = -1;
      for (const other of items) {
        if (other === null || other === undefined) continue;
        if (other.workspaceId === workspace.workspaceId) continue;
        const root = normalizePath(other.path);
        if (root.length === 0 || root === childPath) continue;
        if (childPath.startsWith(root + "/") && root.length > bestLength) {
          best = other;
          bestLength = root.length;
        }
      }
      return best;
    }

    function currentWorkspaceId(items, byId) {
      if (byId === null || byId === undefined || typeof byId !== "object") return null;
      let activeSessionId = null;
      for (const row of Object.values(byId)) {
        if (row === null || row === undefined) continue;
        const retainedBy = row.retainedBy;
        if (retainedBy !== null && typeof retainedBy === "object" && (retainedBy.mainView ?? 0) > 0) {
          activeSessionId = row.id;
          break;
        }
      }
      if (activeSessionId === null) return null;
      for (const workspace of items) {
        if (workspace === null || workspace === undefined) continue;
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(activeSessionId) !== -1) {
          return workspace.workspaceId;
        }
      }
      return null;
    }

    function sessionsWithoutWorkspace(items, byId) {
      const grouped = new Set();
      for (const workspace of items) {
        if (workspace === null || workspace === undefined || !Array.isArray(workspace.sessionIds)) continue;
        for (const sessionId of workspace.sessionIds) grouped.add(sessionId);
      }
      const stray = new Set();
      if (byId === null || byId === undefined || typeof byId !== "object") return stray;
      for (const sessionId of Object.keys(byId)) {
        if (!grouped.has(sessionId)) stray.add(sessionId);
      }
      return stray;
    }

    // ------------------------------------------------------ 最近工作区过滤
    function computeRecentHiddenWorkspaces(items, byId, preferences, archivedSessionIds) {
      const hidden = new Set();
      if (!Array.isArray(items) || byId === null || byId === undefined || typeof byId !== "object") return hidden;
      const archived = toIdSet(archivedSessionIds);
      const ranked = [];
      let order = 0;
      for (const workspace of items) {
        if (workspace === null || workspace === undefined) continue;
        const workspaceId = workspace.workspaceId;
        if (typeof workspaceId !== "string" || workspaceId.length === 0) continue;
        let lastUsed = 0;
        const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
        for (const sessionId of sessionIds) {
          // 归档会话不参与“最近使用”排名：它们在侧边栏里本来就不可见。
          if (archived.has(sessionId)) continue;
          const row = byId[sessionId];
          if (row !== null && row !== undefined && typeof row.updatedAt === "number" && row.updatedAt > lastUsed) {
            lastUsed = row.updatedAt;
          }
        }
        const rawWorkspaceUpdatedAt = workspace.updatedAt;
        const workspaceUpdatedAt = typeof rawWorkspaceUpdatedAt === "number"
          ? rawWorkspaceUpdatedAt
          : typeof rawWorkspaceUpdatedAt === "string" ? Date.parse(rawWorkspaceUpdatedAt) : NaN;
        if (Number.isFinite(workspaceUpdatedAt) && workspaceUpdatedAt > lastUsed) lastUsed = workspaceUpdatedAt;
        ranked.push({ workspaceId, lastUsed, order });
        order += 1;
      }
      if (ranked.length === 0) return hidden;
      ranked.sort((left, right) => (right.lastUsed - left.lastUsed) || (left.order - right.order));
      const keep = new Set();
      const limit = clampLimit(preferences.limit);
      for (let index = 0; index < Math.min(limit, ranked.length); index += 1) keep.add(ranked[index].workspaceId);
      const activeWorkspaceId = currentWorkspaceId(items, byId);
      if (activeWorkspaceId !== null) keep.add(activeWorkspaceId);
      for (const entry of ranked) {
        if (!keep.has(entry.workspaceId)) hidden.add(entry.workspaceId);
      }
      return hidden;
    }

    // -------------------------------------------------------- 隐藏方案计算
    function buildHidePlan(data, mode, outlet) {
      const prefsSnapshot = data.prefs;
      const items = Array.isArray(data.items) ? data.items : [];
      const byId = data.byId === null || data.byId === undefined ? {} : data.byId;
      const archivedSessionIds = toIdSet(data.archivedSessionIds);
      const headerCount = outlet === null ? 0 : outlet.querySelectorAll(HEADER_SELECTOR).length;
      const flat = mode === "flat" || (mode === null && headerCount === 0 && outlet !== null
        && outlet.querySelector('[data-row-key^="session:"]') !== null);
      const manualActive = prefsSnapshot.hideActive === true && !flat;
      const currentId = currentWorkspaceId(items, byId);
      const kept = new Set();
      if (manualActive) {
        for (const workspaceId of prefsSnapshot.keepWorkspaces) kept.add(workspaceId);
        if (currentId !== null) kept.add(currentId);
      }
      const containers = new Set();
      if (manualActive && mode === "workspace-tree") {
        const byIdMap = new Map();
        for (const workspace of items) {
          if (workspace !== null && workspace !== undefined) byIdMap.set(workspace.workspaceId, workspace);
        }
        for (const workspaceId of kept) {
          const start = byIdMap.get(workspaceId);
          if (start === undefined) continue;
          const seen = new Set([workspaceId]);
          let cursor = owningParent(start, items);
          while (cursor !== null && !seen.has(cursor.workspaceId)) {
            seen.add(cursor.workspaceId);
            if (!kept.has(cursor.workspaceId)) containers.add(cursor.workspaceId);
            cursor = owningParent(cursor, items);
          }
        }
      }
      const sectionHidden = new Set();
      if (manualActive) {
        for (const workspace of items) {
          if (workspace === null || workspace === undefined) continue;
          const workspaceId = workspace.workspaceId;
          if (typeof workspaceId !== "string" || workspaceId.length === 0) continue;
          if (!kept.has(workspaceId) && !containers.has(workspaceId)) sectionHidden.add(workspaceId);
        }
      }
      if (prefsSnapshot.recentOnly === true) {
        for (const workspaceId of computeRecentHiddenWorkspaces(items, byId, prefsSnapshot, archivedSessionIds)) {
          if (!containers.has(workspaceId)) sectionHidden.add(workspaceId);
        }
      }
      const ungroupedHidden = manualActive && prefsSnapshot.keepUngrouped !== true;
      const hiddenSessionIds = new Set();
      if (sectionHidden.size > 0) {
        for (const workspace of items) {
          if (workspace === null || workspace === undefined) continue;
          if (!sectionHidden.has(workspace.workspaceId)) continue;
          if (!Array.isArray(workspace.sessionIds)) continue;
          for (const sessionId of workspace.sessionIds) hiddenSessionIds.add(sessionId);
        }
      }
      return { flat, manualActive, currentId, kept, containers, sectionHidden, ungroupedHidden, hiddenSessionIds };
    }

    function applyHidePlan(outlet, plan) {
      if (outlet === null) return;
      const sections = Array.from(outlet.querySelectorAll(GROUP_SECTION_SELECTOR));
      for (const section of sections) {
        if (section === null || section.parentElement === null) continue;
        const header = ownHeaderOfSection(section);
        if (header === null) continue;
        const rowKey = header.getAttribute("data-row-key");
        const key = typeof rowKey === "string" ? rowKey.slice("workspace:".length) : null;
        if (key === null) continue;
        if (plan.containers.has(key)) {
          section.setAttribute("data-wsf-container", "1");
        } else {
          section.removeAttribute("data-wsf-container");
        }
      }
      const sessionRows = outlet.querySelectorAll('[data-row-key^="session:"]');
      for (const row of sessionRows) {
        if (plan.flat) {
          const rowKey = row.getAttribute("data-row-key");
          const sessionId = typeof rowKey === "string" ? rowKey.slice("session:".length) : null;
          if (sessionId !== null && plan.hiddenSessionIds.has(sessionId)) {
            row.setAttribute("data-wsf-hidden", "1");
            row.style.display = "none";
          } else {
            row.removeAttribute("data-wsf-hidden");
            row.style.display = "";
          }
        } else if (row.hasAttribute("data-wsf-hidden")) {
          row.removeAttribute("data-wsf-hidden");
          row.style.display = "";
        }
      }
    }

    function writeStyleRules(plan, outlet, mode) {
      const tag = ensureFilterStyle();
      if (tag === null) return;
      const rules = [];
      const hasNestedTree = outlet !== null && outlet.querySelector('div[role="group"] [data-row-key^="workspace:"]') !== null;
      const canHideSection = supportsHasSelector()
        && (plan.manualActive || !hasNestedTree || mode !== "workspace-tree");
      for (const workspaceId of plan.sectionHidden) {
        if (canHideSection) {
          rules.push("div:has(> " + rowKeySelector("workspace:" + workspaceId) + "){display:none!important}");
        }
        rules.push(rowKeySelector("workspace:" + workspaceId) + "{display:none!important}");
        rules.push(rowKeySelector("overflow:" + workspaceId) + "{display:none!important}");
      }
      if (plan.ungroupedHidden) {
        rules.push(rowKeySelector("workspace:") + "{display:none!important}");
        if (supportsHasSelector()) rules.push("div:has(> " + rowKeySelector("workspace:") + "){display:none!important}");
      }
      if (plan.hiddenSessionIds.size > 0) {
        for (const sessionId of plan.hiddenSessionIds) {
          rules.push(rowKeySelector("session:" + sessionId) + "{display:none!important}");
        }
      }
      const next = rules.join("\n");
      if (tag.textContent !== next) tag.textContent = next;
    }

    // ------------------------------------------------------ 头部按钮注入
    let headerButton = null;
    let recentButton = null;

    function locateHeader(outlet) {
      if (outlet === null) return null;
      const root = outlet.firstElementChild;
      if (root === null) return null;
      let header = null;
      for (const child of root.children) {
        if (classOf(child).includes("_sectionHeader")) {
          header = child;
          break;
        }
      }
      if (header === null) return null;
      let actions = null;
      for (const child of header.children) {
        if (classOf(child).includes(HEADER_ACTIONS_SUFFIX)) {
          actions = child;
          break;
        }
      }
      return { root, header, actions };
    }

    function closeOrOpenPanel(kind, rect) {
      if (panelState.open && panelState.kind === kind) {
        closePanel();
        return;
      }
      openPanel(rect, kind);
    }

    function onHeaderButtonClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (headerButton === null || headerButton.disabled) return;
      closeOrOpenPanel("hide", headerButton.getBoundingClientRect());
    }

    function onRecentButtonClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (recentButton === null || recentButton.disabled) return;
      closeOrOpenPanel("recent", recentButton.getBoundingClientRect());
    }

    function createHeaderButton(kind) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = kind === "recent" ? "wsf-header-button wsf-header-button--recent" : "wsf-header-button";
      button.setAttribute("aria-haspopup", "dialog");
      button.addEventListener("click", kind === "recent" ? onRecentButtonClick : onHeaderButtonClick);
      return button;
    }

    function removeHeaderButtons() {
      if (headerButton !== null) {
        headerButton.removeEventListener("click", onHeaderButtonClick);
        if (headerButton.isConnected) headerButton.remove();
        headerButton = null;
      }
      if (recentButton !== null) {
        recentButton.removeEventListener("click", onRecentButtonClick);
        if (recentButton.isConnected) recentButton.remove();
        recentButton = null;
      }
    }

    function ensureHeaderButtons(data) {
      const outlet = browserOutlet();
      const located = locateHeader(outlet);
      if (located === null) {
        removeHeaderButtons();
        return;
      }
      const { root, header, actions } = located;
      if (headerButton === null || !headerButton.isConnected || headerButton.parentElement !== header) {
        headerButton = createHeaderButton("hide");
        if (actions !== null && actions.parentElement === header) {
          header.insertBefore(headerButton, actions);
        } else {
          header.appendChild(headerButton);
        }
      }
      // 「最近使用」按钮排在搜索与眼睛按钮之间：紧挨着眼睛按钮之前插入。
      if (recentButton === null || !recentButton.isConnected || recentButton.parentElement !== header) {
        recentButton = createHeaderButton("recent");
        if (headerButton !== null && headerButton.parentElement === header) {
          header.insertBefore(recentButton, headerButton);
        } else if (actions !== null && actions.parentElement === header) {
          header.insertBefore(recentButton, actions);
        } else {
          header.appendChild(recentButton);
        }
      }
      // 宽栏 ↔ 窄栏(rail)切换或 React 重排时，外部注入的按钮会被挤到错误位置：
      // 每次同步都强制恢复「搜索 → recent → eye → headerActions」的顺序。
      if (headerButton !== null && headerButton.parentElement === header) {
        if (actions !== null && actions.parentElement === header) {
          if (headerButton.nextElementSibling !== actions) {
            header.insertBefore(headerButton, actions);
          }
        } else if (header.lastElementChild !== headerButton) {
          header.appendChild(headerButton);
        }
      }
      if (recentButton !== null && recentButton.parentElement === header) {
        if (headerButton !== null && headerButton.parentElement === header) {
          if (recentButton.nextElementSibling !== headerButton) {
            header.insertBefore(recentButton, headerButton);
          }
        }
      }
      const gate = focusGate();
      const mode = data.mode;
      const flat = mode === "flat";
      const rail = classOf(root).includes(RAIL_SUFFIX);
      const searchOpen = actions !== null && classOf(actions).includes(HEADER_ACTIONS_SUFFIX + "Hidden");
      const hidden = rail || searchOpen;
      const t = data.t === null || data.t === undefined ? (key) => key : data.t;
      if (headerButton !== null && headerButton.parentElement === header) {
        if (!gate.hide) {
          headerButton.hidden = true;
          headerButton.setAttribute("aria-hidden", "true");
        } else {
          const active = data.prefs.hideActive === true && !flat;
          headerButton.hidden = hidden;
          headerButton.disabled = flat;
          headerButton.dataset.active = active ? "true" : "false";
          headerButton.dataset.flat = flat ? "true" : "false";
          const label = flat ? t("header.disabledFlat") : active ? t("header.active") : t("header.open");
          headerButton.title = label;
          headerButton.setAttribute("aria-label", label);
          headerButton.setAttribute("aria-pressed", active ? "true" : "false");
          const icon = active ? "off" : "on";
          if (headerButton.dataset.icon !== icon) {
            headerButton.dataset.icon = icon;
            headerButton.innerHTML = active ? EYE_OFF_SVG : EYE_SVG;
          }
        }
      }
      if (recentButton !== null && recentButton.parentElement === header) {
        if (!gate.recent) {
          recentButton.hidden = true;
          recentButton.setAttribute("aria-hidden", "true");
        } else {
          const recentActive = data.prefs.recentOnly === true;
          recentButton.hidden = hidden;
          recentButton.dataset.active = recentActive ? "true" : "false";
          const recentLabel = recentActive
            ? t("header.recentActive")
            : formatTemplate(t("header.recentOpen"), { limit: data.prefs.limit });
          recentButton.title = recentLabel;
          recentButton.setAttribute("aria-label", recentLabel);
          recentButton.setAttribute("aria-pressed", recentActive ? "true" : "false");
          if (recentButton.dataset.icon !== "recent") {
            recentButton.dataset.icon = "recent";
            recentButton.innerHTML = RECENT_SVG;
          }
        }
      }
    }

    // ------------------------------------------------------ 自动展开路径容器

    function findGroupHeader(workspaceId) {
      const outlet = browserOutlet();
      if (outlet === null) return null;
      return outlet.querySelector(rowKeySelector("workspace:" + workspaceId) + '[role="treeitem"]');
    }

    function expandHeader(header) {
      if (header === null || !header.isConnected) return false;
      if (header.getAttribute("aria-expanded") !== "false") return false;
      if (header.getClientRects().length === 0) return false;
      header.click();
      return true;
    }

    function collapseHeader(header) {
      if (header === null || !header.isConnected) return false;
      if (header.getAttribute("aria-expanded") !== "true") return false;
      header.click();
      return true;
    }

    function syncContainerExpansion(plan) {
      for (const workspaceId of plan.containers) {
        const header = findGroupHeader(workspaceId);
        if (header === null) continue;
        if (header.getAttribute("aria-expanded") === "false") {
          if (expandHeader(header)) {
            header.setAttribute("data-wsf-autoexpanded", "1");
            scheduleReconcile();
          }
        }
        // 注意：已展开的容器不打标。否则退出隐藏模式时会把用户自己展开的父工作区折叠掉。
      }
      const outlet = browserOutlet();
      if (outlet === null) return;
      for (const header of Array.from(outlet.querySelectorAll('[data-wsf-autoexpanded="1"]'))) {
        const rowKey = header.getAttribute("data-row-key");
        const key = typeof rowKey === "string" ? rowKey.slice("workspace:".length) : null;
        if (key !== null && plan.containers.has(key)) continue;
        collapseHeader(header);
        header.removeAttribute("data-wsf-autoexpanded");
      }
    }

    // --------------------------------------------------------- 自动保留新组
    let knownWorkspaceIds = null;
    let wasHideActive = false;

    function syncKeepList(items, prefsSnapshot) {
      const ids = [];
      for (const workspace of items) {
        if (workspace !== null && workspace !== undefined && typeof workspace.workspaceId === "string") ids.push(workspace.workspaceId);
      }
      // 页面刚加载时工作区快照可能还是空的：空列表不代表「所有工作区都被删了」，
      // 不能拿它做基线，否则会把已保存的保留列表误判成过期数据、再被后面完整快照整体补齐。
      if (ids.length === 0) return;
      if (prefsSnapshot.hideActive !== true) {
        wasHideActive = false;
        knownWorkspaceIds = new Set(ids);
        return;
      }
      if (!wasHideActive || knownWorkspaceIds === null) {
        wasHideActive = true;
        knownWorkspaceIds = new Set(ids);
        return;
      }
      const added = ids.filter((workspaceId) => !knownWorkspaceIds.has(workspaceId));
      knownWorkspaceIds = new Set(ids);
      if (added.length === 0) return;
      setPrefs({ keepWorkspaces: prefsSnapshot.keepWorkspaces.concat(added) });
    }

    function pruneKeepList(items, prefsSnapshot) {
      if (prefsSnapshot.keepWorkspaces.length === 0) return;
      // 快照尚未加载时无法判断哪些工作区已被删除，先不动保存的列表。
      if (items.length === 0) return;
      const existing = new Set();
      for (const workspace of items) {
        if (workspace !== null && workspace !== undefined) existing.add(workspace.workspaceId);
      }
      const next = prefsSnapshot.keepWorkspaces.filter((workspaceId) => existing.has(workspaceId));
      if (next.length !== prefsSnapshot.keepWorkspaces.length) setPrefs({ keepWorkspaces: next });
    }

    // ------------------------------------------------------------ 协调循环
    const latestData = { items: [], byId: {}, archivedSessionIds: [], prefs: loadPrefs(), t: null, mode: null };
    let reconcileScheduled = false;
    let domStarted = false;
    let domObserver = null;

    function reconcile() {
      const data = latestData;
      const outlet = browserOutlet();
      if (outlet !== null) {
        data.mode = readViewMode();
        const gate = focusGate();
        const effectivePrefs = { ...data.prefs };
        if (!gate.hide) {
          effectivePrefs.hideActive = false;
          effectivePrefs.keepWorkspaces = [];
          effectivePrefs.keepUngrouped = true;
        }
        if (!gate.recent) effectivePrefs.recentOnly = false;
        const viewData = { ...data, prefs: effectivePrefs };
        syncKeepList(viewData.items, effectivePrefs);
        pruneKeepList(viewData.items, effectivePrefs);
        ensureHeaderButtons(viewData);
        const plan = buildHidePlan(viewData, data.mode, outlet);
        applyHidePlan(outlet, plan);
        writeStyleRules(plan, outlet, data.mode);
        syncContainerExpansion(plan);
      } else {
        data.mode = null;
        removeHeaderButtons();
        const tag = ensureFilterStyle();
        if (tag !== null && tag.textContent !== "") tag.textContent = "";
      }
    }

    function safeReconcile() {
      try {
        reconcile();
      } catch (error) {
        // 单次 DOM 结构异常不应让后续同步停摆（例如非法选择器 / 宿主结构变更）。
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[dsh-workspace-focus] reconcile failed", error);
        }
      }
    }

    function scheduleReconcile() {
      if (reconcileScheduled) return;
      reconcileScheduled = true;
      scheduleFrame(() => {
        reconcileScheduled = false;
        safeReconcile();
      });
    }

    function startDomSync() {
      if (domStarted) return;
      domStarted = true;
      ensureComponentStyle();
      if (typeof document === "undefined" || typeof MutationObserver !== "function") return;
      domObserver = new MutationObserver((mutations) => {
        const outlet = browserOutlet();
        if (outlet === null) {
          scheduleReconcile();
          return;
        }
        for (const mutation of mutations) {
          if (mutation.target === outlet || outlet.contains(mutation.target)) {
            scheduleReconcile();
            return;
          }
          for (const node of Array.from(mutation.addedNodes || [])) {
            if (node === outlet || (node.nodeType === 1 && (node.matches(OUTLET_SELECTOR) || node.contains(outlet)))) {
              scheduleReconcile();
              return;
            }
          }
        }
      });
      domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "aria-expanded"],
      });
    }

    function stopDomSync() {
      domStarted = false;
      if (domObserver !== null) {
        domObserver.disconnect();
        domObserver = null;
      }
      removeHeaderButtons();
      if (filterStyleTag !== null && filterStyleTag.isConnected) filterStyleTag.remove();
      filterStyleTag = null;
    }

    // ---------------------------------------------------------------- 视图
    function resolveTranslate(props) {
      if (typeof props.t === "function") return props.t;
      return (key) => {
        const language = typeof focusLanguage === "function"
          ? String(focusLanguage() || "en").toLowerCase()
          : typeof navigator !== "undefined" && typeof navigator.language === "string"
            ? navigator.language.toLowerCase()
            : "en";
        const dictionary = language.startsWith("zh") ? zh : en;
        return dictionary[key] !== undefined ? dictionary[key] : key;
      };
    }

    function formatTemplate(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])));
    }

    function computePanelPosition(rect, width = 300) {
      const viewportWidth = typeof window === "undefined" ? 1280 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 800 : window.innerHeight;
      const margin = 8;
      let left = rect !== null && rect !== undefined ? Math.round(rect.left) : margin;
      left = Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin));
      let top = rect !== null && rect !== undefined ? Math.round(rect.bottom + 6) : margin;
      const maxTop = Math.max(margin, viewportHeight - 120);
      if (top > maxTop) top = maxTop;
      return { left, top, width };
    }

    function EyeIcon(props) {
      return React.createElement(
        "svg",
        { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        React.createElement("path", {
          d: "M6.35 3.85A7.2 7.2 0 0 1 8 3.7c3.9 0 6.3 4.3 6.3 4.3a11.6 11.6 0 0 1-2.45 2.95",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        }),
        React.createElement("path", {
          d: "M9.75 12.15A7.2 7.2 0 0 1 8 12.3C4.1 12.3 1.7 8 1.7 8a11.6 11.6 0 0 1 2.45-2.95",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round",
        }),
        props.off === true
          ? React.createElement("path", {
            d: "M2.6 2.6 13.4 13.4",
            stroke: "currentColor",
            strokeWidth: 1.3,
            strokeLinecap: "round",
          })
          : null,
      );
    }

    function StepperArrow(props) {
      return React.createElement(
        "svg",
        { width: 9, height: 5, viewBox: "0 0 9 5", "aria-hidden": "true" },
        React.createElement("path", { d: props.up ? "M0 5 4.5 0 9 5Z" : "M0 0 9 0 4.5 5Z", fill: "currentColor" }),
      );
    }

    function workspaceLabel(workspace) {
      const title = typeof workspace.title === "string" && workspace.title.length > 0 ? workspace.title : null;
      if (title !== null) return title;
      const path = normalizePath(workspace.path);
      const segments = path.split("/");
      return segments[segments.length - 1] || path || workspace.workspaceId;
    }

    function WorkspaceHidePanel(props) {
      const t = props.t;
      const items = props.items;
      const currentId = props.currentId;
      const initialPosition = React.useMemo(() => computePanelPosition(props.rect), [props.rect]);
      const [position, setPosition] = React.useState(initialPosition);
      const [draftKeep, setDraftKeep] = React.useState(() => new Set(props.prefs.keepWorkspaces));
      const [draftUngrouped, setDraftUngrouped] = React.useState(props.prefs.keepUngrouped);
      const panelRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const element = panelRef.current;
        if (element === null) return;
        const rect = element.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        let top = initialPosition.top;
        if (top + rect.height > viewportHeight - 8) {
          top = Math.max(8, Math.round(initialPosition.top - rect.height - 12));
        }
        if (top !== initialPosition.top) setPosition({ left: initialPosition.left, top, width: initialPosition.width });
      }, [initialPosition]);

      React.useEffect(() => {
        return () => {
          panelElement = null;
        };
      }, []);

      const workspaceEntries = items.map((workspace) => ({
        workspaceId: workspace.workspaceId,
        label: workspaceLabel(workspace),
        path: normalizePath(workspace.path),
      }));

      const toggleKeep = (workspaceId) => {
        setDraftKeep((previous) => {
          const next = new Set(previous);
          if (next.has(workspaceId)) next.delete(workspaceId);
          else next.add(workspaceId);
          return next;
        });
      };

      const selectAll = () => setDraftKeep(new Set(workspaceEntries.map((entry) => entry.workspaceId)));
      const selectNone = () => setDraftKeep(new Set());

      const apply = () => {
        const ordered = workspaceEntries.map((entry) => entry.workspaceId).filter((workspaceId) => draftKeep.has(workspaceId));
        setPrefs({ hideActive: true, keepWorkspaces: ordered, keepUngrouped: draftUngrouped });
        closePanel();
      };
      const showAll = () => {
        setPrefs({ hideActive: false });
        closePanel();
      };

      const children = [];
      children.push(
        React.createElement(
          "div",
          { className: "wsf-panel-head", key: "head" },
          React.createElement(
            "div",
            { className: "wsf-panel-headText" },
            React.createElement("div", { className: "wsf-panel-title" }, t("panel.title")),
            React.createElement("div", { className: "wsf-panel-desc" }, t("panel.description")),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "wsf-icon-button wsf-panel-close",
              title: t("panel.close"),
              "aria-label": t("panel.close"),
              onClick: closePanel,
            },
            closeIcon(),
          ),
        ),
      );
      children.push(
        React.createElement(
          "div",
          { className: "wsf-panel-tools", key: "tools" },
          React.createElement(
            "span",
            { className: "wsf-panel-count" },
            formatTemplate(t("panel.count"), { selected: draftKeep.size, total: workspaceEntries.length }),
          ),
          React.createElement(
            "span",
            { style: { display: "inline-flex", gap: 10 } },
            React.createElement("button", { type: "button", className: "wsf-link-button", onClick: selectAll }, t("panel.selectAll")),
            React.createElement("button", { type: "button", className: "wsf-link-button", onClick: selectNone }, t("panel.selectNone")),
          ),
        ),
      );
      if (draftKeep.size === 0) {
        children.push(React.createElement("div", { className: "wsf-hint", key: "hint" }, t("panel.hintEmpty")));
      }
      const rows = [];
      for (const entry of workspaceEntries) {
        const rowChildren = [
          React.createElement("input", {
            key: "input",
            type: "checkbox",
            checked: draftKeep.has(entry.workspaceId),
            onChange: () => toggleKeep(entry.workspaceId),
            "aria-label": entry.label,
          }),
          React.createElement(
            "span",
            { className: "wsf-itemText", key: "text" },
            React.createElement("span", { className: "wsf-itemTitle", title: entry.label }, entry.label),
            entry.path.length > 0 ? React.createElement("span", { className: "wsf-itemPath", title: entry.path }, entry.path) : null,
          ),
        ];
        if (entry.workspaceId === currentId) {
          rowChildren.push(React.createElement("span", { className: "wsf-badge", key: "badge" }, t("panel.current")));
        }
        rows.push(
          React.createElement(
            "label",
            { key: entry.workspaceId, className: "wsf-item" },
            rowChildren,
          ),
        );
      }
      const ungroupedRow = React.createElement(
        "label",
        { className: "wsf-item", key: "ungrouped" },
        React.createElement("input", {
          type: "checkbox",
          checked: draftUngrouped === true,
          onChange: () => setDraftUngrouped(!draftUngrouped),
          "aria-label": t("panel.ungrouped"),
        }),
        React.createElement(
          "span",
          { className: "wsf-itemText" },
          React.createElement("span", { className: "wsf-itemTitle" }, t("panel.ungrouped")),
          React.createElement("span", { className: "wsf-itemPath" }, t("panel.ungroupedDesc")),
        ),
      );
      rows.push(ungroupedRow);
      children.push(React.createElement("div", { className: "wsf-list", key: "list" }, rows));
      children.push(
        React.createElement(
          "div",
          { className: "wsf-panel-footer", key: "footer" },
          React.createElement("button", { type: "button", className: "wsf-btn wsf-btn-ghost", onClick: showAll }, t("panel.showAll")),
          React.createElement("button", { type: "button", className: "wsf-btn wsf-btn-primary", onClick: apply }, t("panel.apply")),
        ),
      );

      return React.createElement(
        "div",
        {
          ref: (element) => {
            panelRef.current = element;
            panelElement = element;
          },
          className: "wsf-panel",
          role: "dialog",
          "aria-label": t("panel.title"),
          style: { left: position.left + "px", top: position.top + "px", width: position.width + "px" },
        },
        children,
      );
    }

    function RecentPanel(props) {
      const t = props.t;
      const preferences = props.prefs;
      const enabled = preferences.recentOnly === true;
      const limit = preferences.limit;
      const initialPosition = React.useMemo(() => computePanelPosition(props.rect, 280), [props.rect]);
      const [position, setPosition] = React.useState(initialPosition);
      const panelRef = React.useRef(null);

      React.useLayoutEffect(() => {
        const element = panelRef.current;
        if (element === null) return;
        const rect = element.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        let top = initialPosition.top;
        if (top + rect.height > viewportHeight - 8) {
          top = Math.max(8, Math.round(initialPosition.top - rect.height - 12));
        }
        if (top !== initialPosition.top) setPosition({ left: initialPosition.left, top, width: initialPosition.width });
      }, [initialPosition]);

      React.useEffect(() => {
        return () => {
          panelElement = null;
        };
      }, []);

      const children = [];
      children.push(
        React.createElement(
          "div",
          { className: "wsf-panel-head wsf-panel-head--compact", key: "head" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "wsf-icon-button wsf-panel-close",
              title: t("panel.close"),
              "aria-label": t("panel.close"),
              onClick: closePanel,
            },
            closeIcon(),
          ),
        ),
      );
      children.push(
        React.createElement(
          "div",
          { className: "wsf-popover-section", key: "toggle" },
          React.createElement(
            "div",
            { className: "wsf-popover-label" },
            React.createElement("span", { className: "wsf-popover-labelTitle" }, t("recentPanel.toggle")),
            React.createElement("span", { className: "wsf-popover-labelDesc" }, t("recentPanel.toggleDesc")),
          ),
          React.createElement(
            "button",
            {
              type: "button",
              role: "switch",
              className: "wsf-switch",
              "aria-checked": enabled ? "true" : "false",
              "aria-label": t("recentPanel.toggle"),
              onClick: () => {
                setPrefs({ recentOnly: !enabled });
              },
            },
            React.createElement("span", { className: "wsf-thumb" }),
          ),
        ),
      );
      children.push(
        React.createElement(
          "div",
          { className: "wsf-popover-section", key: "count" },
          React.createElement(
            "div",
            { className: "wsf-popover-label" },
            React.createElement("span", { className: "wsf-popover-labelTitle" }, t("recentPanel.countLabel")),
            React.createElement("span", { className: "wsf-popover-labelDesc" }, t("recentPanel.countDesc")),
          ),
          React.createElement(
            "span",
            { className: "wsf-control" },
            React.createElement(
              "div",
              { className: "wsf-step", role: "group" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "wsf-step-btn",
                  disabled: limit <= MIN_LIMIT,
                  "aria-label": t("settings.decrease"),
                  onClick: () => {
                    setPrefs({ limit: limit - 1 });
                  },
                },
                "\u2212",
              ),
              React.createElement("span", { className: "wsf-step-value" }, String(limit)),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "wsf-step-btn",
                  disabled: limit >= MAX_LIMIT,
                  "aria-label": t("settings.increase"),
                  onClick: () => {
                    setPrefs({ limit: limit + 1 });
                  },
                },
                "+",
              ),
            ),
            t("recentPanel.unit") ? React.createElement("span", { className: "wsf-unit" }, t("recentPanel.unit")) : null,
          ),
        ),
      );
      if (!enabled) {
        children.push(
          React.createElement(
            "div",
            { className: "wsf-hint", key: "tipOff" },
            formatTemplate(t("recentPanel.tipOff"), { limit }),
          ),
        );
      }
      children.push(
        React.createElement("div", { className: "wsf-hint", key: "hint" }, t("recentPanel.hint")),
      );

      return React.createElement(
        "div",
        {
          ref: (element) => {
            panelRef.current = element;
            panelElement = element;
          },
          className: "wsf-panel wsf-panel--recent",
          role: "dialog",
          "aria-label": t("recentPanel.title"),
          style: { left: position.left + "px", top: position.top + "px", width: position.width + "px" },
        },
        children,
      );
    }

    function WorkspaceFocusOverlay(props) {
      const t = resolveTranslate(props);
      const preferences = usePrefs();
      const panel = usePanelState();
      const items = typeof props.useWorkspaces === "function"
        ? props.useWorkspaces((snapshot) => snapshot.items)
        : [];
      const byId = typeof props.useSessions === "function"
        ? props.useSessions((snapshot) => snapshot.byId)
        : {};
      const archivedSessionIds = typeof props.useWorkspaces === "function"
        ? props.useWorkspaces((snapshot) => snapshot.archivedSessionIds)
        : [];

      latestData.items = items;
      latestData.byId = byId;
      latestData.archivedSessionIds = archivedSessionIds;
      latestData.prefs = preferences;
      latestData.t = t;

      React.useEffect(() => {
        startDomSync();
        scheduleReconcile();
        return () => {
          stopDomSync();
        };
      }, []);
      React.useEffect(() => {
        scheduleReconcile();
      }, [items, byId, archivedSessionIds, preferences]);
      React.useEffect(() => {
        if (!panel.open) return undefined;
        const onKeyDown = (event) => {
          if (event.key === "Escape") {
            closePanel();
          }
        };
        const onPointerDown = (event) => {
          const target = event.target;
          if (target === null || target === undefined || typeof target.nodeType !== "number") return;
          if (headerButton !== null && (target === headerButton || headerButton.contains(target))) return;
          if (recentButton !== null && (target === recentButton || recentButton.contains(target))) return;
          if (panelElement !== null && panelElement.contains(target)) return;
          closePanel();
        };
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => {
          document.removeEventListener("keydown", onKeyDown, true);
          document.removeEventListener("pointerdown", onPointerDown, true);
        };
      }, [panel.open]);
      React.useEffect(() => {
        if (!panel.open) return undefined;
        const onResize = () => closePanel();
        window.addEventListener("resize", onResize);
        return () => {
          window.removeEventListener("resize", onResize);
        };
      }, [panel.open]);

      const currentId = currentWorkspaceId(items, byId);
      if (!panel.open) return null;
      if (panel.kind === "recent") {
        return React.createElement(RecentPanel, {
          prefs: preferences,
          rect: panel.rect,
          t,
        });
      }
      return React.createElement(WorkspaceHidePanel, {
        items,
        prefs: preferences,
        rect: panel.rect,
        t,
        currentId,
      });
    }

    function WorkspaceFocusRow(props) {
      const preferences = usePrefs();
      const t = resolveTranslate(props);
      const enabled = preferences.recentOnly;
      const limit = preferences.limit;
      return React.createElement(
        "div",
        { className: "wsf-row" },
        React.createElement(
          "div",
          { className: "wsf-rowText" },
          React.createElement("div", { className: "wsf-title" }, t("settings.title")),
          React.createElement("div", { className: "wsf-desc" }, t("settings.description")),
        ),
        React.createElement(
          "div",
          { className: "wsf-control" },
          React.createElement(
            "button",
            {
              type: "button",
              role: "switch",
              className: "wsf-switch",
              "aria-checked": enabled ? "true" : "false",
              "aria-label": t("settings.toggle"),
              onClick: () => {
                setPrefs({ recentOnly: !enabled });
              },
            },
            React.createElement("span", { className: "wsf-thumb" }),
          ),
          React.createElement(
            "div",
            { className: "wsf-stepper" },
            React.createElement("span", { className: "wsf-value" }, String(limit)),
            React.createElement(
              "span",
              { className: "wsf-arrows" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "wsf-arrow",
                  disabled: limit >= MAX_LIMIT,
                  "aria-label": t("settings.increase"),
                  onClick: () => {
                    setPrefs({ limit: limit + 1 });
                  },
                },
                React.createElement(StepperArrow, { up: true }),
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "wsf-arrow",
                  disabled: limit <= MIN_LIMIT,
                  "aria-label": t("settings.decrease"),
                  onClick: () => {
                    setPrefs({ limit: limit - 1 });
                  },
                },
                React.createElement(StepperArrow, { up: false }),
              ),
            ),
          ),
          t("settings.unit") ? React.createElement("span", { className: "wsf-unit" }, t("settings.unit")) : null,
        ),
      );
    }

    // ---------------------------------------------------------------- 装配
    let focusGate = function () { return { hide: true, recent: true }; };
    let focusSubscribe = null;
    let focusLanguage = null;

    function useFocusGate() {
      const pair = React.useState(0);
      const force = pair[1];
      React.useEffect(function () {
        if (typeof focusSubscribe !== "function") return undefined;
        return focusSubscribe(function () {
          force(function (value) { return value + 1; });
        });
      }, []);
      return focusGate();
    }

    // 最近工作区设置项常驻注册，开关关闭时自行隐藏（便于实时生效）。
    function WorkspaceFocusRowGated(props) {
      const gate = useFocusGate();
      if (!gate.recent) return null;
      return React.createElement(WorkspaceFocusRow, props);
    }

    function apply(ctx, options) {
      const opts = options || {};
      if (typeof opts.getLanguage === "function") focusLanguage = opts.getLanguage;
      if (typeof opts.getGates === "function") {
        focusGate = opts.getGates;
      } else if (opts && typeof opts === "object" && ("hide" in opts || "recent" in opts)) {
        const fixed = { hide: opts.hide !== false, recent: opts.recent !== false };
        focusGate = function () { return fixed; };
      }
      focusSubscribe = typeof opts.subscribe === "function" ? opts.subscribe : null;
      const slots = ctx.get("slots") ?? ctx.slots;
      if (slots === undefined || slots === null) return;
      const locale = ctx.get("locale") ?? ctx.locale;
      const hasLocale = locale !== undefined && locale !== null && typeof locale.register === "function";
      if (hasLocale) {
        ctx.effect(() => locale.register(NS, { zh, en }), "dsh-workspace-focus: dictionaries");
      }
      ctx.effect(() => {
        const componentStyle = ensureComponentStyle();
        return () => {
          if (componentStyle !== null && componentStyle.isConnected) componentStyle.remove();
          if (filterStyleTag !== null && filterStyleTag.isConnected) filterStyleTag.remove();
          filterStyleTag = null;
          panelElement = null;
        };
      }, "dsh-workspace-focus: styles");
      const localeOption = hasLocale ? { locale: NS } : {};
      slots.inject("shell.overlay", () => slots.register({
        name: "shell.overlay",
        id: PLUGIN_ID + "-controller",
        order: 100,
        ...localeOption,
      }, WorkspaceFocusOverlay));
      slots.inject("settings.general.item", () => slots.register({
        name: "settings.general.item",
        id: PLUGIN_ID,
        order: 40,
        ...localeOption,
      }, WorkspaceFocusRowGated));
    }

    exports.inject = ["slots", "locale"];
    exports.apply = apply;
    exports.refresh = function () {
      try {
        safeReconcile();
      } catch (error) {
        /* no outlet yet */
      }
    };
    if (typeof globalThis !== "undefined" && globalThis.__DSH_WORKSPACE_FOCUS_TEST__ === true) {
      exports.__test = {
        buildHidePlan,
        computeRecentHiddenWorkspaces,
        currentWorkspaceId,
        owningParent,
        computePanelPosition,
        readViewMode,
        applyHidePlan,
        writeStyleRules,
        syncContainerExpansion,
        locateHeader,
        reconcileNow: safeReconcile,
        WorkspaceHidePanel,
        RecentPanel,
        WorkspaceFocusRow,
        WorkspaceFocusOverlay,
        getPrefs: () => prefs,
        getPanelState: () => panelState,
        setPrefs,
      };
    }
    return module.exports;
      };
      var workspaceFocusMod = createWorkspaceFocus(require);

      /* ------------------------------------------------------------------ */
      /* registration                                                        */
      /* ------------------------------------------------------------------ */

      var inject = ['slots', 'locale', 'layout', 'remote', 'remote.session', 'sessions', 'workspaces', 'uiWorkspace'];

      function apply(ctx) {
        accountCtx = ctx;
        var featuresReady = loadFeatures();
        featuresReady.then(function () {
          if (!workspaceFocusMod || typeof workspaceFocusMod.apply !== 'function') return;
          try {
            workspaceFocusMod.apply(ctx, {
              getGates: function () {
                return { hide: featureSnapshot.sidebarHide, recent: featureSnapshot.sidebarRecent };
              },
              getLanguage: currentLang,
              subscribe: function (listener) {
                featureListeners.push(listener);
                return function () {
                  var index = featureListeners.indexOf(listener);
                  if (index >= 0) featureListeners.splice(index, 1);
                };
              },
            });
          } catch (error) {
            console.error('[' + NS + '] workspace sidebar filters failed to mount', error);
          }
        });

        ctx.effect(
          function () {
            return injectStyles();
          },
          NS + ': styles',
        );

        ctx.effect(
          function () {
            var dispose = function () {};
            try {
              dispose = ctx.locale.register(NS, { zh: UI_ZH, en: UI_EN });
            } catch (error) {
              console.error('[' + NS + '] locale registration failed', error);
            }
            try {
              var bound = ctx.locale.bind(NS);
              translate = function (key, params) {
                var value = bound(key, params);
                return typeof value === 'string' && value !== '' ? value : fallbackTranslate(key, params);
              };
            } catch (error) {
              translate = function (key, params) {
                return fallbackTranslate(key, params);
              };
            }
            return function () {
              translate = function (key, params) {
                return fallbackTranslate(key, params);
              };
              try {
                dispose();
              } catch (error) {
                /* already disposed */
              }
            };
          },
          NS + ': locale',
        );

        function openPanel() {
          try {
            if (!ctx.layout || typeof ctx.layout.selectPanel !== 'function') {
              throw new Error('layout service is unavailable');
            }
            ctx.layout.selectPanel(PANEL_ID);
          } catch (error) {
            console.error('[' + NS + '] could not select the manager panel', error);
          }
        }

        function openSettingsPanel() {
          try {
            if (!ctx.layout || typeof ctx.layout.selectPanel !== 'function') {
              throw new Error('layout service is unavailable');
            }
            ctx.layout.selectPanel(SETTINGS_PANEL_ID);
          } catch (error) {
            console.error('[' + NS + '] could not select the settings panel', error);
          }
        }

        openSettingsPanelFromMenu = openSettingsPanel;

        ctx.effect(
          function () {
            try {
              return ctx.slots.inject('sidebar.panellist', function () {
                return ctx.slots.register(
                  {
                    name: 'sidebar.panellist',
                    id: PANEL_ID,
                    order: NAV_ORDER,
                    locale: NS,
                    label: function () {
                      return tr('panel.title');
                    },
                  },
                  SessionManagerNavEntry,
                );
              });
            } catch (error) {
              console.error('[' + NS + '] sidebar navigation entry registration failed', error);
              return function () {};
            }
          },
          NS + ': sidebar entry',
        );

        ctx.effect(
          function () {
            try {
              return ctx.slots.inject('sidebar.panellist.actions', function () {
                return ctx.slots.register(
                  {
                    name: 'sidebar.panellist.actions',
                    id: 'session-settings',
                    order: SETTINGS_MENU_ORDER,
                    locale: NS,
                  },
                  SessionSettingsMoreItem,
                );
              });
            } catch (error) {
              console.error('[' + NS + '] settings More-menu registration failed', error);
              return function () {};
            }
          },
          NS + ': settings More-menu entry',
        );

        ctx.effect(
          function () {
            try {
              return ctx.slots.inject('main', function () {
                return ctx.slots.register(
                  {
                    name: 'main',
                    key: PANEL_ID,
                    locale: NS,
                    inject: function () {
                      return {
                        sessions: ctx.sessions,
                        workspaces: ctx.workspaces,
                        uiWorkspace: ctx.uiWorkspace,
                        remote: ctx.remote,
                      };
                    },
                  },
                  SessionManagerSessionsPanel,
                );
              });
            } catch (error) {
              console.error('[' + NS + '] main panel registration failed', error);
              return function () {};
            }
          },
          NS + ': manager panel',
        );

        ctx.effect(
          function () {
            try {
              return ctx.slots.inject('main', function () {
                return ctx.slots.register(
                  {
                    name: 'main',
                    key: SETTINGS_PANEL_ID,
                    locale: NS,
                    inject: function () {
                      return {
                        sessions: ctx.sessions,
                        workspaces: ctx.workspaces,
                        uiWorkspace: ctx.uiWorkspace,
                        remote: ctx.remote,
                      };
                    },
                  },
                  SessionSettingsPanel,
                );
              });
            } catch (error) {
              console.error('[' + NS + '] settings panel registration failed', error);
              return function () {};
            }
          },
          NS + ': settings panel',
        );

        ctx.effect(
          function () {
            try {
              return ctx.slots.inject('plugins.row.config', function () {
                return ctx.slots.register(
                  {
                    name: 'plugins.row.config',
                    key: BUNDLE_KEY,
                    locale: NS,
                  },
                  SessionManagerPluginConfig,
                );
              });
            } catch (error) {
              console.error('[' + NS + '] plugin config registration failed', error);
              return function () {};
            }
          },
          NS + ': plugin config',
        );
      }

      module.exports.inject = inject;
      module.exports.apply = apply;
      return module.exports;
    },
  });
})();
