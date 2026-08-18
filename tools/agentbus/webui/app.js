/* Yuvi AgentBus WebUI — zh-CN surface only. API / phases / envelopes stay English. */

const PHASE_LABELS_ZH = {
  WAITING_FOR_SPEC: "等待 GPT 任务规格",
  MATERIALIZING: "正在物化下一任务",
  WORKTREE_READY: "工作树已就绪，等待 PR 传输",
  BOOTSTRAP_PR_READY: "持久 PR 传输已就绪",
  IMPLEMENTING: "正在实现",
  VALIDATING: "正在验证",
  READY_FOR_AUDIT: "等待审计",
  AUDITING: "正在审计",
  READY_FOR_GPT: "等待 GPT 审阅",
  GPT_REVIEW: "GPT 审阅中",
  FINAL_GATE: "等待合并关口",
  MERGE_PENDING: "最终审阅已通过，正在合并",
  MERGE_RETRYABLE_FAILED: "合并未完成，可重试",
  MERGED: "已完成",
  WAITING_FOR_PLAN: "等待下一单元计划",
  WAITING_FOR_GPT: "等待产品 GPT 审阅",
  WAITING_FOR_MERGE_GPT: "等待合并 GPT",
  WAITING_FOR_HUMAN_MERGE: "等待人工通过并合并",
  BLOCKED: "已阻塞",
  PAUSED: "已暂停",
  RECOVERY_REQUIRED: "需要恢复",
  BLOCKED_FOR_REVIEW: "等待人工处理",
  RE_REVIEW_REQUIRED: "需要重新审阅",
  COMPLETE: "已完成",
};

const ROLE_LABELS_ZH = {
  impl: "实现（IMPL）",
  audit: "审计（AUDIT）",
  IMPL: "实现（IMPL）",
  AUDIT: "审计（AUDIT）",
  GPT: "GPT 规划 / 审阅",
  HUMAN: "人工",
};

const ACTION_LABELS_ZH = {
  SPEC: "等待规格",
  IMPL: "等待实现",
  AUDIT: "等待审计",
  GPT: "等待 GPT",
  HUMAN: "等待人工",
  RESUME: "等待恢复",
  PUBLISH: "等待 Git 发布",
  "-": "无",
};

const STATUS_LABELS_ZH = {
  IDLE: "空闲",
  WAITING: "等待中",
  RUNNING: "运行中",
  PASS: "已通过",
  PASSED: "已通过",
  FAIL: "失败",
  FAILED: "失败",
  BLOCKED: "已阻塞",
  CRASHED: "已崩溃",
  CLOSED: "已关闭",
  RECOVERY_REQUIRED: "需要恢复",
  CHANGES_REQUIRED: "需要修改",
  ACTIONABLE: "可执行",
  APPROVED: "已批准",
  ACCEPT: "已接受",
  ACCEPTED: "已接受",
  REJECT: "已拒绝",
  REJECTED: "已拒绝",
  REVIEWING: "审阅中",
  DRAFT: "草稿",
  STALE: "已过期",
  READY_FOR_AUDIT: "等待审计",
  READY_FOR_GPT: "等待 GPT 审阅",
  PUBLICATION_FAILED: "Git 发布失败",
  IMPLEMENTATION_COMPLETE_PUBLICATION_FAILED: "实现完成但 Git 发布失败",
};

const ATTENTION_LABELS_ZH = {
  running: "运行中",
  waiting: "等待代理",
  needs_gpt: "需要 GPT 审阅",
  needs_you: "需要你处理",
  blocked: "已阻塞",
  paused: "已暂停",
  complete: "已完成",
};

const RAIL_STEP_ZH = {
  GPT_SPEC: "GPT 规格",
  IMPL: "实现",
  AUDIT: "审计",
  GPT_REVIEW: "GPT 审阅",
  GATE: "最终关口",
};

const RAIL_STATE_ZH = {
  waiting: "等待",
  completed: "完成",
  current: "当前",
  blocked: "阻塞",
  paused: "暂停",
};

const PUB_STATUS_ZH = {
  idle: "空闲",
  committing: "正在创建提交",
  committed: "已提交（本地）",
  pushed: "已推送",
  failed: "Git 发布失败",
};

const SOURCE_LABELS_ZH = {
  "stream override": "当前任务覆盖",
  "global default": "Codex 全局默认",
  inherit: "继承默认设置",
  IMPLEMENTED_HEAD: "实现提交（IMPLEMENTED_HEAD）",
  PR_HEAD: "PR HEAD",
};

const EVENT_KIND_ZH = {
  created: "已创建任务",
  envelope: "已接收 envelope",
  invoke: "已启动角色",
  invoke_done: "角色已结束",
  pause: "已暂停",
  resume: "已恢复",
  "set-model": "已更新角色模型",
  "bind-gpt": "已绑定 GPT 会话",
  "unbind-gpt": "已清除 GPT 绑定",
  ack: "已确认",
  "publish-commit": "已创建实现提交",
  "audit-current": "已请求审计当前版本",
  "konsole-open": "已打开终端",
};

