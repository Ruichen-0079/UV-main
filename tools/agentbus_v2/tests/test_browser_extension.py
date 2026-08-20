from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest


EXTENSION = Path(__file__).parents[1] / "browser_extension"


class BrowserExtensionTests(unittest.TestCase):
    def test_manifest_is_v2_scoped_and_has_no_v1_permissions(self) -> None:
        manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(2, manifest["manifest_version"])
        permissions = set(manifest["permissions"])
        self.assertEqual(
            {
                "http://127.0.0.1:6791/*",
                "https://chatgpt.com/c/*",
                "https://chat.openai.com/c/*",
            },
            permissions,
        )
        self.assertEqual(["background.js"], manifest["background"]["scripts"])
        self.assertNotIn("tools/agentbus", (EXTENSION / "content.js").read_text(encoding="utf-8"))

    def test_javascript_syntax_and_dom_safety_helpers(self) -> None:
        content = EXTENSION / "content.js"
        try:
            checked = subprocess.run(
                ["node", "--check", str(content)],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            self.skipTest("node is not installed")
        self.assertEqual(0, checked.returncode, checked.stderr)
        background = EXTENSION / "background.js"
        checked_background = subprocess.run(
            ["node", "--check", str(background)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, checked_background.returncode, checked_background.stderr)
        script = f"""
const fs = require('fs');
const vm = require('vm');
const sandbox = {{module: {{exports: {{}}}}, console}};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync({json.dumps(str(content))}, 'utf8'), sandbox);
const api = sandbox.module.exports;
let composer = {{tagName: 'TEXTAREA', value: 'keep this draft', hidden: false, getAttribute: () => null}};
let stop = null;
let send = {{disabled: true, hidden: false, getAttribute: () => null, click: () => {{}}}};
let assistants = [
  {{innerText: 'historical one', hidden: false, getAttribute: () => null}},
  {{innerText: 'historical two', hidden: false, getAttribute: () => null}}
];
sandbox.document = {{
  querySelector: (selector) => {{
    if (selector.includes('stop')) return stop;
    if (selector.toLowerCase().includes('send')) return send;
    if (selector.includes('prompt') || selector.includes('Message')) return composer;
    return null;
  }},
  querySelectorAll: (selector) => selector.includes('assistant') ? assistants : []
}};
if (api.composerText(composer) !== 'keep this draft') throw Error('draft was not preserved');
if (api.sendButton() !== null || api.sendButton(false) !== send) throw Error('disabled send handling failed');
send.disabled = false;
if (api.sendButton() !== send) throw Error('enabled send button not found');
if (api.generating()) throw Error('idle page reported generating');
stop = {{hidden: false, getAttribute: () => null}};
if (!api.generating()) throw Error('generation was not detected');
stop = null;
const before = api.assistantNodes();
assistants.push({{innerText: 'new answer only', hidden: false, getAttribute: () => null}});
if (api.newAssistantText(before) !== 'new answer only') throw Error('historical answer selected');
console.log('ok');
"""
        result = subprocess.run(
            ["node", "-e", script],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_process_request_inserts_before_post_insertion_send_lookup(self) -> None:
        content = EXTENSION / "content.js"
        script = f"""
const fs = require('fs');
const vm = require('vm');
const sandbox = {{module: {{exports: {{}}}}, console, URL, InputEvent: class {{}}}};
sandbox.globalThis = sandbox;
sandbox.getComputedStyle = () => ({{display: '', visibility: ''}});
sandbox.location = {{href: 'https://chatgpt.com/c/plan-lane'}};
const bridgeMessages = [];
sandbox.browser = {{runtime: {{sendMessage: async (message) => {{
  bridgeMessages.push(message);
  return {{ok: true, status: 200, body: ''}};
}}}}}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(content))}, 'utf8'), sandbox);
const api = sandbox.module.exports;

async function scenario(sendAfterInsertion) {{
  const events = [];
  let text = '';
  let assistants = [];
  const composer = {{tagName: 'DIV', hidden: false, focus: () => {{}},
    getAttribute: () => null, dispatchEvent: () => {{}}}};
  Object.defineProperty(composer, 'textContent', {{
    get: () => text,
    set: (value) => {{ text = String(value); events.push('insert'); }}
  }});
  let send = null;
  if (sendAfterInsertion) {{
    send = {{disabled: false, hidden: false, getAttribute: () => null,
      click: () => {{ events.push('click'); assistants = [{{innerText: 'raw answer', hidden: false, getAttribute: () => null}}]; }}}};
  }}
  sandbox.document = {{
    querySelector: (selector) => {{
      if (selector === 'div#prompt-textarea[contenteditable="true"]') return composer;
      if (selector === 'button[data-testid="send-button"]') {{
        events.push('send_lookup');
        return sendAfterInsertion && text ? send : null;
      }}
      if (selector === 'button[aria-label="Send prompt"]') {{
        events.push('send_lookup');
        return null;
      }}
      return null;
    }},
    querySelectorAll: (selector) => selector.includes('assistant') ? assistants : []
  }};
  bridgeMessages.length = 0;
  const result = await api.processRequest({{
    lane: 'plan', job_id: 'plan-' + '1'.repeat(24),
    operation: 'PLAN_GPT', conversation_url: 'https://chatgpt.com/c/plan-lane', packet: 'PACKET'
  }});
  const firstInsert = events.indexOf('insert');
  const firstSendLookup = events.indexOf('send_lookup');
  if (firstInsert < 0 || firstSendLookup < 0 || firstInsert > firstSendLookup) throw Error('send lookup preceded insertion');
  if (sendAfterInsertion) {{
    if (result !== true || !events.includes('click')) throw Error('post-insertion send did not proceed');
  }} else {{
    if (result !== false || events.includes('click')) throw Error('absent post-insertion send clicked');
    const diagnostic = bridgeMessages.find((m) => m.path === '/bridge/diagnostic');
    if (!diagnostic || !String(diagnostic.body).includes('SEND_BUTTON_NOT_FOUND')) throw Error('missing send diagnostic');
  }}
}}
(async () => {{ await scenario(true); await scenario(false); console.log('ok'); }})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_background_bridge_is_fixed_loopback_allowlist(self) -> None:
        background = EXTENSION / "background.js"
        script = f"""
const fs = require('fs');
const vm = require('vm');
const sandbox = {{module: {{exports: {{}}}}, URL, fetch: async (url, options) => ({{
  ok: true, status: 204, text: async () => ''
}})}};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync({json.dumps(str(background))}, 'utf8'), sandbox);
const api = sandbox.module.exports;
if (api.requestSpec({{type:'NOPE'}}) !== null) throw Error('ignored message was not ignored');
const spec = api.requestSpec({{
  type:'AGENTBUS_V2_BRIDGE_REQUEST', bridge_base:'http://127.0.0.1:6791',
  bridge_token:'x', path:'/bridge/heartbeat', method:'POST',
  headers:{{'Content-Type':'application/json'}}, body:'{{}}'
}});
if (spec.url !== 'http://127.0.0.1:6791/bridge/heartbeat') throw Error('wrong bridge URL');
for (const bad of ['/api/status', 'http://example.test/bridge/pull']) {{
  let rejected = false;
  try {{ api.requestSpec({{type:'AGENTBUS_V2_BRIDGE_REQUEST', bridge_base:'http://127.0.0.1:6791', bridge_token:'x', path:bad}}); }}
  catch (_) {{ rejected = true; }}
  if (!rejected) throw Error('unapproved bridge path accepted');
}}
console.log('ok');
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
