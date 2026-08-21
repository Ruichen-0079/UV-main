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
        content = (EXTENSION / "content.js").read_text(encoding="utf-8")
        self.assertNotIn("tools/agentbus", content)
        self.assertNotIn("localStorage", content)
        self.assertNotIn("sessionStorage", content)
        self.assertNotIn("browser.storage", content)

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
const sandbox = {{module: {{exports: {{}}}}, console, URL, InputEvent: class {{}}, setTimeout}};
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
      click: () => {{
        events.push('click');
        assistants = [
          {{innerText: 'PACKET', textContent: 'PACKET', hidden: false,
            getAttribute: (name) => name === 'data-message-author-role' ? 'user' : null}},
          {{innerText: 'raw answer', textContent: 'raw answer', hidden: false,
            getAttribute: (name) => name === 'data-message-author-role' ? 'assistant' : null}}
        ];
      }}}};
  }}
  sandbox.document = {{
    querySelector: (selector) => {{
      if (selector === 'div#prompt-textarea[contenteditable="true"]') return composer;
      if (selector === 'button[data-testid="send-button"]') {{
        events.push(text ? 'send_lookup_after_insert' : 'send_lookup_before_insert');
        return sendAfterInsertion && text ? send : null;
      }}
      if (selector === 'button[aria-label="Send prompt"]') {{
        events.push(text ? 'send_lookup_after_insert' : 'send_lookup_before_insert');
        return null;
      }}
      return null;
    }},
    querySelectorAll: (selector) => selector.includes('data-message-author-role') ? assistants : []
  }};
  bridgeMessages.length = 0;
  const result = await api.processRequest({{
    lane: 'plan', job_id: 'plan-' + (sendAfterInsertion ? '1' : '2').repeat(24),
    operation: 'PLAN_GPT', conversation_url: 'https://chatgpt.com/c/plan-lane', packet: 'PACKET',
    response_timeout_ms: 1000, response_stability_ms: 2, response_poll_ms: 1
  }});
  const firstInsert = events.indexOf('insert');
  const firstSendLookup = events.indexOf('send_lookup_after_insert');
  if (firstInsert < 0 || firstSendLookup < 0 || firstInsert > firstSendLookup) throw Error('send lookup preceded insertion');
  if (sendAfterInsertion) {{
    if (result !== true || !events.includes('click')) throw Error('post-insertion send did not proceed');
  }} else {{
    if (result !== false || events.includes('click')) throw Error('absent post-insertion send clicked');
    const diagnostics = bridgeMessages.filter((m) => m.path === '/bridge/diagnostic');
    if (!diagnostics.some((m) => String(m.body).includes('SEND_BUTTON_NOT_FOUND'))) throw Error('missing send diagnostic');
  }}
}}
(async () => {{ await scenario(true); await scenario(false); console.log('ok'); }})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_send_boundary_diagnostics_classify_before_and_after_send(self) -> None:
        content = EXTENSION / "content.js"
        script = f"""
const fs = require('fs');
const vm = require('vm');
const hostSetTimeout = setTimeout;
const sandbox = {{
  module: {{exports: {{}}}}, console, URL, InputEvent: class {{}},
  setTimeout: (fn, ms) => hostSetTimeout(fn, Math.min(Number(ms) || 0, 1))
}};
sandbox.globalThis = sandbox;
sandbox.AGENTBUS_V2_BROWSER_CONFIG = {{
  bridge_base: 'http://127.0.0.1:6791',
  bridge_token: 'super-secret-token',
  poll_ms: 1000,
  response_timeout_ms: 120000
}};
sandbox.getComputedStyle = () => ({{display: '', visibility: ''}});
sandbox.location = {{href: 'https://chatgpt.com/c/plan-lane'}};
const bridgeMessages = [];
let rejectSendBoundaryDiagnostic = false;
sandbox.browser = {{runtime: {{sendMessage: async (message) => {{
  bridgeMessages.push(message);
  if (
    rejectSendBoundaryDiagnostic && message.path === '/bridge/diagnostic' &&
    JSON.parse(message.body).code === 'SEND_ATTEMPTED'
  ) return {{ok: false, status: 409, body: '{{"error":"sink failed"}}'}};
  return {{ok: true, status: 200, body: '{{}}'}};
}}}}}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(content))}, 'utf8'), sandbox);
const api = sandbox.module.exports;

let text = '';
let messages = [];
let sendAvailable = true;
let clickMode = 'success';
let clicks = 0;
let activeJob = null;
const composer = {{
  tagName: 'DIV', hidden: false, focus: () => {{}},
  getAttribute: () => null, dispatchEvent: () => {{}}
}};
Object.defineProperty(composer, 'textContent', {{
  get: () => text,
  set: (value) => {{ text = String(value); }}
}});
function roleNode(role, value) {{
  return {{
    innerText: value, textContent: value, hidden: false,
    getAttribute: (name) => name === 'data-message-author-role' ? role : null
  }};
}}
const send = {{
  disabled: false, hidden: false, getAttribute: () => null,
  click: () => {{
    clicks += 1;
    const packet = text;
    text = '';
    messages = [roleNode(
      'user',
      clickMode === 'success' ? packet : `rendered exact job ${{activeJob}}`
    )];
    if (clickMode === 'success') messages.push(roleNode('assistant', 'raw answer'));
  }}
}};
sandbox.document = {{
  querySelector: (selector) => {{
    if (selector === 'div#prompt-textarea[contenteditable="true"]') return composer;
    if (selector === 'button[data-testid="send-button"]') return sendAvailable && text ? send : null;
    return null;
  }},
  querySelectorAll: (selector) => {{
    if (selector === '[data-message-author-role="assistant"]') {{
      return messages.filter((node) => node.getAttribute('data-message-author-role') === 'assistant');
    }}
    if (selector.includes('data-message-author-role="user"')) return messages;
    return [];
  }}
}};

function diagnosticsFor(job) {{
  return bridgeMessages
    .filter((message) => message.path === '/bridge/diagnostic')
    .map((message) => JSON.parse(message.body))
    .filter((event) => event.job_id === job);
}}
function assertOrdered(codes, expected) {{
  let position = -1;
  for (const code of expected) {{
    const next = codes.indexOf(code, position + 1);
    if (next < 0) throw Error(`missing/out-of-order diagnostic ${{code}} in ${{codes}}`);
    position = next;
  }}
}}

(async () => {{
  const successJob = 'plan-' + '1'.repeat(24);
  activeJob = successJob;
  const success = await api.processRequest({{
    lane: 'plan', job_id: successJob, operation: 'PLAN_GPT',
    conversation_url: sandbox.location.href, packet: 'SUCCESS_PACKET',
    response_timeout_ms: 1000, response_stability_ms: 2, response_poll_ms: 1
  }});
  if (!success || clicks !== 1) throw Error('successful send boundary did not complete once');
  const successEvents = diagnosticsFor(successJob);
  const successCodes = successEvents.map((event) => event.code);
  assertOrdered(successCodes, [
    'CLAIM_ACQUIRED', 'DOM_PROBE', 'PACKET_INSERTED', 'SEND_BUTTON_READY',
    'SEND_ATTEMPTED', 'SEND_CLICK_RETURNED', 'ASSISTANT_RESPONSE_OBSERVED',
    'RESULT_POST_ATTEMPTED', 'RESULT_ACCEPTED'
  ]);
  if (successEvents.some((event) => event.job_id !== successJob)) throw Error('diagnostic job mismatch');
  if (successEvents.some((event) => JSON.stringify(event).includes('super-secret-token'))) {{
    throw Error('diagnostic body leaked bridge token');
  }}
  messages = [
    roleNode('user', 'SUCCESS_PACKET'),
    roleNode('user', 'UNRELATED_LATER_PACKET'),
    roleNode('assistant', 'unrelated answer')
  ];
  const boundedHistory = api.exactConversationObservation('SUCCESS_PACKET');
  if (!boundedHistory.exact_user_packet_observed || boundedHistory.assistant_response !== null) {{
    throw Error('assistant after a later user message contaminated exact recovery');
  }}

  bridgeMessages.length = 0;
  text = '';
  messages = [];
  clickMode = 'timeout';
  const timeoutJob = 'plan-' + '2'.repeat(24);
  activeJob = timeoutJob;
  let timedOut = false;
  try {{
    await api.processRequest({{
      lane: 'plan', job_id: timeoutJob, operation: 'PLAN_GPT',
      conversation_url: sandbox.location.href, packet: 'TIMEOUT_PACKET',
      response_timeout_ms: 10, response_stability_ms: 2, response_poll_ms: 1
    }});
  }} catch (error) {{
    timedOut = String(error).includes('timed out');
    await api.reportDiagnostic('plan', timeoutJob, 'POLL_ERROR', String(error));
  }}
  if (!timedOut || clicks !== 2) throw Error('post-Send timeout was not exercised');
  let timeoutEvents = diagnosticsFor(timeoutJob);
  let timeoutCodes = timeoutEvents.map((event) => event.code);
  assertOrdered(timeoutCodes, [
    'SEND_ATTEMPTED', 'SEND_CLICK_RETURNED', 'RESPONSE_TIMEOUT', 'POLL_ERROR'
  ]);
  const lateResponse = '{{"job_id":"' + timeoutJob + '","operation":"PLAN_GPT","decision":"SPEC","body":"late"}}';
  messages.push(roleNode('assistant', lateResponse));
  const replay = await api.processRequest({{
    lane: 'plan', job_id: timeoutJob, operation: 'PLAN_GPT',
    conversation_url: sandbox.location.href, packet: 'TIMEOUT_PACKET',
    response_timeout_ms: 1000, response_stability_ms: 2, response_poll_ms: 1
  }});
  if (replay !== true || clicks !== 2) throw Error('late response was not harvested without re-Send');
  timeoutEvents = diagnosticsFor(timeoutJob);
  if (timeoutEvents.filter((event) => event.code === 'SEND_ATTEMPTED').length !== 1) {{
    throw Error('SEND_ATTEMPTED was duplicated');
  }}
  if (!timeoutEvents.some((event) => event.code === 'EXACT_JOB_USER_MESSAGE_OBSERVED')) {{
    throw Error('exact job DOM recovery evidence was absent');
  }}
  if (!timeoutEvents.some((event) => event.code === 'RESULT_ACCEPTED')) {{
    throw Error('late response did not traverse the bridge result path');
  }}

  bridgeMessages.length = 0;
  text = '';
  messages = [];
  const noCorrelationJob = 'plan-' + 'f'.repeat(24);
  activeJob = noCorrelationJob;
  let noCorrelationTimedOut = false;
  try {{
    await api.processRequest({{
      lane: 'plan', job_id: noCorrelationJob, operation: 'PLAN_GPT',
      conversation_url: sandbox.location.href, packet: 'NO_CORRELATION_PACKET',
      response_timeout_ms: 10, response_stability_ms: 2, response_poll_ms: 1
    }});
  }} catch (error) {{ noCorrelationTimedOut = String(error).includes('timed out'); }}
  messages = [];
  const noCorrelationReplay = await api.processRequest({{
    lane: 'plan', job_id: noCorrelationJob, operation: 'PLAN_GPT',
    conversation_url: sandbox.location.href, packet: 'NO_CORRELATION_PACKET',
    response_timeout_ms: 10, response_stability_ms: 2, response_poll_ms: 1
  }});
  if (!noCorrelationTimedOut || noCorrelationReplay !== false || clicks !== 3) {{
    throw Error('missing post-Send correlation did not fail closed');
  }}
  const noCorrelationCodes = diagnosticsFor(noCorrelationJob).map((event) => event.code);
  if (noCorrelationCodes.filter((code) => code === 'SEND_ATTEMPTED').length !== 1 ||
      !noCorrelationCodes.includes('SEND_ATTEMPT_ALREADY_RECORDED')) {{
    throw Error('missing correlation permitted a duplicate Send');
  }}

  bridgeMessages.length = 0;
  text = '';
  messages = [];
  sendAvailable = false;
  const beforeJob = 'plan-' + '3'.repeat(24);
  activeJob = beforeJob;
  const before = await api.processRequest({{
    lane: 'plan', job_id: beforeJob, operation: 'PLAN_GPT',
    conversation_url: sandbox.location.href, packet: 'NO_SEND_PACKET',
    response_timeout_ms: 1000
  }});
  const beforeCodes = diagnosticsFor(beforeJob).map((event) => event.code);
  if (before !== false || beforeCodes.includes('SEND_ATTEMPTED')) {{
    throw Error('pre-Send failure was classified as attempted');
  }}
  if (!beforeCodes.includes('SEND_BUTTON_NOT_FOUND')) throw Error('pre-Send boundary missing');

  bridgeMessages.length = 0;
  text = '';
  messages = [];
  sendAvailable = true;
  rejectSendBoundaryDiagnostic = true;
  const sinkJob = 'plan-' + '4'.repeat(24);
  activeJob = sinkJob;
  let sinkFailed = false;
  try {{
    await api.processRequest({{
      lane: 'plan', job_id: sinkJob, operation: 'PLAN_GPT',
      conversation_url: sandbox.location.href, packet: 'SINK_FAILURE_PACKET',
      response_timeout_ms: 1000
    }});
  }} catch (error) {{ sinkFailed = String(error).includes('diagnostic'); }}
  if (!sinkFailed || clicks !== 3) throw Error('failed evidence sink did not fence click');
  const sinkCodes = diagnosticsFor(sinkJob).map((event) => event.code);
  if (!sinkCodes.includes('SEND_ATTEMPTED') || sinkCodes.includes('SEND_CLICK_RETURNED')) {{
    throw Error('sink failure boundary was misclassified');
  }}
  console.log('ok');
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_response_completion_requires_stable_exact_dom_candidate(self) -> None:
        content = EXTENSION / "content.js"
        script = f"""
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto').webcrypto;
const {{TextEncoder}} = require('util');
const hostSetImmediate = setImmediate;
let clock = 0;
class FakeDate extends Date {{ static now() {{ return clock; }} }}
const bridgeMessages = [];
const sandbox = {{
  module: {{exports: {{}}}}, console, URL, TextEncoder, crypto: nodeCrypto, Date: FakeDate,
  InputEvent: class {{}},
  setTimeout: (fn, ms) => {{ clock += Number(ms) || 0; hostSetImmediate(fn); }}
}};
sandbox.globalThis = sandbox;
sandbox.getComputedStyle = () => ({{display: '', visibility: ''}});
sandbox.location = {{href: 'https://chatgpt.com/c/plan-lane'}};
sandbox.browser = {{runtime: {{sendMessage: async (message) => {{
  bridgeMessages.push(message);
  return {{ok: true, status: 200, body: '{{}}'}};
}}}}}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(content))}, 'utf8'), sandbox);
const api = sandbox.module.exports;

