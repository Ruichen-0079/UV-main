"use strict";

/*
 * AgentBus v2 browser transport.  This script knows only lane, job, operation,
 * packet, and raw assistant text.  It never parses or routes semantic results.
 */
const CONFIG = globalThis.AGENTBUS_V2_BROWSER_CONFIG || {
  bridge_base: "http://127.0.0.1:6791",
  bridge_token: "REPLACE_WITH_BRIDGE_TOKEN",
  poll_ms: 1000,
  response_timeout_ms: 240000
};
const LANES = ["plan", "judge"];
const DEFAULT_RESPONSE_TIMEOUT_MS = 240000;
const DEFAULT_RESPONSE_POLL_MS = 500;
const DEFAULT_RESPONSE_STABILITY_MS = 2500;

function newClientId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `client-${uuid}`;
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const state = {
  client_id: newClientId(),
  current_job_id: null,
  matched_lanes: new Set(),
  heartbeat_lanes: new Set(),
  dom_probe_jobs: new Set(),
  send_attempted_jobs: new Set()
};

function diagnostic(...values) {
  if (typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[AgentBusV2]", ...values);
  }
}

diagnostic("content script loaded");
diagnostic("config loaded", {
  bridge_base: CONFIG.bridge_base,
  token_configured: Boolean(CONFIG.bridge_token)
});

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
  // For contenteditable editors, textContent is the data-bearing DOM text. innerText
  // is layout-derived and Firefox may rewrite embedded newlines as spaces even when
  // the underlying editor state contains the exact packet. Prefer textContent when
  // it carries data; fall back to innerText only for empty structural editors.
  const domText = String(node.textContent || "");
  if (domText !== "") return domText;
  return String(node.innerText || "");
}

function normalizedEditorText(value) {
  return String(value == null ? "" : value).replace(/\r\n?/g, "\n");
}

function editorPacketMatches(actual, expected) {
  const current = normalizedEditorText(actual);
  const packet = normalizedEditorText(expected);
  if (current === packet) return true;
  // contenteditable editors commonly cannot retain a terminal line break as
  // message data.  Permit exactly that one representation difference and no
  // interior/content difference.
  return packet.endsWith("\n") && current === packet.slice(0, -1);
}

function packetMismatchSummary(actual, expected) {
  const current = normalizedEditorText(actual);
  const packet = normalizedEditorText(expected);
  let prefix = 0;
  while (prefix < current.length && prefix < packet.length && current[prefix] === packet[prefix]) {
    prefix += 1;
  }
  const actualCode = prefix < current.length ? current.codePointAt(prefix) : null;
  const expectedCode = prefix < packet.length ? packet.codePointAt(prefix) : null;
  return JSON.stringify({
    actual_length: current.length,
    expected_length: packet.length,
    common_prefix: prefix,
    actual_codepoint: actualCode,
    expected_codepoint: expectedCode,
    expected_terminal_newline: packet.endsWith("\n")
  });
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

function conversationMessages() {
  return [...document.querySelectorAll(
    '[data-message-author-role="user"], [data-message-author-role="assistant"]'
  )].filter(visible);
}

function messageText(node) {
  return String(node?.innerText || node?.textContent || "");
}

function exactConversationObservation(packet) {
  const messages = conversationMessages();
  let exactUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const node = messages[index];
    if (
      node.getAttribute?.("data-message-author-role") === "user" &&
      editorPacketMatches(messageText(node), packet)
    ) {
      exactUserIndex = index;
    }
  }
  if (exactUserIndex < 0) {
    return { exact_user_packet_observed: false, assistant_response: null };
  }
  let assistantResponse = null;
  for (let index = exactUserIndex + 1; index < messages.length; index += 1) {
    const node = messages[index];
    const role = node.getAttribute?.("data-message-author-role");
    if (role === "user") break;
    if (role === "assistant") {
      assistantResponse = messageText(node);
    }
  }
  return {
    exact_user_packet_observed: true,
    assistant_response: assistantResponse
  };
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

function dispatchInput(node, text) {
  try {
    node.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text
    }));
  } catch (_) {
    if (typeof Event === "function") {
      node.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
  }
}