const I18N_ZH_CN = {
  brand: "Yuvi AgentBus",
  counts: {
    running: "运行中",
    waiting: "等待代理",
    needs_gpt: "需要 GPT",
    needs_you: "需要你处理",
    blocked: "已阻塞",
    complete: "已完成",
    paused: "已暂停",
    archived: "已归档",
    total: "总任务",
  },
  list: {
    title: "任务列表",
    empty: "还没有任务。",
    empty_needs: "当前没有需要你处理的任务。",
    empty_gpt: "当前没有需要 GPT 的任务。",
    no_pr: "无 PR",
    archived: "已归档",
    superseded: "已被后续任务取代",
  },
  main: {
    stream: "当前任务",
    needs_you: "需要你处理",
    needs_gpt: "需要 GPT 审阅",
    campaign: "长期任务",
    next_unit: "当前 / 下一单元",
    queue_empty: "后续队列为空",
    wait_reason: "等待原因",
    current_unit: "当前单元",
    gpt_suggest: "GPT 建议",
    suggest_sources: "依据",
    obsolete: "已被后续任务取代",
    archived: "已归档",
    open_gpt: "打开 GPT",
    no_goal: "（未填写目标）",
    select: "请选择一个任务，或新建一个。即使本界面关闭，CLI 仍可使用。",
    phase: "阶段",
    pr: "PR",
    local_inbox: "本地收件箱 — 有 PR 时仍以 PR 为持久化权威",
    branch: "分支",
    head: "当前 HEAD",
    repair: "修复轮次",
    authority: "最新权威",
    next: "下一步",
    blocker: "当前阻塞",
    none: "无",
    github: "GitHub",
    last_sync: "上次同步",
    never: "从未",
    rejected: "拒绝的消息",
    rejected_none: "无",
    rejected_recovered: "已通过兼容别名恢复",
    rejected_status: "已拒绝",
    alias: "兼容别名",
    connected: "已连接",
    degraded: "降级 / 离线",
    unauth: "未认证",
    envelopes_report: "最新 [CODEX_REPORT]",
    envelopes_audit: "最新 [CODEX_AUDIT]",
    none_yet: "尚无记录。",
    events: "事件时间线",
    no_events: "尚无事件。",
    logs: "原始日志",
    impl_log: "实现日志",
    audit_log: "审计日志",
    event_log: "事件时间线",
    refresh: "刷新",
    copy: "复制",
    copied: "已复制",
    autoscroll: "自动滚动",
    empty_log: "（空）",
  },
  actions: {
    pause: "暂停",
    resume: "恢复",
    step: "单步",
    workspace: "打开工作区",
    audit: "审计当前版本",
    pr: "打开 PR",
    sync: "立即同步",
    archive: "归档任务",
    archive_confirm: "归档后从默认任务列表隐藏，但保留 campaign 历史、PR/merge 锚点和 continuation authority。",
    unarchive: "恢复显示",
    purge: "彻底删除",
    purge_confirm: "彻底删除这个无 PR、无 campaign 锚点的本地草稿？此操作不可恢复。",
    delete: "归档任务",
    delete_confirm: "归档后从默认任务列表隐藏，但保留 campaign 历史、PR/merge 锚点和 continuation authority。",
    logs: "查看日志",
    open: "打开",
    reopen: "重新打开",
    focus: "聚焦",
    bind: "绑定 GPT",
    rebind: "重新绑定",
    clear: "清除绑定",
    save: "保存设置",
    create: "创建",
    cancel: "取消",
    recover: "恢复发布",
    start_audit: "开始审计",
    create_ws: "创建并打开工作区",
    create_only: "仅创建",
    pass_and_merge: "通过并合并",
    retry_merge: "重试合并",
    open_merge_gpt: "打开合并 GPT",
    copy_merge_prompt: "复制合并审阅提示词",
    bind_merge_gpt: "绑定合并 GPT",
  },
  gpt: {
    title: "GPT 会话",
    bound: "已绑定",
    unbound: "尚未绑定 GPT 会话。",
    planning: "规划 / 审阅",
    session_url: "已保存会话 URL",
    session_label: "仅保存名称，未保存 URL",
    safe: "工作流安全",
    safe_note: "会话 URL 只是便利指针，不是可调用 API。AgentBus 不会向 ChatGPT 自动发消息。",
    durable_pr: "持久化权威：PR",
    durable_local: "持久化权威：本地收件箱 / state.json",
    keep: "任务状态不会因此丢失。持久化状态仍保存在 GitHub PR / AgentBus 本地状态中。",
    bind_title: "绑定 GPT 会话",
    bind_help: "仅作打开会话的便利入口，不会改变工作流权威。关闭聊天是安全的。",
    display_name: "显示名称",
    url: "会话 URL",
    note: "备注",
    save: "保存绑定",
    placeholder_name: "规划 A",
    product_title: "产品 GPT",
    merge_title: "合并 GPT",
    merge_review: "合并审阅",
    merge_pending_hint: "打开合并 GPT 不会完成审阅。只有 GitHub 上的 [GPT_MERGE_REVIEW] 才算完成。",
    suggest_hold: "暂缓合并",
    suggest_wait_product: "等待产品 GPT 审阅",
    suggest_wait_merge: "等待合并 GPT",
    suggest_ok: "可以合并",
    suggest_human: "需要人工判断",
    suggest_gate: "最终审阅已通过，等待合并完成",
    suggest_merged: "已合并",
  },
  role: {
    impl_title: "实现终端（IMPL）",
    audit_title: "审计终端（AUDIT）",
    impl_model: "实现模型",
    audit_model: "审计模型",
    effort: "模型推理强度",
    execution_mode: "Codex 执行模式",
    execution_standard: "标准",
    execution_ultra: "Ultra",
    ultra_unsupported: "Ultra：当前 CLI 不支持",
    ultra_disabled: "Ultra（不可用）",
    ultra_tip: "当前安装的 Codex CLI 未暴露可执行 Ultra 模式。",
    invocation: "有效调用",
    profile: "配置档案",
    sandbox: "沙箱",
    source: "配置来源",
    inherit: "继承默认设置",
    effective: "实际调用",
    applies: "将在下一次调用时生效",
    pid: "PID",
    no_worktree: "未绑定工作树",
    save: "保存设置",
    recovery: "需要恢复",
    state: "状态",
  },
  pub: {
    title: "Git 发布",
    codex: "Codex 实现",
    validation: "验证",
    status: "Git 发布",
    head: "HEAD",
    implemented: "实现提交（IMPLEMENTED_HEAD）",
    not_ready: "尚未达到可审计状态",
    reason: "原因",
    pending: "待发布",
    pass: "通过",
    na: "不适用",
    running: "进行中",
    recover: "恢复发布",
  },
  wizard: {
    title: "新建任务",
    id: "任务 ID",
    pr: "PR 编号（可选）",
    goal: "目标",
    worktree: "实现工作树",
    create: "自动创建",
    existing: "使用已有工作树",
    none: "暂不绑定（稍后绑定）",
    impl: "实现角色",
    audit: "审计角色",
    gpt: "GPT 会话（可选）",
    name: "名称",
    url: "URL",
    need_id: "请填写任务 ID。",
    need_path: "请填写已有工作树路径。",
  },
  audit: {
    title: "审计当前版本",
    help: "对一个精确提交做独立审计，不会修改实现工作树。",
    allowed: "是否允许",
    yes: "是",
    no: "否",
    target: "目标提交",
    source: "来源",
    model: "审计模型",
    effort: "推理强度",
    sandbox: "沙箱",
    mismatch: "当前实现提交与工作区 HEAD 不一致，无法安全审计。",
    queued: "已向现有审计终端排队",
    start_audit: "开始审计",
  },
  toast: {
    select_sync: "请先选择一个任务再同步",
    synced: "已同步全部任务（含 continuation）",
    deleted: "已归档任务",
    archived: "已归档任务",
    unarchived: "已恢复显示",
    purged: "已彻底删除",
    no_pr: "此任务没有 PR",
    no_url: "未保存 URL。请重新绑定会话。",
    cleared: "已清除 GPT 绑定。任务阶段未改变。",
    konsole: "已请求打开 Konsole",
    focus: "已请求聚焦终端",
    focus_fail: "无法聚焦，请用「打开」启动可见终端。",
    published: "已发布",
    saved: "设置已保存，将在下一次调用时生效",
    step_armed: "已武装单步，并打开对应 Konsole。Codex 仍在该终端中可见。",
    step_none: "当前没有可执行的 Codex 步骤，任务在等待人工 / GPT。",
    workspace_ready: "工作区已就绪。存活的角色终端会被复用，不会抢焦点。",
    workspace_unbound: "未绑定 GPT 会话，仍会打开实现与审计终端。",
    lock_retry: "3 秒内未能获取任务锁。可稍后重试。",
  },
  err: {
    network: "网络连接失败",
    timeout: "请求超时",
    github: "GitHub 同步失败",
    auth: "GitHub 认证失败",
    lock: "AgentBus 状态锁暂时繁忙",
    dirty: "实现工作树有未提交更改",
    no_worktree: "任务尚未绑定实现工作树",
    head_mismatch: "实现提交与工作区 HEAD 不一致",
    no_head: "没有可审计的实现提交",
    audit_phase: "当前阶段不能审计当前版本",
    audit_moved: "审计开始前目标提交已变化",
    origin: "拒绝非本机来源",
    json: "请求不是有效 JSON",
    pub: "Git 发布失败",
    not_found: "未找到该资源",
    failed: "请求失败",
    detail: "技术详情",
  },
};

const ERROR_PATTERNS = [
  [/failed to fetch|networkerror|load failed/i, "network"],
  [/timeout/i, "timeout"],
  [/authentication required|not logged|unauth/i, "auth"],
  [/sync failed|github/i, "github"],
  [/lock|busy|LOCK_NB/i, "lock"],
  [/impl worktree is dirty/i, "dirty"],
  [/no impl worktree|missing worktree/i, "no_worktree"],
  [/IMPLEMENTED_HEAD .*!=|head mismatch/i, "head_mismatch"],
  [/No auditable IMPLEMENTED_HEAD/i, "no_head"],
  [/cannot Audit Current from phase/i, "audit_phase"],
  [/HEAD changed before audit/i, "audit_moved"],
  [/refusing non-localhost/i, "origin"],
  [/invalid JSON/i, "json"],
  [/publication|IMPLEMENTATION_COMPLETE_PUBLICATION/i, "pub"],
  [/not found/i, "not_found"],
];