let frames = [];
let frameIndex = 0;
let packet = '';
let renderedUser = '';
let composerText = '';
let clicks = 0;
function currentFrame() {{ return frames[Math.min(frameIndex, frames.length - 1)]; }}
function roleNode(role, value) {{
  return {{
    innerText: value, textContent: value, hidden: false,
    getAttribute: (name) => name === 'data-message-author-role' ? role : null
  }};
}}
const composer = {{
  tagName: 'DIV', hidden: false, focus: () => {{}}, dispatchEvent: () => {{}},
  getAttribute: () => null
}};
Object.defineProperty(composer, 'textContent', {{
  get: () => composerText,
  set: (value) => {{ composerText = String(value); }}
}});
const send = {{
  disabled: false, hidden: false, getAttribute: () => null,
  click: () => {{ clicks += 1; }}
}};
sandbox.document = {{
  querySelector: (selector) => {{
    if (selector.includes('stop')) return currentFrame()?.generation ? roleNode('button', '') : null;
    if (selector === 'div#prompt-textarea[contenteditable="true"]') return composer;
    if (selector === 'button[data-testid="send-button"]') return composerText ? send : null;
    return null;
  }},
  querySelectorAll: (selector) => {{
    const frame = currentFrame() || {{generation: false, text: null}};
    let nodes = [];
    if (selector === '[data-message-author-role="assistant"]') {{
      if (frame.text !== null) nodes = [roleNode('assistant', frame.text)];
    }} else if (selector.includes('data-message-author-role="user"')) {{
      nodes = [roleNode('user', renderedUser)];
      if (frame.later_user) nodes.push(roleNode('user', 'UNRELATED_LATER_PACKET'));
      if (frame.text !== null) nodes.push(roleNode('assistant', frame.text));
      frameIndex += 1;
    }}
    return nodes;
  }}
}};

