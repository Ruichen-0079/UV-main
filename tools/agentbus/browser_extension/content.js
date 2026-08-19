"use strict";

const SUBMIT_CONFIRM_TIMEOUT_MS = 8000;
const SUBMIT_CONFIRM_POLL_MS = 250;

// Keep selectors deliberately small and semantic. If ChatGPT changes its
// composer, fail closed instead of clicking a nearby arbitrary control.
function findComposer() {
  const candidates = [...new Set([
    document.querySelector("textarea#prompt-textarea"),
    document.querySelector('div#prompt-textarea[contenteditable="true"]'),
    document.querySelector('textarea[data-testid="prompt-textarea"]'),
    document.querySelector('[contenteditable="true"][data-testid="prompt-textarea"]')
  ].filter(Boolean))];
  return candidates.length === 1 ? candidates[0] : null;
}

function findSendButton() {
  const candidates = [
    document.querySelector('button[data-testid="send-button"]'),
    document.querySelector('button[aria-label="Send prompt"]')
  ].filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) return null;
  const button = unique[0];
  return button.disabled || button.getAttribute("aria-disabled") === "true" ? null : button;
}

function isVisible(node) {
  if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function collectNodes(selectors) {
  const result = [];
  const seen = new Set();
  for (const selector of selectors) {
    for (const node of document.querySelectorAll(selector)) {
      if (!seen.has(node)) {
        seen.add(node);
        result.push(node);
      }
    }
  }
  return result;
}

const USER_TURN_SELECTORS = [
  'article[data-testid^="conversation-turn-user"]',
  '[data-testid="conversation-turn-user"]',
  '[data-message-author-role="user"]'
];

const STOP_CONTROL_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid*="stop"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  '[aria-label*="Stop generating"]',
  '[aria-label*="Stop streaming"]',
  '[data-state="generating"]',
  '[data-status="generating"]'
];

function isJobIdChar(value) {
  return Boolean(value) && /[A-Za-z0-9_.:-]/.test(value);
}

function containsExactJobId(text, jobId) {
  if (typeof text !== "string" || !jobId) return false;
  let offset = 0;
  while (offset <= text.length) {
    const index = text.indexOf(jobId, offset);
    if (index < 0) return false;
    const before = text[index - 1] || "";
    const after = text[index + jobId.length] || "";
    if (!isJobIdChar(before) && !isJobIdChar(after)) return true;
    offset = index + 1;
  }
  return false;
}

function isJobIdVisibleInUserTurn(jobId) {
  if (!jobId) return false;
  return collectNodes(USER_TURN_SELECTORS).some((node) => {
    if (!isVisible(node)) return false;
    return containsExactJobId(node.textContent || "", jobId);
  });
}

function findStopControl() {
  return collectNodes(STOP_CONTROL_SELECTORS).find(isVisible) || null;
}

function composerText(composer) {
  if (!composer) return "";
  if (composer.tagName === "TEXTAREA" || composer.tagName === "INPUT") {
    return String(composer.value || "");
  }
  return String(composer.innerText || composer.textContent || "");
}

function composerIsEmpty(composer) {
  return composerText(composer).trim() === "";
}

function submissionEvidence(jobId, composer, baseline) {
  if (!baseline || !baseline.initialText) return null;
  if (!baseline.userTurnVisible && isJobIdVisibleInUserTurn(jobId)) return "USER_TURN";
  if (baseline.initialText.trim() && composerIsEmpty(composer)) return "COMPOSER_EMPTY";
  if (!baseline.stopVisible && findStopControl()) return "GENERATING";
  return null;
}

async function waitForSubmissionConfirmation(jobId, composer, baseline, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : SUBMIT_CONFIRM_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : SUBMIT_CONFIRM_POLL_MS;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const evidence = submissionEvidence(jobId, composer, baseline);
    if (evidence) return evidence;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  } while (Date.now() <= deadline);
  return null;
}