function selectComposerContents(node) {
  const getter = typeof globalThis.getSelection === "function"
    ? globalThis.getSelection.bind(globalThis)
    : (typeof window !== "undefined" && typeof window.getSelection === "function"
        ? window.getSelection.bind(window)
        : null);
  if (!getter || typeof document.createRange !== "function") return false;
  const selection = getter();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function setComposer(node, text) {
  node.focus();
  if (node.tagName === "TEXTAREA") {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor.set.call(node, text);
    dispatchInput(node, text);
    return "textarea-native-value";
  }

  if (selectComposerContents(node) && typeof document.execCommand === "function") {
    try {
      if (document.execCommand("insertText", false, text)) {
        return "contenteditable-execCommand-insertText";
      }
    } catch (error) {
      diagnostic("composer execCommand failed", String(error));
    }
  }

  // Compatibility fallback only.  The asynchronous persistence check below keeps
  // a DOM-only mutation from being mistaken for accepted editor state.
  node.textContent = text;
  dispatchInput(node, text);
  return "contenteditable-dom-fallback";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function composerInsertionStable(expected) {
  for (const delay of [0, 50, 150, 300]) {
    if (delay) await sleep(delay);
    const current = findComposer();
    if (!current || !editorPacketMatches(composerText(current), expected)) return false;
  }
  return true;
}

async function bridgeFetch(path, options = {}) {
  if (typeof browser === "undefined" || !browser.runtime?.sendMessage) {
    throw new Error("Firefox extension runtime messaging is unavailable");
  }
  const response = await browser.runtime.sendMessage({
    type: "AGENTBUS_V2_BRIDGE_REQUEST",
    bridge_base: CONFIG.bridge_base,
    bridge_token: CONFIG.bridge_token,
    path,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body === undefined ? null : options.body
  });
  if (!response || typeof response.status !== "number") {
    throw new Error("bridge background response is invalid");
  }
  if (response.error) throw new Error(String(response.error));
  return {
    ok: Boolean(response.ok),
    status: response.status,
    json: async () => JSON.parse(response.body || ""),
    text: async () => String(response.body || "")
  };
}

async function pull(lane) {
  const response = await bridgeFetch(
    `/bridge/pull?lane=${encodeURIComponent(lane)}&client_id=${encodeURIComponent(state.client_id)}`
  );
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`bridge pull HTTP ${response.status}`);
  return response.json();
}

async function laneConfig(lane) {
  const response = await bridgeFetch(`/bridge/config?lane=${encodeURIComponent(lane)}`);
  if (response.status === 404 || response.status === 204) return null;
  if (!response.ok) throw new Error(`bridge config HTTP ${response.status}`);
  return response.json();
}

async function claim(request) {
  const response = await bridgeFetch("/bridge/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lane: request.lane,
      job_id: request.job_id,
      client_id: state.client_id
    })
  });
  if (response.status === 409) return false;
  if (!response.ok) throw new Error(`bridge claim HTTP ${response.status}`);
  return true;
}

async function heartbeat(request) {
  const first = !state.heartbeat_lanes.has(request.lane);
  if (first) diagnostic("heartbeat attempt", request.lane);
  try {
    const response = await bridgeFetch("/bridge/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane: request.lane, conversation_url: canonicalUrl(location.href) })
    });
    if (!response.ok) throw new Error(`bridge heartbeat HTTP ${response.status}`);
    state.heartbeat_lanes.add(request.lane);
    if (first) diagnostic("heartbeat response", request.lane, response.status);
  } catch (error) {
    diagnostic("heartbeat error", request.lane, String(error));
    throw error;
  }
}

async function heartbeatIfBound(lane) {
  const config = await laneConfig(lane);
  if (!config || canonicalUrl(location.href) !== canonicalUrl(config.conversation_url)) return false;
  if (!state.matched_lanes.has(lane)) {
    state.matched_lanes.add(lane);
    diagnostic("lane matched", lane);
  }
  await heartbeat(config);
  return true;
}

