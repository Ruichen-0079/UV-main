"use strict";

/*
 * Firefox content-script fetches inherit the page's cross-origin policy. Keep
 * localhost bridge requests in the extension context, where the manifest host
 * permission applies. The allow-list prevents a generic localhost proxy.
 */
const BRIDGE_BASE = "http://127.0.0.1:6791";
const BRIDGE_PATHS = new Set([
  "/bridge/config",
  "/bridge/pull",
  "/bridge/claim",
  "/bridge/heartbeat",
  "/bridge/diagnostic",
  "/bridge/result"
]);
const BRIDGE_METHODS = new Set(["GET", "POST"]);

function requestSpec(message) {
  if (!message || message.type !== "AGENTBUS_V2_BRIDGE_REQUEST") return null;
  if (typeof message.bridge_base !== "string" || message.bridge_base !== BRIDGE_BASE) {
    throw new Error("bridge base is not the fixed v2 loopback endpoint");
  }
  if (typeof message.bridge_token !== "string" || !message.bridge_token.trim()) {
    throw new Error("bridge token is required");
  }
  if (typeof message.path !== "string" || !message.path.startsWith("/bridge/")) {
    throw new Error("bridge path is invalid");
  }
  const target = new URL(message.path, BRIDGE_BASE);
  if (target.origin !== BRIDGE_BASE || !BRIDGE_PATHS.has(target.pathname)) {
    throw new Error("bridge path is not allowed");
  }
  const method = message.method === undefined ? "GET" : message.method;
  if (typeof method !== "string" || !BRIDGE_METHODS.has(method)) {
    throw new Error("bridge method is not allowed");
  }
  const headers = { "X-AgentBus-Token": message.bridge_token };
  if (message.headers !== undefined) {
    if (!message.headers || typeof message.headers !== "object") {
      throw new Error("bridge headers are invalid");
    }
    for (const [name, value] of Object.entries(message.headers)) {
      if (name.toLowerCase() !== "content-type" || typeof value !== "string") {
        throw new Error("bridge headers are not allowed");
      }
      headers[name] = value;
    }
  }
  if (method === "GET" && message.body !== undefined && message.body !== null) {
    throw new Error("GET bridge requests cannot contain a body");
  }
  if (message.body !== undefined && message.body !== null && typeof message.body !== "string") {
    throw new Error("bridge body must be text");
  }
  return {
    url: target.toString(),
    method,
    headers,
    body: message.body === undefined ? null : message.body
  };
}

async function bridgeRequest(message) {
  try {
    const spec = requestSpec(message);
    if (spec === null) return undefined;
    const response = await fetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, error: String(error) };
  }
}

if (typeof browser !== "undefined" && browser.runtime?.onMessage) {
  browser.runtime.onMessage.addListener((message) => bridgeRequest(message));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BRIDGE_BASE, BRIDGE_PATHS, requestSpec, bridgeRequest };
}
