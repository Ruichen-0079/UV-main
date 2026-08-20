/* Copy the operational bridge token from the v2 gpt_lanes.json before loading
 * this development extension.  This placeholder is intentionally not a secret. */
globalThis.AGENTBUS_V2_BROWSER_CONFIG = Object.freeze({
  bridge_base: "http://127.0.0.1:6791",
  bridge_token: "REPLACE_WITH_BRIDGE_TOKEN",
  poll_ms: 1000,
  response_timeout_ms: 120000
});