function detectAuthRequired() {
  const path = (location.pathname || "").toLowerCase();
  if (path.includes("/auth/login") || path === "/login" || path.startsWith("/login/")) {
    return { code: "AUTH_REQUIRED", auth_required: true };
  }
  if (findComposer()) return null;
  const loginControl = document.querySelector(
    'input[type="email"], input[name="username"], input[name="email"], [data-testid="login-button"]'
  );
  if (!loginControl) return null;
  const text = `${document.title || ""} ${(document.body && document.body.innerText || "").slice(0, 1200)}`.toLowerCase();
  const loginWords = ["log in", "login", "sign in", "continue with google", "登录", "登入"];
  return loginWords.some((needle) => text.includes(needle))
    ? { code: "AUTH_REQUIRED", auth_required: true }
    : null;
}

function detectTemporaryError() {
  const auth = detectAuthRequired();
  if (auth) return auth;
  const errorNodes = [...new Set([
    document.querySelector('[role="alert"]'),
    document.querySelector('[data-testid="error-message"]'),
    document.querySelector('[data-testid="conversation-turn-error"]')
  ].filter(Boolean))];
  let text = errorNodes.map((node) => node.innerText || node.textContent || "").join(" ").toLowerCase();
  // On a login/restriction/error page there is no conversation composer, so
  // bounded page text is safe to inspect for backoff without reading replies.
  if (!text && !findComposer()) {
    text = `${document.title || ""} ${(document.body && document.body.innerText || "").slice(0, 2000)}`.toLowerCase();
  }
  const longBackoff = [
    "usage limit", "try again later", "too many requests", "rate limit",
    "you have reached", "temporarily restricted"
  ];
  if (longBackoff.some((needle) => text.includes(needle))) {
    return { code: "BROWSER_CAPACITY", long_backoff: true };
  }
  const transient = ["something went wrong", "network error", "failed to load"];
  if (transient.some((needle) => text.includes(needle))) {
    return { code: "BROWSER_TEMPORARY", long_backoff: false };
  }
  return null;
}

function isComposerReady() {
  return Boolean(findComposer() && findSendButton());
}

function setPrompt(composer, prompt) {
  composer.focus(); // Focuses the editor inside an inactive document, not the tab/window.
  if (composer.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(composer, prompt);
  } else {
    composer.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = prompt;
    composer.appendChild(paragraph);
  }
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt
  }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

async function submitPrompt(prompt, jobId, options = {}) {
  const temporary = detectTemporaryError();
  if (temporary) return { ok: false, ...temporary };
  if (!jobId) return { ok: false, code: "JOB_ID_REQUIRED" };
  if (isJobIdVisibleInUserTurn(jobId)) {
    return { ok: false, code: "ALREADY_SUBMITTED_VISIBLE", visible: true };
  }
  const composer = findComposer();
  if (!composer) return { ok: false, code: "COMPOSER_NOT_FOUND" };
  setPrompt(composer, prompt);
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 350;
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const send = findSendButton();
  if (!send || !isComposerReady()) return { ok: false, code: "COMPOSER_NOT_READY" };
  const baseline = {
    initialText: composerText(composer),
    stopVisible: Boolean(findStopControl()),
    userTurnVisible: isJobIdVisibleInUserTurn(jobId)
  };
  try {
    send.click();
  } catch (_) {
    return { ok: false, code: "SUBMIT_NOT_CONFIRMED" };
  }
  const evidence = await waitForSubmissionConfirmation(jobId, composer, baseline, {
    timeoutMs: options.confirmTimeoutMs,
    pollMs: options.confirmPollMs
  });
  if (!evidence) return { ok: false, code: "SUBMIT_NOT_CONFIRMED" };
  return { ok: true, code: "SUBMITTED_CONFIRMED", evidence };
}

if (typeof browser !== "undefined" && browser.runtime && browser.runtime.onMessage) {
  browser.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return undefined;
    if (message.type === "AGENTBUS_CHECK_JOB") {
      const visible = isJobIdVisibleInUserTurn(message.job_id);
      return Promise.resolve({
        ok: true,
        visible,
        code: visible ? "ALREADY_SUBMITTED_VISIBLE" : "NOT_SUBMITTED_VISIBLE"
      });
    }
    if (message.type !== "AGENTBUS_SUBMIT" || typeof message.prompt !== "string") {
      return undefined;
    }
    return submitPrompt(message.prompt, message.job_id);
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    containsExactJobId,
    composerIsEmpty,
    findComposer,
    findSendButton,
    findStopControl,
    isJobIdVisibleInUserTurn,
    submissionEvidence,
    submitPrompt,
    waitForSubmissionConfirmation
  };
}