async function probeDom(lane, jobId) {
  if (state.dom_probe_jobs.has(jobId)) return;
  const composer = findComposer();
  const send = sendButton(false);
  const detail = JSON.stringify({
    composer_found: Boolean(composer),
    composer_empty: composer ? composerText(composer).trim() === "" : null,
    generation_busy: generating(),
    send_button_found: Boolean(send),
    send_button_enabled: Boolean(send && !send.disabled && send.getAttribute?.("aria-disabled") !== "true")
  });
  state.dom_probe_jobs.add(jobId);
  await reportDiagnostic(lane, jobId, "DOM_PROBE", detail);
}

async function reportDiagnostic(lane, jobId, code, detail, required = false) {
  diagnostic(code, lane, detail);
  try {
    const response = await bridgeFetch("/bridge/diagnostic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lane, job_id: String(jobId || ""), code, detail: String(detail || "") })
    });
    if (!response.ok) throw new Error(`bridge diagnostic HTTP ${response.status}`);
    return true;
  } catch (error) {
    diagnostic("diagnostic relay error", lane, String(error));
    if (required) throw error;
    return false;
  }
}

function responseTimeoutMs(request) {
  const value = Number(request?.response_timeout_ms ?? DEFAULT_RESPONSE_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 1 || value > 600000) {
    throw new Error("browser response timeout is invalid");
  }
  return value;
}

function responsePollMs(request) {
  const value = Number(request?.response_poll_ms ?? CONFIG.response_poll_ms ?? DEFAULT_RESPONSE_POLL_MS);
  if (!Number.isFinite(value) || value < 1 || value > 5000) {
    throw new Error("browser response poll interval is invalid");
  }
  return value;
}

function responseStabilityMs(request) {
  const value = Number(
    request?.response_stability_ms ?? CONFIG.response_stability_ms ?? DEFAULT_RESPONSE_STABILITY_MS
  );
  if (!Number.isFinite(value) || value < 1 || value > 60000) {
    throw new Error("browser response stability interval is invalid");
  }
  return value;
}

async function responseDiagnosticDetail(value, extra = {}) {
  const text = String(value);
  let sha256 = null;
  try {
    const digest = await globalThis.crypto?.subtle?.digest(
      "SHA-256", new TextEncoder().encode(text)
    );
    if (digest) {
      sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch (_) {
    // Hashing is diagnostic only. Completion still relies on exact DOM text.
  }
  return JSON.stringify({length: text.length, sha256, ...extra});
}

async function waitForResponse(request) {
  const timeoutMs = responseTimeoutMs(request);
  const pollMs = responsePollMs(request);
  const stabilityMs = responseStabilityMs(request);
  if (stabilityMs >= timeoutMs) {
    throw new Error("browser response stability interval must be shorter than response timeout");
  }
  const deadline = Date.now() + timeoutMs;
  let generationReported = false;
  let responseObserved = false;
  let candidate = null;
  let candidateSince = null;
  let candidateObservations = 0;
  while (Date.now() < deadline) {
    const generationBusy = generating();
    if (generationBusy && !generationReported) {
      generationReported = true;
      await reportDiagnostic(
        request.lane, request.job_id, "GENERATION_OBSERVED", "generation UI is active"
      );
    }
    const observation = exactConversationObservation(request.packet);
    const response = observation.assistant_response;
    if (generationBusy) {
      if (candidate !== null) {
        await reportDiagnostic(
          request.lane,
          request.job_id,
          "ASSISTANT_RESPONSE_CHANGED",
          await responseDiagnosticDetail(response ?? "", {reason: "generation_resumed"})
        );
      }
      candidate = null;
      candidateSince = null;
      candidateObservations = 0;
    } else if (response !== null && response !== "") {
      if (!responseObserved) {
        responseObserved = true;
        await reportDiagnostic(
          request.lane,
          request.job_id,
          "ASSISTANT_RESPONSE_OBSERVED",
          await responseDiagnosticDetail(response)
        );
      }
      if (candidate === null) {
        candidate = response;
        candidateSince = Date.now();
        candidateObservations = 1;
        await reportDiagnostic(
          request.lane,
          request.job_id,
          "ASSISTANT_RESPONSE_CANDIDATE",
          await responseDiagnosticDetail(response)
        );
      } else if (response !== candidate) {
        candidate = response;
        candidateSince = Date.now();
        candidateObservations = 1;
        await reportDiagnostic(
          request.lane,
          request.job_id,
          "ASSISTANT_RESPONSE_CHANGED",
          await responseDiagnosticDetail(response, {reason: "text_changed"})
        );
      } else {
        candidateObservations += 1;
        if (
          candidateObservations >= 2 &&
          candidateSince !== null &&
          Date.now() - candidateSince >= stabilityMs
        ) {
          await reportDiagnostic(
            request.lane,
            request.job_id,
            "ASSISTANT_RESPONSE_STABLE",
            await responseDiagnosticDetail(response)
          );
          return response;
        }
      }
    } else if (candidate !== null) {
      candidate = null;
      candidateSince = null;
      candidateObservations = 0;
      await reportDiagnostic(
        request.lane,
        request.job_id,
        "ASSISTANT_RESPONSE_CHANGED",
        await responseDiagnosticDetail("", {reason: "candidate_disappeared"})
      );
    }
    await sleep(pollMs);
  }
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "RESPONSE_TIMEOUT",
    `assistant response was not observable within ${responseTimeoutMs(request)}ms`,
    true
  );
  throw new Error("assistant response timed out");
}

async function postResult(request, rawResponse) {
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "RESULT_POST_ATTEMPTED",
    "posting observed assistant response to loopback bridge",
    true
  );
  const result = await bridgeFetch("/bridge/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lane: request.lane,
      job_id: request.job_id,
      client_id: state.client_id,
      raw_response: rawResponse
    })
  });
  if (!result.ok) throw new Error(`bridge result HTTP ${result.status}`);
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "RESULT_ACCEPTED",
    "loopback bridge accepted the raw response"
  );
}

