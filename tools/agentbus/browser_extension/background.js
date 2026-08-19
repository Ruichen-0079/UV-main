"use strict";

const JOBS_URL = "http://127.0.0.1:6738/api/browser/jobs";
const POLL_MS = 10000;
const MIN_SUBMIT_INTERVAL_MS = 20000;
const COMPOSER_RETRY_MS = 10000;
const SHORT_BACKOFF_MS = [60000, 120000, 300000];
const LONG_BACKOFF_MS = [60000, 120000, 300000, 900000, 1800000];
const WAITING_FOR_GITHUB_WATCHDOG_MS = 300000;
const VISIBLE_SUBMISSION_BACKOFF_MS = [300000, 900000, 1800000];
let ticking = false;

function now() { return Date.now(); }
function jitter(ms) { return ms + Math.floor(ms * (Math.random() * 0.16 - 0.08)); }

async function loadScheduler() {
  const saved = await browser.storage.local.get(["jobs", "lastSubmitAt", "bridgeStatus"]);
  return {
    jobs: saved.jobs || {},
    lastSubmitAt: saved.lastSubmitAt || 0,
    bridgeStatus: saved.bridgeStatus || "ONLINE"
  };
}

async function saveScheduler(state) {
  await browser.storage.local.set({
    jobs: state.jobs,
    lastSubmitAt: state.lastSubmitAt,
    bridgeStatus: state.bridgeStatus || "ONLINE",
    schedulerStatus: bridgeProjection(state)
  });
}

function schedulerProjection(state) {
  const active = Object.entries(state.jobs || {})
    .filter(([, record]) => record && record.state !== "DONE")
    .sort(([, left], [, right]) => (left.updatedAt || left.createdAt || 0) - (right.updatedAt || right.createdAt || 0))[0];
  if (!active) return null;
  const [jobId, record] = active;
  return {
    job_id: jobId,
    role: record.role || null,
    task: record.task || null,
    state: record.state,
    attempts: record.attempts || 0,
    submitted_at: record.submittedAt || null,
    next_attempt_at: record.nextAttemptAt || record.nextWatchdogAt || null,
    last_error: record.lastError || null
  };
}

function bridgeProjection(state) {
  const job = schedulerProjection(state);
  const authRequired = Object.values(state.jobs || {}).some((record) => record && record.state === "AUTH_REQUIRED");
  const bridge = authRequired
    ? "AUTH_REQUIRED"
    : (state.bridgeStatus || "ONLINE");
  return { bridge, job };
}

function normalizedUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch (_) {
    return value;
  }
}

async function findConversationTab(url) {
  const wanted = normalizedUrl(url);
  const tabs = await browser.tabs.query({ url: "https://chatgpt.com/*" });
  return tabs.find((tab) => normalizedUrl(tab.url || "") === wanted) || null;
}

async function ensureConversationTab(url) {
  const existing = await findConversationTab(url);
  if (existing) return existing;
  // Intentionally inactive: the bridge never brings Firefox or a tab forward.
  return browser.tabs.create({ url, active: false });
}

async function waitUntilLoaded(tabId, timeoutMs = 30000) {
  const started = now();
  while (now() - started < timeoutMs) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === "complete") return true;
    } catch (_) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function scheduleBackoff(record, longBackoff) {
  const series = longBackoff ? LONG_BACKOFF_MS : SHORT_BACKOFF_MS;
  const attempt = Math.min(record.attempts || 0, series.length - 1);
  record.state = "BACKOFF";
  record.nextAttemptAt = now() + jitter(series[attempt]);
  record.attempts = (record.attempts || 0) + 1;
  record.nextWatchdogAt = null;
}

function scheduleComposerRetry(record) {
  record.state = "BACKOFF";
  record.nextAttemptAt = now() + jitter(COMPOSER_RETRY_MS);
  record.attempts = (record.attempts || 0) + 1;
  record.nextWatchdogAt = null;
}

function scheduleAuthRetry(record) {
  // Keep the durable server job queued while login is unavailable. The
  // bounded retry is local extension state, so recovery never duplicates a
  // submission of the same job.
  record.state = "AUTH_REQUIRED";
  record.nextAttemptAt = now() + jitter(LONG_BACKOFF_MS[0]);
  record.attempts = (record.attempts || 0) + 1;
  record.nextWatchdogAt = null;
}