function reset(nextPacket, nextFrames) {{
  clock = 0;
  packet = nextPacket;
  renderedUser = nextPacket;
  frames = nextFrames;
  frameIndex = 0;
  bridgeMessages.length = 0;
  composerText = '';
}}
function diagnostics(job) {{
  return bridgeMessages
    .filter((message) => message.path === '/bridge/diagnostic')
    .map((message) => JSON.parse(message.body))
    .filter((event) => event.job_id === job);
}}
async function wait(job, timeout = 10000) {{
  return api.waitForResponse({{
    lane: 'plan', job_id: job, packet,
    response_timeout_ms: timeout, response_stability_ms: 1000, response_poll_ms: 500
  }});
}}

(async () => {{
  const markerProbe = 'judge-' + 'd'.repeat(24);
  if (!api.exactJobMarkerInText(`prefix ${{markerProbe}} suffix`, markerProbe) ||
      api.exactJobMarkerInText(`${{markerProbe}}f`, markerProbe) ||
      api.exactJobMarkerInText(`x${{markerProbe}}`, markerProbe)) {{
    throw Error('exact job marker boundaries were weakened');
  }}
  if (api.responseTimeoutMs({{}}) !== 900000 ||
      api.responseStabilityMs({{}}) !== 2500 || api.responsePollMs({{}}) !== 500) {{
    throw Error('production response stabilization defaults changed');
  }}
  let invalidOrdering = false;
  try {{
    await api.waitForResponse({{
      lane: 'plan', job_id: 'plan-' + '0'.repeat(24), packet: 'ORDERING_PACKET',
      response_timeout_ms: 1000, response_stability_ms: 1000, response_poll_ms: 500
    }});
  }} catch (error) {{ invalidOrdering = String(error).includes('shorter than response timeout'); }}
  if (!invalidOrdering) throw Error('invalid response timeout ordering was accepted');

  const longJob = 'plan-' + '4'.repeat(24);
  const longResponse = '{{"job_id":"' + longJob + '","operation":"PLAN_GPT","decision":"SPEC","body":"long"}}';
  reset('LONG_PACKET_' + longJob, [
    ...Array.from({{length: 485}}, () => ({{generation: true, text: null}})),
    {{generation: false, text: longResponse}},
    {{generation: false, text: longResponse}},
    {{generation: false, text: longResponse}}
  ]);
  if (await wait(longJob, 300000) !== longResponse || clock <= 240000) {{
    throw Error('response exceeding the former 240s limit was not observed');
  }}

  const flapJob = 'plan-' + '5'.repeat(24);
  const partialOne = '{{"job_id":"pla';
  const partialTwo = '{{"job_id":"plan-dd924';
  const partialThree = '{{"job_id":"plan-dd924e1335d1255e0dca1fa4"';
  const finalValid = '{{"job_id":"' + flapJob + '","operation":"PLAN_GPT","decision":"SPEC","body":"super-secret-response"}}';
  reset('FLAP_PACKET', [
    {{generation: true, text: partialOne}},
    {{generation: false, text: partialTwo}},
    {{generation: true, text: partialThree}},
    {{generation: false, text: finalValid}},
    {{generation: false, text: finalValid}},
    {{generation: false, text: finalValid}}
  ]);
  const flapResult = await wait(flapJob);
  if (flapResult !== finalValid) throw Error('generation flap returned a partial response');
  const flapEvents = diagnostics(flapJob);
  const flapCodes = flapEvents.map((event) => event.code);
  if (!flapCodes.includes('ASSISTANT_RESPONSE_CANDIDATE') ||
      !flapCodes.includes('ASSISTANT_RESPONSE_CHANGED') ||
      !flapCodes.includes('ASSISTANT_RESPONSE_STABLE')) {{
    throw Error('generation flap diagnostics were incomplete');
  }}
  if (flapCodes.indexOf('ASSISTANT_RESPONSE_STABLE') < flapCodes.indexOf('ASSISTANT_RESPONSE_CHANGED')) {{
    throw Error('partial response was marked stable before reset');
  }}
  for (const event of flapEvents.filter((event) => event.code.startsWith('ASSISTANT_RESPONSE_'))) {{
    const detail = JSON.parse(event.detail);
    if (!Number.isInteger(detail.length) || !/^[0-9a-f]{{64}}$/.test(detail.sha256)) {{
      throw Error('response diagnostic metadata is incomplete');
    }}
    if (event.detail.includes('super-secret-response')) throw Error('raw response leaked to diagnostics');
  }}

  const growthJob = 'plan-' + '6'.repeat(24);
  reset('GROWTH_PACKET', [
    {{generation: false, text: 'a'}},
    {{generation: false, text: 'ab'}},
    {{generation: false, text: 'abc'}},
    {{generation: false, text: 'abc'}},
    {{generation: false, text: 'abc'}}
  ]);
  if (await wait(growthJob) !== 'abc') throw Error('growing response did not stabilize at final text');
  if (diagnostics(growthJob).filter((event) => event.code === 'ASSISTANT_RESPONSE_CHANGED').length < 2) {{
    throw Error('text growth did not reset stability');
  }}

  const malformedJob = 'plan-' + '7'.repeat(24);
  const malformed = '{{"job_id":"unterminated';
  reset('MALFORMED_PACKET', [
    {{generation: false, text: malformed}},
    {{generation: false, text: malformed}},
    {{generation: false, text: malformed}}
  ]);
  if (await wait(malformedJob) !== malformed) throw Error('stable malformed text was repaired or changed');

  const timeoutJob = 'plan-' + '8'.repeat(24);
  reset('TIMEOUT_PACKET', [{{generation: false, text: null}}]);
  let timedOut = false;
  try {{ await wait(timeoutJob, 2000); }} catch (error) {{ timedOut = String(error).includes('timed out'); }}
  if (!timedOut || !diagnostics(timeoutJob).some((event) => event.code === 'RESPONSE_TIMEOUT')) {{
    throw Error('missing bounded response timeout');
  }}

  const isolationJob = 'plan-' + '9'.repeat(24);
  reset('EXACT_PACKET', [{{generation: false, text: 'unrelated answer', later_user: true}}]);
  timedOut = false;
  try {{ await wait(isolationJob, 2000); }} catch (error) {{ timedOut = String(error).includes('timed out'); }}
  if (!timedOut) throw Error('assistant after a later user crossed exact packet boundary');

  const recoveryJob = 'plan-' + 'a'.repeat(24);
  const recoveryText = '{{"job_id":"' + recoveryJob + '","operation":"PLAN_GPT","decision":"SPEC","body":"recovered"}}';
  reset('RECOVERY_PACKET', [
    {{generation: false, text: recoveryText}},
    {{generation: false, text: recoveryText}},
    {{generation: false, text: recoveryText}}
  ]);
  renderedUser = `ChatGPT rendered current job ${{recoveryJob}} without the full packet`;
  const recovered = await api.processRequest({{
    lane: 'plan', job_id: recoveryJob, operation: 'PLAN_GPT',
    conversation_url: sandbox.location.href, packet,
    response_timeout_ms: 10000, response_stability_ms: 1000, response_poll_ms: 500
  }});
  if (!recovered || clicks !== 0) throw Error('DOM recovery sent a duplicate request');
  const recoveryCodes = diagnostics(recoveryJob).map((event) => event.code);
  const stableIndex = recoveryCodes.indexOf('ASSISTANT_RESPONSE_STABLE');
  const postIndex = recoveryCodes.indexOf('RESULT_POST_ATTEMPTED');
  if (stableIndex < 0 || postIndex <= stableIndex) throw Error('recovery relayed before stable response');
  if (!recoveryCodes.includes('EXACT_JOB_USER_MESSAGE_OBSERVED')) {{
    throw Error('fresh exact-job DOM correlation was not used');
  }}

  const wrongJob = 'plan-' + 'b'.repeat(24);
  reset('WRONG_JOB_PACKET_' + wrongJob, [{{generation: false, text: recoveryText}}]);
  renderedUser = 'rendered different job plan-' + 'c'.repeat(24);
  const wrongObservation = api.currentJobConversationObservation({{
    job_id: wrongJob, packet
  }});
  if (wrongObservation.exact_job_user_observed || wrongObservation.assistant_response !== null) {{
    throw Error('wrong job user message was accepted as recovery correlation');
  }}
  const wrongConversation = await api.processRequest({{
    lane: 'plan', job_id: wrongJob, operation: 'PLAN_GPT',
    conversation_url: 'https://chatgpt.com/c/different-conversation', packet,
    response_timeout_ms: 10000, response_stability_ms: 1000, response_poll_ms: 500
  }});
  if (wrongConversation !== false || clicks !== 0) {{
    throw Error('wrong conversation recovered or sent the current job');
  }}
  console.log('ok');
}})().catch((error) => {{ console.error(error); process.exit(1); }});
"""
        result = subprocess.run(
            ["node", "-e", script], capture_output=True, text=True, check=False
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ok", result.stdout)

    def test_contenteditable_uses_editor_native_insert_and_rejects_dom_only_false_positive(self) -> None:
        content = EXTENSION / "content.js"
        script = f"""
