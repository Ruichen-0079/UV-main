from __future__ import annotations

import json
from pathlib import Path
import subprocess
import unittest


COMPAT = Path(__file__).parents[1] / "browser_extension" / "editor_compat.js"


class BrowserEditorCompatTests(unittest.TestCase):
    def test_multiline_exec_command_preserves_line_boundaries_and_structural_text(self) -> None:
        script = f"""
const fs = require('fs');
const vm = require('vm');
class FakeNode {{}}
Object.defineProperty(FakeNode.prototype, 'textContent', {{
  configurable: true, enumerable: true,
  get() {{ return String(this._raw || ''); }},
  set(value) {{ this._raw = String(value); }}
}});
const calls = [];
const sandbox = {{module: {{exports: {{}}}}, console, Node: FakeNode}};
sandbox.globalThis = sandbox;
sandbox.document = {{
  execCommand: (command, showUI, value) => {{
    calls.push([command, showUI, value]);
    return true;
  }}
}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(COMPAT))}, 'utf8'), sandbox);
const api = sandbox.module.exports;
if (!api.execShimInstalled) throw Error('execCommand shim was not installed');
if (sandbox.document.execCommand !== api.multilineExec) throw Error('document did not expose installed shim');
if (!sandbox.document.execCommand('insertText', false, 'A\\n\\nB\\n')) throw Error('multiline insert failed');
const commands = calls.map((row) => row[0] + ':' + String(row[2] ?? '')).join('|');
if (commands !== 'insertText:A|insertParagraph:|insertParagraph:|insertText:B|insertParagraph:') {{
  throw Error('unexpected editor-native command sequence: ' + commands);
}}
const text = (value) => ({{nodeType: 3, nodeValue: value}});
const br = () => ({{nodeType: 1, tagName: 'BR', childNodes: []}});
const block = (...children) => ({{nodeType: 1, tagName: 'P', childNodes: children}});
const root = new FakeNode();
root.nodeType = 1;
root.tagName = 'DIV';
root.id = 'prompt-textarea';
root.getAttribute = (name) => name === 'contenteditable' ? 'true' : null;
root.childNodes = [text('A'), br(), br(), text('B')];
if (api.structuralText(root) !== 'A\\n\\nB') throw Error('BR serialization lost line boundaries');
if (root.textContent !== 'A\\n\\nB') throw Error('prompt textContent compatibility view was not installed');
root.childNodes = [block(text('A')), block(), block(text('B'))];
if (api.structuralText(root) !== 'A\\n\\nB') throw Error('empty block serialization lost blank line');
root.childNodes = [block(text('A')), block(br()), block(text('B'))];
if (api.structuralText(root) !== 'A\\n\\nB') throw Error('placeholder-BR block added an extra newline');
root.childNodes = [block(text('A'), br(), text('B'))];
if (api.structuralText(root) !== 'A\\nB') throw Error('real inline BR was not preserved');
const other = new FakeNode();
other.nodeType = 1; other.id = 'other'; other.getAttribute = () => null; other._raw = 'RAW';
if (other.textContent !== 'RAW') throw Error('non-composer textContent behavior changed');
console.log('ok');
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
