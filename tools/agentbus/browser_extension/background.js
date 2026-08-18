"use strict";

const JOBS_URL = "http://127.0.0.1:6738/api/browser/jobs";
const POLL_MS = 10000;
const MIN_SUBMIT_INTERVAL_MS = 20000;
const COMPOSER_RETRY_MS = 10000;
const SHORT_BACKOFF_MS = [60000, 120000, 300000];
const LONG_BACKOFF_MS = [60000, 120000, 300000, 900000, 1800000];
let ticking = false;

function now() { return Date.now(); }
function jitter(ms) { return ms + Math.floor(ms * (Math.random() * 0.16 - 0.08)); }

async function loadScheduler() {
  const saved = await browser.storage.local.get(["jobs", "lastSubmitAt"]);
  return { jobs: saved.jobs || {}, lastSubmitAt: saved.lastSubmitAt || 0 };
}

async function saveScheduler(state) {
  await browser.storage.local.set({ jobs: state.jobs, lastSubmitAt: state.lastSubmitAt });
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
}

function scheduleComposerRetry(record) {
  record.state = "BACKOFF";
  record.nextAttemptAt = now() + jitter(COMPOSER_RETRY_MS);
  record.attempts = (record.attempts || 0) + 1;
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
    if (response && response.ok) {
      scheduler.lastSubmitAt = now();
      record.state = "WAITING_FOR_GITHUB";
      record.submittedAt = scheduler.lastSubmitAt;
      record.updatedAt = scheduler.lastSubmitAt;
      record.lastError = null;
      return;
    }
    const code = response && response.code || "COMPOSER_NOT_READY";
    record.lastError = code;
    if (code === "COMPOSER_NOT_READY" || code === "COMPOSER_NOT_FOUND") {
      scheduleComposerRetry(record);
    } else {
      scheduleBackoff(record, code === "BROWSER_CAPACITY");
    }
  } catch (error) {
    record.lastError = String(error).slice(0, 300);
    scheduleBackoff(record, false);
  } finally {
    await saveScheduler(scheduler);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const response = await fetch(JOBS_URL, { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    const actionable = Array.isArray(payload.jobs) ? payload.jobs : [];
    const scheduler = await loadScheduler();
    const currentIds = new Set(actionable.map((job) => job.job_id));
    for (const [jobId, record] of Object.entries(scheduler.jobs)) {
      if (record.state === "SUBMITTING" && now() - (record.updatedAt || 0) > 120000) {
        scheduleBackoff(record, false); // recover an extension/browser restart mid-submit
      }
      if (!currentIds.has(jobId) && record.state !== "DONE") {
        if (record.submittedAt) {
          record.state = "DONE"; // submitted job disappeared after GitHub/reconcile moved on
          record.updatedAt = now();
        } else {
          delete scheduler.jobs[jobId]; // never-submitted transient projection may safely requeue
        }
      }
    }
    for (const job of actionable) {
      if (!scheduler.jobs[job.job_id]) {
        scheduler.jobs[job.job_id] = { state: "QUEUED", attempts: 0, createdAt: now() };
      }
    }
    await saveScheduler(scheduler);

    if (Object.values(scheduler.jobs).some((record) => record.state === "SUBMITTING")) return;
    if (now() - scheduler.lastSubmitAt < MIN_SUBMIT_INTERVAL_MS) return;
    const candidate = actionable.find((job) => {
      const record = scheduler.jobs[job.job_id];
      return record.state === "QUEUED" || (record.state === "BACKOFF" && now() >= (record.nextAttemptAt || 0));
    });
    if (candidate) await submit(candidate, scheduler);
  } catch (_) {
    // AgentBus/Firefox can be offline. Poll quietly; server state remains authority.
  } finally {
    ticking = false;
  }
}

setInterval(tick, POLL_MS);
tick();