const fs = require('fs');
const vm = require('vm');
const sandbox = {{
  module: {{exports: {{}}}}, console, URL, setTimeout,
  InputEvent: class {{}}, Event: class {{}}
}};
sandbox.globalThis = sandbox;
sandbox.getComputedStyle = () => ({{display: '', visibility: ''}});
let text = '';
let editorState = '';
let execCalls = 0;
const composer = {{
  tagName: 'DIV', hidden: false, focus: () => {{}}, getAttribute: () => null,
  dispatchEvent: () => {{}}
}};
Object.defineProperty(composer, 'textContent', {{
  get: () => text,
  set: (value) => {{
    text = String(value);
    if (!editorState) setTimeout(() => {{ text = ''; }}, 5);
  }}
}});
const selection = {{removeAllRanges: () => {{}}, addRange: () => {{}}}};
sandbox.getSelection = () => selection;
sandbox.document = {{
  createRange: () => ({{selectNodeContents: () => {{}}}}),
  execCommand: (command, _ui, value) => {{
    if (command !== 'insertText') return false;
    execCalls += 1;
    editorState = String(value);
    text = editorState;
    return true;
  }},
  querySelector: (selector) => selector === 'div#prompt-textarea[contenteditable="true"]' ? composer : null,
  querySelectorAll: () => []
}};
vm.runInNewContext(fs.readFileSync({json.dumps(str(content))}, 'utf8'), sandbox);
const api = sandbox.module.exports;
(async () => {{
  const method = api.setComposer(composer, 'PACKET');
  if (method !== 'contenteditable-execCommand-insertText') throw Error('native contenteditable insert was not preferred');
  if (execCalls !== 1) throw Error('execCommand insertText was not invoked exactly once');
  if (!(await api.composerInsertionStable('PACKET'))) throw Error('accepted editor text did not remain stable');

  editorState = '';
  text = '';
  sandbox.document.execCommand = () => false;
  const fallback = api.setComposer(composer, 'EPHEMERAL');
  if (fallback !== 'contenteditable-dom-fallback') throw Error('fallback path not exercised');
  if (await api.composerInsertionStable('EPHEMERAL')) throw Error('DOM-only false positive survived async verification');
  console.log('ok');
}})().catch((error) => {{ console.error(error); process.exit(1); }});
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
