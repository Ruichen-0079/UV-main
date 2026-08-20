from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest


CONTENT = Path(__file__).parents[1] / "browser_extension" / "content.js"


class BrowserEditorEquivalenceTests(unittest.TestCase):
    def test_editor_equivalence_is_narrow_and_can_resume_exact_pending_packet(self) -> None:
        script = f"""
const fs = require('fs');
const vm = require('vm');
const sandbox = {{
  module: {{exports: {{}}}}, console, URL, setTimeout,
  InputEvent: class {{}}, Event: class {{}}
}};
sandbox.globalThis = sandbox;
sandbox.getComputedStyle = () => ({{display: '', visibility: ''}});
sandbox.location = {{href: 'https://chatgpt.com/c/plan-lane'}};
const bridgeMessages = [];
sandbox.browser = {{runtime: {{sendMessage: async (message) => {{
  bridgeMessages.push(message);
  return {{ok: true, status: 200, body: ''}};
}}}}}};
let assistants = [];
const composer = {{
  tagName: 'DIV', hidden: false,
  // Firefox innerText is layout-derived and may normalize a real editor newline
  // to a space. textContent remains the data-bearing packet text.
  innerText: 'PACKET ', textContent: 'PACKET',
  focus: () => {{}}, getAttribute: () => null
}};
const send = {{
  hidden: false, disabled: false, getAttribute: () => null,
  click: () => {{ assistants = [{{innerText: 'RAW', hidden: false, getAttribute: () => null}}]; }}
}};
sandbox.document = {{
  querySelector: (selector) => {{
    if (selector === 'div#prompt-textarea[contenteditable="true"]') return composer;
    if (selector === 'button[data-testid="send-button"]') return send;
    return null;
  }},
  querySelectorAll: (selector) => selector.includes('assistant') ? assistants : []
}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(CONTENT))}, 'utf8'), sandbox);
const api = sandbox.module.exports;
if (api.composerText(composer) !== 'PACKET') throw Error('contenteditable verification used layout-normalized innerText');
if (!api.editorPacketMatches('A\\r\\nB', 'A\\nB')) throw Error('CRLF normalization failed');
if (!api.editorPacketMatches('PACKET', 'PACKET\\n')) throw Error('single terminal editor newline was not tolerated');
if (api.editorPacketMatches('PACET', 'PACKET\\n')) throw Error('interior packet corruption was accepted');
if (api.editorPacketMatches('PACKET', 'PACKET\\n\\n')) throw Error('more than one missing trailing newline was accepted');
(async () => {{
  const ok = await api.processRequest({{
    lane: 'plan', job_id: 'plan-' + '1'.repeat(24), operation: 'PLAN_GPT',
    conversation_url: 'https://chatgpt.com/c/plan-lane', packet: 'PACKET\\n'
  }});
  if (!ok) throw Error('existing exact pending packet was not resumed');
  const diagnostics = bridgeMessages.filter((m) => m.path === '/bridge/diagnostic');
  if (!diagnostics.some((m) => String(m.body).includes('PENDING_PACKET_ALREADY_PRESENT'))) throw Error('resume diagnostic missing');
  const result = bridgeMessages.find((m) => m.path === '/bridge/result');
  if (!result || !String(result.body).includes('RAW')) throw Error('browser result was not posted');
  console.log('ok');
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