function markWaitingForGithub(record, timestamp = now(), reason = null) {
  record.state = "WAITING_FOR_GITHUB";
  record.submittedAt = record.submittedAt || timestamp;
  record.attemptedAt = null;
  record.updatedAt = timestamp;
  record.nextAttemptAt = null;
  record.nextWatchdogAt = timestamp + WAITING_FOR_GITHUB_WATCHDOG_MS;
  record.watchdogAttempts = 0;
  record.lastError = reason;
}

function waitingWatchdogDue(record, timestamp = now()) {
  if (!record || record.state !== "WAITING_FOR_GITHUB") return false;
  const submittedAt = Number(record.submittedAt || record.updatedAt || record.createdAt || 0);
  // A legacy/corrupt record without timestamps must not become a permanent
  // WAITING_FOR_GITHUB tombstone.  Recheck it immediately and let the normal
  // visible-submission or safe-retry path repair the record.
  const deadline = Number(
    record.nextWatchdogAt || (submittedAt ? submittedAt + WAITING_FOR_GITHUB_WATCHDOG_MS : 0)
  );
  return timestamp >= deadline;
}

function markVisibleSubmissionWaiting(record, timestamp = now()) {
  const index = Math.min(record.watchdogAttempts || 0, VISIBLE_SUBMISSION_BACKOFF_MS.length - 1);
  record.state = "WAITING_FOR_GITHUB";
  record.updatedAt = timestamp;
  record.nextAttemptAt = null;
  record.nextWatchdogAt = timestamp + jitter(VISIBLE_SUBMISSION_BACKOFF_MS[index]);
  record.watchdogAttempts = (record.watchdogAttempts || 0) + 1;
  record.lastError = "SUBMITTED_VISIBLE_WAITING_GITHUB";
}

async function submit(job, scheduler) {
  const record = scheduler.jobs[job.job_id];
  record.state = "SUBMITTING";
  record.updatedAt = now();
  await saveScheduler(scheduler);
  try {
    const tab = await ensureConversationTab(job.conversation_url);
    if (!tab || !(await waitUntilLoaded(tab.id))) {
      scheduleBackoff(record, false);
      record.lastError = "TAB_NOT_READY";
      return;
    }
    const response = await browser.tabs.sendMessage(tab.id, {
      type: "AGENTBUS_SUBMIT",
      job_id: job.job_id,
      prompt: job.prompt
    });
    const code = response && response.code || "COMPOSER_NOT_READY";
    if (code === "SUBMITTED_CONFIRMED") {
      scheduler.lastSubmitAt = now();
      record.submittedAt = scheduler.lastSubmitAt;
      markWaitingForGithub(record, scheduler.lastSubmitAt);
      record.lastEvidence = response.evidence || null;
      return;
    }
    if (code === "ALREADY_SUBMITTED_VISIBLE") {
      markWaitingForGithub(record, record.submittedAt || now(), code);
      record.lastEvidence = "USER_TURN";
      return;
    }
    if (code === "SUBMIT_NOT_CONFIRMED") {
      // A click was attempted even though semantic confirmation failed. Keep
      // the global submission interval so the bounded backoff cannot burst
      // repeated user turns.
      scheduler.lastSubmitAt = now();
      record.attemptedAt = scheduler.lastSubmitAt;
    }
    record.lastError = code;
    if (code === "AUTH_REQUIRED") {
      scheduleAuthRetry(record);
    } else if (code === "COMPOSER_NOT_READY" || code === "COMPOSER_NOT_FOUND") {
      scheduleComposerRetry(record);
    } else {
      scheduleBackoff(record, code === "BROWSER_CAPACITY");
    }
  } catch (error) {
    scheduler.lastSubmitAt = now();
    record.attemptedAt = scheduler.lastSubmitAt;
    record.lastError = String(error).slice(0, 300);
    scheduleBackoff(record, false);
  } finally {
    await saveScheduler(scheduler);
  }
}

async function exactJobVisibleInConversation(job) {
  if (!job || !job.conversation_url || !job.job_id) return false;
  const tab = await findConversationTab(job.conversation_url);
  if (!tab || !(await waitUntilLoaded(tab.id, 10000))) return false;
  try {
    const response = await browser.tabs.sendMessage(tab.id, {
      type: "AGENTBUS_CHECK_JOB",
      job_id: job.job_id
    });
    return Boolean(response && response.visible && response.code === "ALREADY_SUBMITTED_VISIBLE");
  } catch (_) {
    return false;
  }
}

