"use strict";

/*
 * AgentBus v2 browser transport.  This script knows only lane, job, operation,
 * packet, and raw assistant text.  It never parses or routes semantic results.
 */
const CONFIG = globalThis.AGENTBUS_V2_BROWSER_CONFIG || {
  bridge_base: "http://127.0.0.1:6791",
  bridge_token: "REPLACE_WITH_BRIDGE_TOKEN",
  poll_ms: 1000,
  response_timeout_ms: 120000
};
const LANES = ["plan", "judge"];
const state = { current_job_id: null };

function canonicalUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch (_) {
    return "";
  }
}

function visible(node) {
  if (!node || node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function findComposer() {
  const candidates = [
    document.querySelector("textarea#prompt-textarea"),
    document.querySelector('textarea[data-testid="prompt-textarea"]'),
    document.querySelector('div#prompt-textarea[contenteditable="true"]'),
    document.querySelector('[contenteditable="true"][data-testid="prompt-textarea"]'),
    document.querySelector('textarea[placeholder*="Message"]')
  ].filter(visible);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : null;
}

function composerText(node) {
  if (!node) return "";
  if (node.tagName === "TEXTAREA" || node.tagName === "INPUT") return String(node.value || "");
  return String(node.innerText || node.textContent || "");
}

function generating() {
  const selectors = [
    'button[data-testid="stop-button"]',
    'button[data-testid*="stop"]',
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop streaming"]',
    '[data-state="generating"]',
    '[data-status="generating"]'
  ];
  return selectors.some((selector) => {
    const node = document.querySelector(selector);
    return visible(node);
  });
}

function assistantNodes() {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
}

function newAssistantText(before) {
  const nodes = assistantNodes();
  if (nodes.length <= before.length) return null;
  const node = nodes[nodes.length - 1];
  return String(node.innerText || node.textContent || "");
}

function sendButton(requireEnabled = true) {
  const candidates = [
    document.querySelector('button[data-testid="send-button"]'),
    document.querySelector('button[aria-label="Send prompt"]')
  ].filter(visible);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) return null;
  const button = unique[0];
  if (requireEnabled && (button.disabled || button.getAttribute?.("aria-disabled") === "true")) {
    return null;
  }
  return button;
}

function setComposer(node, text) {
  node.focus();
  if (node.tagName === "TEXTAREA") {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor.set.call(node, text);
  } else {
    node.textContent = text;
  }
  node.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: text
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bridgeFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, {
    "X-AgentBus-Token": CONFIG.bridge_token
  });
  return fetch(`${CONFIG.bridge_base}${path}`, Object.assign({}, options, {
    headers,
    mode: "cors"
  }));
}

async function pull(lane) {
  const response = await bridgeFetch(`/bridge/pull?lane=${encodeURIComponent(lane)}`);
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`bridge pull HTTP ${response.status}`);
  return response.json();
}

async function heartbeat(request) {
  const response = await bridgeFetch("/bridge/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lane: request.lane, conversation_url: canonicalUrl(location.href) })
  });
  if (!response.ok) throw new Error(`bridge heartbeat HTTP ${response.status}`);
}

async function waitForResponse(before) {
  const deadline = Date.now() + Number(CONFIG.response_timeout_ms || 120000);
  while (Date.now() < deadline) {
    const response = newAssistantText(before);
    if (response !== null && !generating()) return response;
    await sleep(500);
  }
  throw new Error("assistant response timed out");
}

async function processRequest(request) {
  if (canonicalUrl(location.href) !== canonicalUrl(request.conversation_url)) return false;
  const composer = findComposer();
  if (!composer || composerText(composer).trim() !== "" || generating()) return false;
  // An empty composer commonly has a disabled send button.  Locate the
  // control first, then require it to become enabled after insertion.
  const send = sendButton(false);
  if (!send) return false;
  await heartbeat(request);
  if (composerText(composer).trim() !== "" || generating()) return false;
  const before = assistantNodes();
  setComposer(composer, request.packet);
  const afterInsert = findComposer();
  if (!afterInsert || composerText(afterInsert) !== request.packet) return false;
  const readySend = sendButton(true);
  if (!readySend) return false;
  readySend.click();
  const rawResponse = await waitForResponse(before);
  const result = await bridgeFetch("/bridge/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lane: request.lane, job_id: request.job_id, raw_response: rawResponse })
  });
  if (!result.ok) throw new Error(`bridge result HTTP ${result.status}`);
  return true;
}

async function poll() {
  if (state.current_job_id) return;
  for (const lane of LANES) {
    try {
      const request = await pull(lane);
      if (!request || state.current_job_id) continue;
      if (canonicalUrl(location.href) !== canonicalUrl(request.conversation_url)) continue;
      state.current_job_id = request.job_id;
      try {
        await processRequest(request);
      } finally {
        state.current_job_id = null;
      }
      return;
    } catch (error) {
      // A closed tab, a busy composer, and a bridge restart are all temporary
      // operational conditions.  The next poll retries without semantic state.
      state.current_job_id = null;
      if (typeof console !== "undefined") console.debug("AgentBus v2 browser transport", error);
    }
  }
}

const API = {
  canonicalUrl,
  composerText,
  generating,
  assistantNodes,
  newAssistantText,
  findComposer,
  sendButton,
  processRequest,
  poll
};
globalThis.AgentBusV2Browser = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof window !== "undefined" && typeof document !== "undefined") {
  setInterval(poll, Number(CONFIG.poll_ms || 1000));
  poll();
}
