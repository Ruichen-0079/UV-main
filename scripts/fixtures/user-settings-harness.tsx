/** Acceptance-only entry; never imported by a production surface. */
import ReactDOM from "/node_modules/.vite/deps/react-dom_client.js";
import React from "/node_modules/.vite/deps/react.js";
import { UserSettingsPanel } from "../../apps/web/src/user-settings-panel.js";
export function mountSettingsHarness() {
  const host = document.createElement("div"); document.body.replaceChildren(host);
  ReactDOM.createRoot(host).render(React.createElement(UserSettingsPanel));
}