async function watchdogWaitingForGithub(job, record) {
  if (!waitingWatchdogDue(record)) return false;
  if (await exactJobVisibleInConversation(job)) {
    markVisibleSubmissionWaiting(record);
    return true;
  }
  // The exact prompt is no longer visible in its bound conversation.  A safe
  // retry of this same job/generation is preferable to an unbounded local
  // WAITING_FOR_GITHUB state; no new job id or prompt is minted here.
  record.submittedAt = null;
  record.nextWatchdogAt = null;
  scheduleBackoff(record, false);
  record.lastError = "SUBMISSION_NOT_VISIBLE_RETRY";
  return true;
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const response = await fetch(JOBS_URL, { cache: "no-store" });
    if (!response.ok) {
      const offline = await loadScheduler();
      offline.bridgeStatus = "OFFLINE";
      await saveScheduler(offline);
      return;
    }
    const payload = await response.json();
    const actionable = Array.isArray(payload.jobs) ? payload.jobs : [];
    const scheduler = await loadScheduler();
    scheduler.bridgeStatus = "ONLINE";
    const currentIds = new Set(actionable.map((job) => job.job_id));
    for (const [jobId, record] of Object.entries(scheduler.jobs)) {
      if (record.state === "SUBMITTING" && now() - (record.updatedAt || 0) > 120000) {
        scheduleBackoff(record, false); // recover an extension/browser restart mid-submit
      }
      if (!currentIds.has(jobId) && record.state !== "DONE") {
        if (record.submittedAt || record.attemptedAt) {
          record.state = "DONE"; // submitted job disappeared after GitHub/reconcile moved on
          record.updatedAt = now();
        } else {
          delete scheduler.jobs[jobId]; // never-submitted transient projection may safely requeue
        }
      }
    }
    for (const job of actionable) {
      if (!scheduler.jobs[job.job_id]) {
        scheduler.jobs[job.job_id] = {
          state: "QUEUED",
          attempts: 0,
          createdAt: now(),
          role: job.role || null,
          task: job.task || null
        };
      } else {
        scheduler.jobs[job.job_id].role = job.role || scheduler.jobs[job.job_id].role || null;
        scheduler.jobs[job.job_id].task = job.task || scheduler.jobs[job.job_id].task || null;
      }
    }
    for (const job of actionable) {
      const record = scheduler.jobs[job.job_id];
      if (record && record.state === "WAITING_FOR_GITHUB") {
        await watchdogWaitingForGithub(job, record);
      }
    }
    await saveScheduler(scheduler);

    if (Object.values(scheduler.jobs).some((record) => record.state === "SUBMITTING")) return;
    if (now() - scheduler.lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;
    const candidate = actionable.find((job) => {
      const record = scheduler.jobs[job.job_id];
      return record.state === "QUEUED"
        || ((record.state === "BACKOFF" || record.state === "AUTH_REQUIRED")
          && now() >= (record.nextAttemptAt || 0));
    });
    if (candidate) await submit(candidate, scheduler);
  } catch (_) {
    // AgentBus/Firefox can be offline. Poll quietly; server state remains
    // authority, while the local operational projection records AUTO_WAIT.
    try {
      const offline = await loadScheduler();
      offline.bridgeStatus = "OFFLINE";
      await saveScheduler(offline);
    } catch (_) {
      // Storage can be unavailable during extension startup; the next tick
      // retries without turning the condition into a workflow decision.
    }
  } finally {
    ticking = false;
  }
}

if (typeof browser !== "undefined" && typeof fetch === "function") {
  if (browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener(async (message) => {
      if (!message || message.type !== "AGENTBUS_STATUS") return undefined;
      return bridgeProjection(await loadScheduler());
    });
  }
  setInterval(tick, POLL_MS);
  tick();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LONG_BACKOFF_MS,
    MIN_SUBMIT_INTERVAL_MS,
    SHORT_BACKOFF_MS,
    VISIBLE_SUBMISSION_BACKOFF_MS,
    WAITING_FOR_GITHUB_WATCHDOG_MS,
    markWaitingForGithub,
    markVisibleSubmissionWaiting,
    schedulerProjection,
    bridgeProjection,
    waitingWatchdogDue,
    watchdogWaitingForGithub,
    tick
  };
}