let state = { overview: null, selected: null, filterNeeds: false, showArchived: false, events: [], logs: "", catalog: null };
let live = null;
let logState = { stream: null, kind: "impl", autoScroll: true };

function $(id) { return document.getElementById(id); }

function t(path) {
  return path.split(".").reduce((acc, key) => (acc && acc[key] != null ? acc[key] : ""), I18N_ZH_CN) || path;
}

function withCode(label, code) {
  if (!code || String(code) === label) return label;
  return `${label}（${code}）`;
}

function phaseLabel(phase) {
  if (!phase) return "—";
  return withCode(PHASE_LABELS_ZH[phase] || phase, phase);
}

function statusLabel(value) {
  if (value == null || value === "" || value === "-") return "—";
  const mapped = STATUS_LABELS_ZH[value];
  return mapped ? withCode(mapped, value) : String(value);
}

function attentionLabel(kind) {
  return ATTENTION_LABELS_ZH[kind] || kind;
}

function sourceLabel(value, fallback) {
  if (!value) return fallback != null ? fallback : I18N_ZH_CN.role.inherit;
  return SOURCE_LABELS_ZH[value] || value;
}

function nextLabel(stream) {
  if ((stream.control || "") === "paused") return withCode("已暂停，等待恢复", "PAUSED");
  const code = stream.next_action;
  if (code && ACTION_LABELS_ZH[code]) return withCode(ACTION_LABELS_ZH[code], code);
  return phaseLabel(stream.visible_phase || stream.phase);
}

function githubLabel(stream) {
  const gh = stream.github || {};
  if (gh.unauthenticated) return I18N_ZH_CN.main.unauth;
  if (gh.unavailable || stream.github_connected === false) return I18N_ZH_CN.main.degraded;
  return I18N_ZH_CN.main.connected;
}

function classifyError(err) {
  const name = err && err.name ? String(err.name) : "";
  const msg = err && err.message ? String(err.message) : String(err || "");
  const detail = (err && err.detail) || msg;
  if (name === "TypeError" && /fetch|network|Failed to fetch/i.test(msg)) return { key: "network", detail };
  if (name === "TimeoutError" || /timeout/i.test(name)) return { key: "timeout", detail };
  for (const [re, key] of ERROR_PATTERNS) {
    if (re.test(msg) || re.test(detail)) return { key, detail };
  }
  return { key: "failed", detail };
}

function toast(msg, detail) {
  const el = $("toast");
  el.innerHTML = detail
    ? `<div class="toast-title">${escapeHtml(msg)}</div><div class="toast-detail">${escapeHtml(detail)}</div>`
    : escapeHtml(msg);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 5600);
}

function toastError(err) {
  const info = classifyError(err);
  const title = I18N_ZH_CN.err[info.key] || I18N_ZH_CN.err.failed;
  const extra = info.key === "lock" ? t("toast.lock_retry") : "";
  const detail = [extra, info.detail].filter(Boolean).join("\n");
  toast(`${title}`, `${t("err.detail")}：\n${detail}`);
}

async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    const wrapped = new Error(err.message || "Failed to fetch");
    wrapped.name = err.name || "TypeError";
    throw wrapped;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || res.statusText);
    err.detail = [data.error, data.detail].filter(Boolean).join("\n");
    throw err;
  }
  return data;
}

async function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function badge(kind) {
  return `<span class="badge att-${kind}">${escapeHtml(attentionLabel(kind))}</span>`;
}

function renderCounts(overview) {
  const c = overview.counts || {};
  $("counts").innerHTML = [
    [t("counts.running"), c.running],
    [t("counts.waiting"), c.waiting],
    [t("counts.needs_gpt"), c.needs_gpt],
    [t("counts.needs_you"), c.needs_you],
    [t("counts.blocked"), c.blocked],
    [t("counts.complete"), c.complete],
    [t("counts.archived"), c.archived],
  ].map(([k, v]) => `<div class="count"><b>${v || 0}</b><span>${k}</span></div>`).join("");
}

function renderList(overview) {
  let streams = overview.streams || [];
  if (state.filterNeeds) streams = streams.filter((s) => s.needs_you);
  const box = $("stream-list");
  if (!streams.length) {
    box.innerHTML = `<div class="empty">${state.filterNeeds ? t("list.empty_needs") : t("list.empty")}</div>`;
    return;
  }
  box.innerHTML = streams.map((s) => `
    <div class="stream ${s.stream_id === state.selected ? "active" : ""}" data-id="${s.stream_id}">
      <div class="id">${escapeHtml(s.stream_id)}</div>
      <div class="meta">${s.pr ? "PR #" + s.pr : t("list.no_pr")} · ${escapeHtml(phaseLabel(s.visible_phase || s.phase))}</div>
      ${s.archived ? `<span class="badge">${escapeHtml(t("list.archived"))}</span>` : (s.obsolete ? `<span class="badge">${escapeHtml(t("list.superseded"))}</span>` : badge(s.attention))}
    </div>`).join("");
  box.querySelectorAll(".stream").forEach((el) => {
    el.onclick = () => select(el.dataset.id);
  });
}

function rail(stream) {
  const r = stream.rail || {};
  const names = ["GPT_SPEC", "IMPL", "AUDIT", "GPT_REVIEW", "GATE"];
  return `<div class="rail">${names.map((key, i) => {
    const st = r[key] || "waiting";
    return `${i ? '<div class="rail-join"></div>' : ""}<div class="rail-step st-${st}"><strong>${RAIL_STEP_ZH[key] || key}</strong><small>${RAIL_STATE_ZH[st] || st}</small></div>`;
  }).join("")}</div>`;
}

function rejectedBlock(stream) {
  const rows = stream.rejected_comments || [];
  if (!rows.length) return "";
  return `<div class="card">
    <h3>GitHub 同步</h3>
    <div class="muted">${t("main.last_sync")}：${escapeHtml((stream.github || {}).last_sync_at || t("main.never"))}</div>
    <div>${t("main.rejected")}：${rows.length}</div>
    <ul class="timeline">${rows.slice(-8).reverse().map((item) => {
      const recovered = item.status === "recovered";
      return `<li>
        Comment #${escapeHtml(item.comment_id || "—")}
        · ${recovered ? t("main.rejected_recovered") : t("main.rejected_status")}
        <div class="muted">${escapeHtml(item.reason || "")}</div>
        ${item.source_stream ? `<div class="muted">STREAM ${escapeHtml(item.source_stream)} → ${escapeHtml(item.expected_stream || "")}</div>` : ""}
      </li>`;
    }).join("")}</ul>
  </div>`;
}