async function processRequest(request) {
  if (canonicalUrl(location.href) !== canonicalUrl(request.conversation_url)) {
    await reportDiagnostic(
      request.lane, request.job_id, "LANE_URL_MISMATCH", "current URL did not match request"
    );
    return false;
  }
  const composer = findComposer();
  if (!composer) {
    await reportDiagnostic(
      request.lane, request.job_id, "COMPOSER_NOT_FOUND", "no unique visible composer"
    );
    return false;
  }

  const existingText = composerText(composer);
  const hasExistingText = existingText.trim() !== "";
  const resumesExactPendingPacket = hasExistingText && editorPacketMatches(existingText, request.packet);
  if (hasExistingText && !resumesExactPendingPacket) {
    await reportDiagnostic(
      request.lane, request.job_id, "COMPOSER_NOT_EMPTY", "existing user text preserved"
    );
    return false;
  }
  if (!(await claim(request))) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "CLAIM_BUSY",
      "another exact conversation client owns this job"
    );
    return false;
  }

  await reportDiagnostic(
    request.lane,
    request.job_id,
    "CLAIM_ACQUIRED",
    "this ephemeral browser client owns the exact pending job",
    true
  );

  await heartbeat(request);
  await probeDom(request.lane, request.job_id);

  // Conversation DOM is operational evidence only. The exact current packet
  // contains its immutable job identity; any recovered response still goes
  // through the strict bridge result path and submit_gpt_response.
  const recovery = exactConversationObservation(request.packet);
  if (recovery.exact_user_packet_observed) {
    state.send_attempted_jobs.add(request.job_id);
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "EXACT_USER_PACKET_OBSERVED",
      "the exact current packet is already visible as a user message"
    );
    if (recovery.assistant_response !== null || generating()) {
      const recoveredResponse = await waitForResponse(request);
      await postResult(request, recoveredResponse);
      return true;
    }
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "POST_SEND_OBSERVATION_INCOMPLETE",
      "exact user packet is visible without generation or an assistant response"
    );
    return false;
  }

  if (state.send_attempted_jobs.has(request.job_id)) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "SEND_ATTEMPT_ALREADY_RECORDED",
      "automatic replay is fenced while exact post-Send DOM evidence is absent"
    );
    return false;
  }

  if (generating()) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "GENERATION_BUSY",
      "target conversation is generating without the exact current packet"
    );
    return false;
  }

  if (resumesExactPendingPacket) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "PENDING_PACKET_ALREADY_PRESENT",
      "composer contains the exact current packet modulo one terminal editor newline"
    );
  } else {
    if (composerText(composer).trim() !== "" || generating()) {
      await reportDiagnostic(
        request.lane,
        request.job_id,
        "PRE_INSERT_BUSY",
        "composer or generation changed before insertion"
      );
      return false;
    }
    const insertionMethod = setComposer(composer, request.packet);
    if (!(await composerInsertionStable(request.packet))) {
      const current = findComposer();
      const actual = current ? composerText(current) : "";
      await reportDiagnostic(
        request.lane,
        request.job_id,
        "COMPOSER_INSERTION_MISMATCH",
        `packet text did not remain editor-equivalent after insertion (${insertionMethod}); ${packetMismatchSummary(actual, request.packet)}`
      );
      return false;
    }
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "PACKET_INSERTED",
      `exact packet remained stable after ${insertionMethod}`
    );
  }

  const postInsertionComposer = findComposer();
  if (!postInsertionComposer || !editorPacketMatches(composerText(postInsertionComposer), request.packet)) {
    const actual = postInsertionComposer ? composerText(postInsertionComposer) : "";
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "COMPOSER_INSERTION_MISMATCH",
      `packet changed before Send lookup; ${packetMismatchSummary(actual, request.packet)}`
    );
    return false;
  }
  const postInsertionSend = sendButton(false);
  if (!postInsertionSend) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "SEND_BUTTON_NOT_FOUND",
      "send control was not available after stable insertion"
    );
    return false;
  }
  const readySend = sendButton(true);
  if (!readySend) {
    await reportDiagnostic(
      request.lane,
      request.job_id,
      "SEND_BUTTON_DISABLED",
      "send control did not become enabled after insertion"
    );
    return false;
  }
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "SEND_BUTTON_READY",
    "unique post-insertion send control is enabled"
  );
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "SEND_ATTEMPTED",
    "invoking click on the unique enabled send control",
    true
  );
  state.send_attempted_jobs.add(request.job_id);
  readySend.click();
  await reportDiagnostic(
    request.lane,
    request.job_id,
    "SEND_CLICK_RETURNED",
    "send control click returned without a synchronous exception"
  );
  const rawResponse = await waitForResponse(request);
  await postResult(request, rawResponse);
  return true;
}

