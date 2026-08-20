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


if __name__ == "__main__":
    unittest.main()