function envelopeBlock(title, rec) {
  if (!rec) return `<div class="card"><h3>${title}</h3><div class="muted">${t("main.none_yet")}</div></div>`;
  const status = rec.status ? statusLabel(rec.status) : "—";
  return `<div class="card"><h3>${title} — ${escapeHtml(status)} @ ${(rec.head || "-").slice(0, 7)}</h3>
    <pre class="pre">${escapeHtml(rec.raw || rec.summary || "")}</pre></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function eventLabel(ev) {
  const kind = ev.kind || "";
  const raw = ev.raw || {};
  const mapped = EVENT_KIND_ZH[kind] || ev.label || kind;
  if (kind === "envelope") {
    const env = raw.envelope || "";
    const st = raw.status || "";
    return `${mapped}${env ? " " + env : ""}${st ? " — " + statusLabel(st) : ""}`;
  }
  if (kind === "invoke" || kind === "invoke_done") {
    const role = (raw.role || "").toUpperCase();
    return `${mapped}${role ? " · " + (ROLE_LABELS_ZH[role] || role) : ""}`;
  }
  return mapped;
}

function localizeApiMessage(msg) {
  if (!msg) return "";
  if (msg.startsWith("Step armed")) return t("toast.step_armed");
  if (msg.startsWith("No Codex step")) return t("toast.step_none");
  if (msg.startsWith("Workspace ready")) return t("toast.workspace_ready");
  if (msg.startsWith("Audit Current queued") || msg.includes("queued")) return t("audit.queued");
  return msg;
}

function renderMain(stream, events) {
  if (!stream) {
    $("main").innerHTML = `<div class="empty">${t("main.select")}</div>`;
    return;
  }
  const gh = stream.github || {};
  $("main").innerHTML = `
    <div class="kicker">${stream.attention === "needs_you" || stream.attention === "blocked" ? t("main.needs_you") : (stream.attention === "needs_gpt" ? t("main.needs_gpt") : t("main.stream"))}</div>
    <h1>${escapeHtml(stream.stream_id)}</h1>
    <div class="goal">${escapeHtml(stream.goal || t("main.no_goal"))}</div>
    ${campaignBlock(stream)}
    ${mergeReviewBlock(stream)}
    ${rail(stream)}
    <div class="kv">
      <span>${t("main.phase")}</span><div>${escapeHtml(phaseLabel(stream.visible_phase || stream.phase))}</div>
      <span>${t("main.pr")}</span><div>${stream.pr ? "#" + stream.pr : t("main.local_inbox")}</div>
      <span>${t("main.branch")}</span><div class="mono">${escapeHtml(stream.branch || "—")}</div>
      <span>${t("main.head")}</span><div class="mono">${escapeHtml(stream.head || "—")}</div>
      <span>${t("main.repair")}</span><div>${stream.repair_cycles}/${stream.max_repair_cycles}</div>
      <span>${t("main.authority")}</span><div class="mono">${escapeHtml(stream.latest_authority || "—")}</div>
      <span>${t("main.next")}</span><div>${escapeHtml(nextLabel(stream))}</div>
      <span>${t("main.blocker")}</span><div>${stream.blocker ? escapeHtml(stream.blocker) : t("main.none")}</div>
      <span>${t("main.github")}</span><div>${escapeHtml(githubLabel(stream))}</div>
      <span>${t("main.last_sync")}</span><div>${escapeHtml(gh.last_sync_at || t("main.never"))}</div>
      <span>${t("main.rejected")}</span><div>${(stream.rejected_comments || []).length || t("main.rejected_none")}</div>
      <span>${t("main.alias")}</span><div class="mono">${escapeHtml((stream.aliases || []).join(", ") || "—")}</div>
    </div>
    ${rejectedBlock(stream)}
    <div class="row">
      <button class="btn" data-act="pause">${t("actions.pause")}</button>
      <button class="btn" data-act="resume">${t("actions.resume")}</button>
      <button class="btn" data-act="step">${t("actions.step")}</button>
      <button class="btn primary" data-act="workspace">${t("actions.workspace")}</button>
      <button class="btn" data-act="audit">${t("actions.audit")}</button>
      <button class="btn" data-act="pr">${t("actions.pr")}</button>
      <button class="btn" data-act="sync">${t("actions.sync")}</button>
      <button class="btn" data-act="logs">${t("actions.logs")}</button>
      ${stream.archived ? `<button class="btn" data-act="unarchive">${t("actions.unarchive")}</button>` : ""}
      ${!stream.archived && stream.archivable ? `<button class="btn" data-act="archive">${t("actions.archive")}</button>` : ""}
      ${stream.purgeable ? `<button class="btn danger" data-act="purge">${t("actions.purge")}</button>` : ""}
    </div>
    ${envelopeBlock(t("main.envelopes_report"), (stream.envelopes || {}).CODEX_REPORT)}
    ${envelopeBlock(t("main.envelopes_audit"), (stream.envelopes || {}).CODEX_AUDIT)}
    <div class="card">
      <h3>${t("main.events")}</h3>
      <ul class="timeline">${(events || []).slice(0, 30).map((e) =>
        `<li><time>${escapeHtml((e.ts || "").slice(11, 16) || "")}</time>${escapeHtml(eventLabel(e))}${e.detail ? ` <span class="muted mono">${escapeHtml(e.detail)}</span>` : ""}</li>`
      ).join("") || `<li class="muted">${t("main.no_events")}</li>`}</ul>
    </div>
    <div class="card hidden" id="log-card">
      <div class="tabs">
        <button class="btn small" data-log="impl">${t("main.impl_log")}</button>
        <button class="btn small" data-log="audit">${t("main.audit_log")}</button>
        <button class="btn small" data-log="events">${t("main.event_log")}</button>
        <span class="muted log-hint">${t("main.logs")}</span>
        <button class="btn small" id="log-refresh">${t("main.refresh")}</button>
        <button class="btn small" id="log-copy">${t("main.copy")}</button>
        <label class="inline"><input type="checkbox" id="log-autoscroll" ${logState.autoScroll ? "checked" : ""}> ${t("main.autoscroll")}</label>
      </div>
      <pre class="pre" id="log-pre"></pre>
    </div>
  `;
  $("main").querySelectorAll("[data-act]").forEach((b) => b.onclick = () => act(b.dataset.act, stream));
  $("main").querySelectorAll("[data-log]").forEach((b) => b.onclick = () => loadLogs(stream.stream_id, b.dataset.log));
  const refreshBtn = $("log-refresh");
  const copyBtn = $("log-copy");
  const auto = $("log-autoscroll");
  if (refreshBtn) refreshBtn.onclick = () => loadLogs(stream.stream_id, logState.kind || "impl");
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const text = ($("log-pre") && $("log-pre").textContent) || "";
      try {
        await navigator.clipboard.writeText(text);
        toast(t("main.copied"));
      } catch (err) { toastError(err); }
    };
  }
  if (auto) auto.onchange = () => { logState.autoScroll = auto.checked; };
}

function renderBindings(stream, catalog) {
  if (!stream) {
    $("bindings").innerHTML = `<div class="empty">请选择一个任务。</div>`;
    return;
  }
  const gpt = stream.browser_gpt || {};
  const mergeGpt = stream.merge_gpt || {};
  const impl = stream.impl || {};
  const audit = stream.audit || {};
  $("bindings").innerHTML = `
    <div class="bind">
      <h3>${t("gpt.product_title")}</h3>
      ${gpt.bound ? `<div><strong>${escapeHtml(gpt.display_name || t("gpt.planning"))}</strong></div>
        <div class="muted">${escapeHtml(gpt.url || "")}</div>
        <div class="muted">${escapeHtml(gpt.note || "")}</div>
        <div>${t("gpt.bound")} · ${gpt.url ? t("gpt.session_url") : t("gpt.session_label")}</div>
        <div class="safe">${t("gpt.safe")}</div>
        <div class="muted">${t("gpt.safe_note")}</div>
        <div class="muted">${stream.pr ? t("gpt.durable_pr") + " #" + stream.pr : t("gpt.durable_local")}</div>
        <div class="row">
          <button class="btn small" data-b="open-gpt">${t("actions.open")}</button>
          <button class="btn small" data-b="rebind">${t("actions.rebind")}</button>
          <button class="btn small" data-b="clear-gpt">${t("actions.clear")}</button>
        </div>` : `<div>${t("gpt.unbound")}</div>
        <div class="muted">${t("gpt.keep")}</div>
        <div class="safe">${t("gpt.safe")}</div>
        <div class="muted">${t("gpt.safe_note")}</div>
        <div class="row"><button class="btn small primary" data-b="rebind">${t("actions.bind")}</button></div>`}
    </div>
    <div class="bind">
      <h3>${t("gpt.merge_title")}</h3>
      ${mergeGpt.url || mergeGpt.display_name ? `<div><strong>${escapeHtml(mergeGpt.display_name || t("gpt.merge_title"))}</strong></div>
        <div class="muted">${escapeHtml(mergeGpt.url || "")}</div>
        <div class="safe">${t("gpt.safe")}</div>
        <div class="muted">${t("gpt.merge_pending_hint")}</div>
        <div class="row">
          <button class="btn small" data-b="open-merge-gpt">${t("actions.open_merge_gpt")}</button>
          <button class="btn small" data-b="rebind-merge">${t("actions.rebind")}</button>
        </div>` : `<div>${t("gpt.unbound")}</div>
        <div class="muted">${t("gpt.merge_pending_hint")}</div>
        <div class="row"><button class="btn small primary" data-b="rebind-merge">${t("actions.bind_merge_gpt")}</button></div>`}
    </div>
    ${roleCard("impl", impl, stream, catalog)}
    ${roleCard("audit", audit, stream, catalog)}
  `;
  $("bindings").querySelectorAll("[data-b]").forEach((b) => b.onclick = () => bindAct(b.dataset.b, stream, catalog));
}

function publicationBlock(stream) {
  const pub = stream.publication || {};
  const status = pub.status || "idle";
  const failed = status === "failed" || (stream.impl && stream.impl.status === "IMPLEMENTATION_COMPLETE_PUBLICATION_FAILED");
  const implStatus = (stream.impl && stream.impl.status) || "-";
  const baseline = (pub.baseline_head || "").slice(0, 7) || "—";
  const commit = (pub.commit || (stream.heads && stream.heads.implemented) || "");
  const headLine = commit ? `${baseline} → ${commit.slice(0, 12)}` : `${baseline} → ${t("pub.pending")}`;
  const validation = failed ? t("pub.na") : (status === "pushed" || status === "committed" ? t("pub.pass") : (status === "committing" ? t("pub.running") : "—"));
  return `<div class="card pub-card">
    <h3>${t("pub.title")}</h3>
    <div>${t("pub.codex")}：${escapeHtml(statusLabel(implStatus))}</div>
    <div>${t("pub.validation")}：${escapeHtml(validation)}</div>
    <div>${t("pub.status")}：<strong>${escapeHtml(PUB_STATUS_ZH[status] || status)}</strong> <span class="muted">（${escapeHtml(status)}）</span></div>
    <div>${t("pub.head")}：<span class="mono">${escapeHtml(headLine)}</span></div>
    <div class="muted">${t("pub.implemented")}：<span class="mono">${escapeHtml((stream.heads && stream.heads.implemented) || "—")}</span></div>
    ${failed ? `<div class="err">${t("pub.not_ready")}</div>` : ""}
    ${pub.reason ? `<div class="${failed ? "err" : "muted"}">${t("pub.reason")}：${escapeHtml(pub.reason)}</div>` : ""}
    ${failed ? `<div class="row"><button class="btn small" data-b="recover-pub">${t("pub.recover")}</button></div>` : ""}
  </div>`;
}

function campaignBlock(stream) {
  const camp = stream.campaign;
  if (!camp) return "";
  const completed = !!camp.unit_completed;
  const current = camp.current_unit || stream.stream_id;
  const next = completed ? t("main.queue_empty") : (camp.next_stream || current);
  const wait = camp.wait_reason || (stream.merge_review && stream.merge_review.wait_reason) || "";
  const suggest = (stream.gpt_suggestion && stream.gpt_suggestion.text) || "";
  return `<div class="card">
    <h3>${t("main.campaign")} · ${escapeHtml(camp.campaign_id || "—")}</h3>
    <div>${escapeHtml(statusLabel(camp.status || "—"))}</div>
    <div>${t("main.current_unit")}：<span class="mono">${escapeHtml(current || "—")}</span> · ${escapeHtml(phaseLabel(camp.current_phase || stream.phase))}</div>
    <div>${t("main.next_unit")}：<span class="mono">${escapeHtml(next)}</span></div>
    ${wait ? `<div>${t("main.wait_reason")}：${escapeHtml(statusLabel(wait))}</div>` : ""}
    ${suggest ? `<div>${t("main.gpt_suggest")}：<strong>${escapeHtml(suggest)}</strong></div>` : ""}
    ${completed && camp.reason ? `<div class="muted">${escapeHtml(camp.reason)}</div>` : ""}
  </div>`;
}

function mergeReviewBlock(stream) {
  const card = stream.merge_review || {};
  const phase = stream.phase || "";
  if (!["FINAL_GATE", "MERGE_PENDING", "MERGE_RETRYABLE_FAILED", "READY_FOR_GPT", "IMPLEMENTING", "AUDITING"].includes(phase)) {
    return "";
  }
  const enabled = !!card.enabled;
  const suggest = (stream.gpt_suggestion && stream.gpt_suggestion.text) || card.suggestion || "";
  const reasons = card.disabled_reasons || [];
  const checks = card.checks || [];
  const retry = phase === "MERGE_PENDING" || phase === "MERGE_RETRYABLE_FAILED";
  const mergeablePhase = phase === "FINAL_GATE";
  return `<div class="card">
    <h3>${t("gpt.merge_review")}</h3>
    <div>${t("gpt.product_title")}：${escapeHtml(card.product_label || "—")}</div>
    <div class="muted">${escapeHtml(card.product_detail || "")}</div>
    <div>${t("gpt.merge_title")}：${escapeHtml(statusLabel(card.merge_status || "pending"))}</div>
    <div>${t("main.gpt_suggest")}：<strong>${escapeHtml(suggest)}</strong></div>
    <div class="muted">${t("main.head")}：<span class="mono">${escapeHtml((card.expected_head || stream.head || "").slice(0, 12))}</span> · PR #${escapeHtml(String(card.pr || stream.pr || "—"))}</div>
    ${checks.map((c) => `<div>${c.ok ? "✓" : "○"} ${escapeHtml(c.label)}</div>`).join("")}
    ${card.findings ? `<pre class="pre">${escapeHtml(card.findings)}</pre>` : ""}
    ${reasons.length ? `<div class="muted">${escapeHtml(reasons.join("；"))}</div>` : ""}
    <div class="muted">${t("gpt.merge_pending_hint")}</div>
    <div class="row">
      <button class="btn primary" data-act="${retry ? "retry-merge" : "pass-and-merge"}" ${(enabled && mergeablePhase) || (retry && card.retry_enabled) ? "" : "disabled"}>${retry ? t("actions.retry_merge") : t("actions.pass_and_merge")}</button>
      <button class="btn" data-act="pr">${t("actions.pr")}</button>
      ${phase === "FINAL_GATE" ? `<button class="btn" data-act="open-merge-gpt">${t("actions.open_merge_gpt")}</button>` : ""}
      ${phase === "FINAL_GATE" ? `<button class="btn" data-act="copy-merge-prompt">${t("actions.copy_merge_prompt")}</button>` : ""}
    </div>
  </div>`;
}

function optionList(values, current) {
  const opts = ["", ...values];
  return opts.map((v) => `<option value="${escapeHtml(v)}" ${String(current || "") === v ? "selected" : ""}>${v || t("role.inherit")}</option>`).join("");
}

function roleCard(name, role, stream, catalog) {
  const key = name;
  const eff = role.effective || {};
  const crashed = role.terminal === "RECOVERY_REQUIRED";
  const models = (catalog && catalog.models || []).map((m) => m.slug);
  const efforts = (catalog && catalog.efforts) || ["none", "low", "medium", "high", "xhigh", "max"];
  const ultraOk = catalog && catalog.ultra && catalog.ultra.supported;
  const execModes = ultraOk ? ["standard", "ultra"] : ["standard"];
  const isImpl = name === "impl";
  const effectiveMode = (eff.effective_execution_mode || role.execution_mode || "standard");
  const execLabel = effectiveMode === "ultra" ? t("role.execution_ultra") : t("role.execution_standard");
  const inv = (eff.invocation || []).join(" ");
  return `<div class="bind">
    <h3>${isImpl ? t("role.impl_title") : t("role.audit_title")}</h3>
    <div><span class="dot ${role.terminal === "RUNNING" || role.terminal === "WAITING" ? "on" : ""}"></span>${escapeHtml(statusLabel(role.terminal || "CLOSED"))}</div>
    <div class="muted">${t("role.state")}：${escapeHtml(statusLabel(role.status || "-"))} · ${escapeHtml(statusLabel(role.process || ""))}</div>
    <label>${isImpl ? t("role.impl_model") : t("role.audit_model")}</label>
    <select data-cfg="${key}-model">${optionList(models, role.model)}</select>
    <div class="muted">${t("role.effective")}：<span class="mono">${escapeHtml(eff.model || "—")}</span> · ${t("role.source")}：${escapeHtml(sourceLabel(eff.model_source))}</div>
    <label>${t("role.effort")}</label>
    <select data-cfg="${key}-effort">${optionList(efforts, role.effort)}</select>
    <div class="muted">${t("role.effective")}：<span class="mono">${escapeHtml(eff.effort || "—")}</span> · ${t("role.source")}：${escapeHtml(sourceLabel(eff.effort_source))}</div>
    <label>${t("role.execution_mode")}</label>
    <select data-cfg="${key}-exec">${optionList(execModes, effectiveMode === "ultra" ? "ultra" : "standard")}</select>
    ${ultraOk ? "" : `<div class="muted" title="${escapeHtml(t("role.ultra_tip"))}">${t("role.ultra_disabled")}</div>`}
    <div class="muted">${t("role.execution_mode")}：${escapeHtml(execLabel)}</div>
    <div class="muted">Ultra：${ultraOk ? "可用" : t("role.ultra_unsupported")}</div>
    <div class="muted">${t("role.invocation")}：<span class="mono">${escapeHtml(inv || "—")}</span></div>
    <label>${t("role.profile")}</label>
    <input data-cfg="${key}-profile" value="${escapeHtml(role.profile || "")}" placeholder="${t("role.inherit")}">
    <div class="muted">${t("role.sandbox")}：<span class="mono">${escapeHtml(role.sandbox || "—")}</span> · ${t("role.applies")}</div>
    ${isImpl ? publicationBlock(stream) : ""}
    <div class="muted">${t("role.pid")} ${role.pid || "—"} · HEAD <span class="mono">${stream.head_short || "-"}</span></div>
    <div class="muted mono">${escapeHtml(role.worktree || t("role.no_worktree"))}</div>
    ${crashed ? `<div class="err">⚠ ${t("role.recovery")}（RECOVERY_REQUIRED）</div>` : ""}
    <div class="row">
      <button class="btn small" data-b="save-${key}">${t("role.save")}</button>
      <button class="btn small" data-b="open-${key}">${role.terminal === "CLOSED" ? t("actions.reopen") : t("actions.open")}</button>
      <button class="btn small" data-b="focus-${key}">${t("actions.focus")}</button>
      <button class="btn small" data-b="logs-${key}">${isImpl ? t("main.impl_log") : t("main.audit_log")}</button>
    </div>
  </div>`;
}

async function select(id) {
  state.selected = id;
  const [stream, ev, catalog] = await Promise.all([
    api(`/api/streams/${id}`),
    api(`/api/streams/${id}/events?limit=80`),
    state.catalog ? Promise.resolve(state.catalog) : api("/api/models"),
  ]);
  state.catalog = catalog;
  state.events = ev.events || [];
  renderList(state.overview);
  renderMain(stream, state.events);
  renderBindings(stream, catalog);
}

function auditReasonZh(preview) {
  const reason = preview.reason || "";
  if (/!= current HEAD|Refuse to silently/i.test(reason)) return t("audit.mismatch");
  if (/matches the current implementation HEAD/i.test(reason)) return "目标提交与当前实现 HEAD 一致。";
  if (/No auditable IMPLEMENTED_HEAD/i.test(reason)) return "没有可审计的实现提交。请先完成实现。";
  if (/using explicit PR HEAD/i.test(reason)) return "没有实现提交，使用明确指定的 PR HEAD。";
  return reason;
}

async function auditModal(stream) {
  const preview = await api(`/api/streams/${stream.stream_id}/audit-current`);
  const audit = stream.audit || {};
  const eff = audit.effective || {};
  showModal(`
    <h2>${t("audit.title")}</h2>
    <p>${t("audit.help")}</p>
    <div class="kv">
      <span>${t("audit.allowed")}</span><div>${preview.ok ? t("audit.yes") : t("audit.no")}</div>
      <span>${t("audit.target")}</span><div class="mono">${escapeHtml(preview.target || "—")}</div>
      <span>${t("audit.source")}</span><div>${escapeHtml(sourceLabel(preview.source, "—"))}</div>
      <span>${t("audit.model")}</span><div class="mono">${escapeHtml(eff.model || audit.model || "—")}</div>
      <span>${t("audit.effort")}</span><div class="mono">${escapeHtml(eff.effort || audit.effort || "—")}</div>
      <span>${t("audit.sandbox")}</span><div class="mono">${escapeHtml(audit.sandbox || "read-only")}</div>
    </div>
    <p class="${preview.ok ? "muted" : "err"}">${escapeHtml(auditReasonZh(preview))}</p>
    ${preview.reason && auditReasonZh(preview) !== preview.reason ? `<p class="muted tech">${t("err.detail")}：${escapeHtml(preview.reason)}</p>` : ""}
    <div class="row">
      <button class="btn primary" id="m-save" ${preview.ok ? "" : "disabled"}>${t("audit.start_audit")}</button>
      <button class="btn" id="m-cancel">${t("actions.cancel")}</button>
    </div>`);
  $("m-cancel").onclick = hideModal;
  $("m-save").onclick = async () => {
    try {
      await post(`/api/streams/${stream.stream_id}/audit-current`, { target: preview.target });
      hideModal();
      toast(t("audit.queued"));
      await refresh();
    } catch (err) { toastError(err); }
  };
}

function applyHandoffs(overview) {
  state.openedGens = state.openedGens || {};
  for (const item of overview.handoffs || []) {
    const gen = item.generation || item.stream_id;
    if (item.open_once && item.url && !state.openedGens[gen]) {
      state.openedGens[gen] = true;
      window.open(item.url, "_blank");
    }
  }
}

async function refresh() {
  state.overview = await api("/api/overview" + (state.showArchived ? "?include_archived=1" : ""));
  applyHandoffs(state.overview);
  renderCounts(state.overview);
  renderList(state.overview);
  if (state.selected) {
    const still = (state.overview.streams || []).some((s) => s.stream_id === state.selected);
    if (still) await select(state.selected);
  } else if ((state.overview.needs_you || []).length) {
    await select(state.overview.needs_you[0].stream_id);
  } else if ((state.overview.streams || []).length) {
    await select(state.overview.streams[0].stream_id);
  } else {
    renderMain(null);
    renderBindings(null);
  }
}

async function act(name, stream) {
  try {
    if (name === "pause") await post(`/api/streams/${stream.stream_id}/pause`, {});
    if (name === "resume") await post(`/api/streams/${stream.stream_id}/resume`, {});
    if (name === "step") {
      const r = await post(`/api/streams/${stream.stream_id}/step`, {});
      toast(localizeApiMessage(r.message) || t("actions.step"));
    }
    if (name === "sync") {
      const r = await post("/api/sync", {});
      if (r.ok === false) {
        const err = new Error(r.detail || r.error || "Sync failed");
        err.detail = r.detail || r.error;
        throw err;
      }
      const notes = (r.notes || (r.results || []).flatMap((item) => item.notes || [])).join("; ");
      toast(t("toast.synced"), notes || (r.synced || []).join(", ") || undefined);
    }
    if (name === "archive") {
      if (!stream.archivable) { toast(stream.archive_reason || t("actions.archive")); return; }
      if (!window.confirm(t("actions.archive_confirm"))) return;
      const r = await post(`/api/streams/${stream.stream_id}/archive`, {});
      toast(t("toast.archived"), r.stream_id);
      if (!state.showArchived) state.selected = null;
    }
    if (name === "unarchive") {
      await post(`/api/streams/${stream.stream_id}/unarchive`, {});
      toast(t("toast.unarchived"), stream.stream_id);
    }
    if (name === "purge") {
      if (!stream.purgeable) { toast(stream.purge_reason || t("actions.purge")); return; }
      if (!window.confirm(t("actions.purge_confirm"))) return;
      const r = await post(`/api/streams/${stream.stream_id}/purge`, { confirm: true });
      toast(t("toast.purged"), r.stream_id);
      state.selected = null;
    }
    if (name === "delete") {
      if (!stream.archivable) { toast(stream.archive_reason || t("actions.archive")); return; }
      if (!window.confirm(t("actions.archive_confirm"))) return;
      const r = await post(`/api/streams/${stream.stream_id}/archive`, {});
      toast(t("toast.archived"), r.stream_id);
      if (!state.showArchived) state.selected = null;
    }
    if (name === "audit") return auditModal(stream);
    if (name === "workspace") {
      const r = await post(`/api/streams/${stream.stream_id}/workspace`, {});
      if (r.browser_url) window.open(r.browser_url, "_blank");
      const extra = r.browser_url ? "" : t("toast.workspace_unbound");
      toast(localizeApiMessage(r.message) || t("actions.workspace"), extra || undefined);
    }
    if (name === "pr") {
      if (!stream.pr_url) { toast(t("toast.no_pr")); return; }
      window.open(stream.pr_url, "_blank");
      return;
    }
    if (name === "pass-and-merge") {
      if (!(stream.merge_review && stream.merge_review.enabled)) { toast(t("actions.pass_and_merge")); return; }
      const r = await post(`/api/streams/${stream.stream_id}/pass-and-merge`, {
        expected_head: stream.merge_review.expected_head || stream.head,
        pr: stream.pr,
      });
      toast(r.merged ? t("gpt.suggest_merged") : (r.reason || t("actions.pass_and_merge")), r.merge_commit || r.code);
    }
    if (name === "retry-merge") {
      const r = await post(`/api/streams/${stream.stream_id}/retry-merge`, {
        expected_head: stream.merge_review && stream.merge_review.expected_head || stream.head,
        pr: stream.pr,
      });
      toast(r.merged ? t("gpt.suggest_merged") : (r.reason || t("actions.retry_merge")), r.merge_commit || r.code);
    }
    if (name === "open-merge-gpt") {
      const r = await post(`/api/streams/${stream.stream_id}/open-merge-gpt`, {});
      if (r.url) window.open(r.url, "_blank");
      toast(t("actions.open_merge_gpt"), t("gpt.merge_pending_hint"));
      return;
    }
    if (name === "copy-merge-prompt") {
      const r = await api(`/api/streams/${stream.stream_id}/merge-prompt`);
      try {
        await navigator.clipboard.writeText(r.text || "");
        toast(t("main.copied"));
      } catch (err) { toastError(err); }
      return;
    }
    if (name === "logs") {
      $("log-card").classList.remove("hidden");
      await loadLogs(stream.stream_id, "impl");
      return;
    }
    await refresh();
  } catch (err) { toastError(err); }
}

async function bindAct(name, stream, catalog) {
  try {
    if (name === "open-gpt") {
      if (!stream.browser_gpt.url) { toast(t("toast.no_url")); return; }
      window.open(stream.browser_gpt.url, "_blank");
      return;
    }
    if (name === "clear-gpt") {
      await post(`/api/streams/${stream.stream_id}/unbind-gpt`, {});
      toast(t("toast.cleared"));
    }
    if (name === "rebind") return bindModal(stream);
    if (name === "rebind-merge") return bindMergeModal(stream);
    if (name === "open-merge-gpt") {
      const url = (stream.merge_gpt || {}).url;
      if (!url) { toast(t("toast.no_url")); return; }
      window.open(url, "_blank");
      toast(t("actions.open_merge_gpt"), t("gpt.merge_pending_hint"));
      return;
    }
    if (name.startsWith("open-")) {
      await post(`/api/streams/${stream.stream_id}/open-terminal`, { role: name.slice(5) });
      toast(t("toast.konsole"));
    }
    if (name.startsWith("focus-")) {
      try {
        await post(`/api/streams/${stream.stream_id}/focus-terminal`, { role: name.slice(6) });
        toast(t("toast.focus"));
      } catch (err) {
        toastError(err);
        toast(t("toast.focus_fail"), err.message);
      }
    }
    if (name.startsWith("logs-")) {
      $("log-card") && $("log-card").classList.remove("hidden");
      await loadLogs(stream.stream_id, name.slice(5));
      return;
    }
    if (name === "recover-pub") {
      const r = await post(`/api/streams/${stream.stream_id}/publish`, { recover: true });
      toast(r.commit ? `${t("toast.published")} ${r.commit.slice(0, 12)}` : (r.error || t("toast.published")));
    }
    if (name.startsWith("save-")) {
      const role = name.slice(5);
      const model = document.querySelector(`[data-cfg="${role}-model"]`).value;
      const effort = document.querySelector(`[data-cfg="${role}-effort"]`).value;
      const execEl = document.querySelector(`[data-cfg="${role}-exec"]`);
      const execution_mode = execEl ? execEl.value : "standard";
      const profile = document.querySelector(`[data-cfg="${role}-profile"]`).value;
      await post(`/api/streams/${stream.stream_id}/model`, {
        role,
        model,
        effort,
        execution_mode,
        profile,
        inherit_model: !model,
        inherit_effort: !effort,
        inherit_execution_mode: !execution_mode || execution_mode === "standard",
        inherit_profile: !profile,
      });
      toast(`${ROLE_LABELS_ZH[role] || role} ${t("toast.saved")}`);
    }
    await refresh();
  } catch (err) { toastError(err); }
}

async function loadLogs(id, kind) {
  logState.stream = id;
  logState.kind = kind;
  const data = await api(`/api/streams/${id}/logs?kind=${kind}&lines=250`);
  const card = $("log-card");
  if (card) card.classList.remove("hidden");
  const pre = $("log-pre");
  if (pre) {
    pre.textContent = data.text || t("main.empty_log");
    if (logState.autoScroll) pre.scrollTop = pre.scrollHeight;
  }
}

function bindMergeModal(stream) {
  const g = stream.merge_gpt || {};
  showModal(`
    <h2>${t("actions.bind_merge_gpt")}</h2>
    <p class="muted">${t("gpt.bind_help")}</p>
    <label>${t("gpt.display_name")}</label>
    <input id="m-name" value="${escapeHtml(g.display_name || "")}" placeholder="${t("gpt.merge_title")}">
    <label>${t("gpt.url")}</label>
    <input id="m-url" value="${escapeHtml(g.url || "")}" placeholder="https://chatgpt.com/...">
    <label>${t("gpt.note")}</label>
    <input id="m-note" value="${escapeHtml(g.note || "")}">
    <div class="row">
      <button class="btn primary" id="m-save">${t("gpt.save")}</button>
      <button class="btn" id="m-cancel">${t("actions.cancel")}</button>
    </div>`);
  $("m-cancel").onclick = hideModal;
  $("m-save").onclick = async () => {
    try {
      await post(`/api/streams/${stream.stream_id}/bind-merge-gpt`, {
        display_name: $("m-name").value,
        url: $("m-url").value,
        note: $("m-note").value,
        campaign: true,
      });
      hideModal();
      await refresh();
    } catch (err) { toastError(err); }
  };
}

function bindModal(stream) {
  showModal(`
    <h2>${t("gpt.bind_title")}</h2>
    <p class="muted">${t("gpt.bind_help")}</p>
    <label>${t("gpt.display_name")}</label>
    <input id="m-name" value="${escapeHtml(stream.browser_gpt.display_name || "")}" placeholder="${t("gpt.placeholder_name")}">
    <label>${t("gpt.url")}</label>
    <input id="m-url" value="${escapeHtml(stream.browser_gpt.url || "")}" placeholder="https://chatgpt.com/...">
    <label>${t("gpt.note")}</label>
    <input id="m-note" value="${escapeHtml(stream.browser_gpt.note || "")}">
    <div class="row">
      <button class="btn primary" id="m-save">${t("gpt.save")}</button>
      <button class="btn" id="m-cancel">${t("actions.cancel")}</button>
    </div>`);
  $("m-cancel").onclick = hideModal;
  $("m-save").onclick = async () => {
    try {
      await post(`/api/streams/${stream.stream_id}/bind-gpt`, {
        display_name: $("m-name").value,
        url: $("m-url").value,
        note: $("m-note").value,
      });
      hideModal();
      await refresh();
    } catch (err) { toastError(err); }
  };
}

function showModal(html) {
  const el = $("modal");
  el.innerHTML = `<div class="modal">${html}</div>`;
  el.classList.remove("hidden");
  el.onclick = (ev) => { if (ev.target === el) hideModal(); };
}
function hideModal() { $("modal").classList.add("hidden"); $("modal").innerHTML = ""; }

async function newStream() {
  const catalog = await api("/api/models");
  const models = (catalog.models || []).map((m) => m.slug);
  const opts = models.map((m) => `<option value="${m}">`).join("");
  const effortOpts = (catalog.efforts || []).map((e) => `<option>${e}</option>`).join("");
  showModal(`
    <h2>${t("wizard.title")}</h2>
    <label>${t("wizard.id")}</label><input id="n-id" placeholder="p7-9a">
    <label>${t("wizard.pr")}</label><input id="n-pr" placeholder="24">
    <label>${t("wizard.goal")}</label><input id="n-goal">
    <label>${t("wizard.worktree")}</label>
    <select id="n-wt">
      <option value="create">${t("wizard.create")}</option>
      <option value="existing">${t("wizard.existing")}</option>
      <option value="none">${t("wizard.none")}</option>
    </select>
    <input id="n-wtpath" class="hidden" placeholder="/path/to/worktree">
    <div class="grid2">
      <div><label>${t("role.impl_model")}</label><input id="n-im" list="n-models" placeholder="${t("role.inherit")}"><datalist id="n-models">${opts}</datalist></div>
      <div><label>${t("role.effort")}（IMPL）</label><select id="n-ie"><option value="">${t("role.inherit")}</option>${effortOpts}</select></div>
      <div><label>${t("role.audit_model")}</label><input id="n-am" list="n-models" placeholder="${t("role.inherit")}"></div>
      <div><label>${t("role.effort")}（AUDIT）</label><select id="n-ae"><option value="">${t("role.inherit")}</option>${effortOpts}</select></div>
    </div>
    <label>${t("wizard.name")}</label><input id="n-bn" placeholder="${t("gpt.placeholder_name")}">
    <label>${t("wizard.url")}</label><input id="n-bu" placeholder="https://chatgpt.com/...">
    <div class="row">
      <button class="btn primary" id="n-go">${t("actions.create_ws")}</button>
      <button class="btn" id="n-just">${t("actions.create_only")}</button>
      <button class="btn" id="n-cancel">${t("actions.cancel")}</button>
    </div>`);
  $("n-wt").onchange = () => $("n-wtpath").classList.toggle("hidden", $("n-wt").value !== "existing");
  $("n-cancel").onclick = hideModal;
  const submit = async (openWs) => {
    try {
      const id = ($("n-id").value || "").trim();
      if (!id) { toast(t("wizard.need_id")); return; }
      if ($("n-wt").value === "existing" && !($("n-wtpath").value || "").trim()) {
        toast(t("wizard.need_path"));
        return;
      }
      const body = {
        stream: id,
        pr: $("n-pr").value,
        goal: $("n-goal").value,
        create_worktree: $("n-wt").value === "create",
        worktree: $("n-wt").value === "existing" ? $("n-wtpath").value : "",
        impl_model: $("n-im").value,
        impl_effort: $("n-ie").value,
        audit_model: $("n-am").value,
        audit_effort: $("n-ae").value,
        browser_name: $("n-bn").value,
        browser_url: $("n-bu").value,
      };
      const created = await post("/api/streams", body);
      hideModal();
      state.selected = created.stream.stream_id;
      if (openWs) {
        const r = await post(`/api/streams/${state.selected}/workspace`, {});
        if (r.browser_url) window.open(r.browser_url, "_blank");
      }
      await refresh();
    } catch (err) { toastError(err); }
  };
  $("n-go").onclick = () => submit(true);
  $("n-just").onclick = () => submit(false);
}

function startLive() {
  if (live) live.close();
  live = new EventSource("/api/live");
  live.onmessage = (ev) => {
    try { state.overview = JSON.parse(ev.data); } catch { return; }
    renderCounts(state.overview);
    renderList(state.overview);
  };
  live.onerror = () => {
    live.close();
    live = null;
    setTimeout(startLive, 3000);
  };
}

$("btn-new").onclick = newStream;
$("btn-needs").onclick = () => { state.filterNeeds = !state.filterNeeds; $("btn-needs").classList.toggle("primary", state.filterNeeds); renderList(state.overview || { streams: [] }); };
$("btn-archived").onclick = async () => {
  state.showArchived = !state.showArchived;
  $("btn-archived").classList.toggle("primary", state.showArchived);
  await refresh();
};
$("btn-sync").onclick = async () => {
  try {
    const r = await post("/api/sync", {});
    const notes = (r.notes || (r.results || []).flatMap((item) => item.notes || [])).join("; ");
    toast(t("toast.synced"), notes || (r.synced || []).join(", ") || undefined);
    await refresh();
  } catch (err) { toastError(err); }
};

refresh().catch((err) => toastError(err));
startLive();
setInterval(() => { if (!live) refresh().catch(() => {}); }, 4000);