async function poll() {
  if (state.current_job_id) return;
  for (const lane of LANES) {
    let request = null;
    try {
      const matched = await heartbeatIfBound(lane);
      if (!matched) continue;
      request = await pull(lane);
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
      // Pre-Send conditions may be observed again. Once SEND_ATTEMPTED was
      // recorded, processRequest permits only exact DOM response recovery and
      // never clicks Send again for that job in this content-script lifetime.
      state.current_job_id = null;
      diagnostic("heartbeat/poll error", String(error));
      if (request && request.lane) {
        await reportDiagnostic(
          request.lane, request.job_id, "POLL_ERROR", String(error)
        );
      }
    }
  }
}

const API = {
  canonicalUrl,
  composerText,
  normalizedEditorText,
  editorPacketMatches,
  packetMismatchSummary,
  generating,
  assistantNodes,
  newAssistantText,
  conversationMessages,
  exactConversationObservation,
  findComposer,
  sendButton,
  setComposer,
  composerInsertionStable,
  responseTimeoutMs,
  responsePollMs,
  responseStabilityMs,
  responseDiagnosticDetail,
  waitForResponse,
  reportDiagnostic,
  processRequest,
  poll
};
globalThis.AgentBusV2Browser = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;
if (typeof window !== "undefined" && typeof document !== "undefined") {
  setInterval(poll, Number(CONFIG.poll_ms || 1000));
  poll();
}
