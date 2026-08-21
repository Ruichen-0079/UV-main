from __future__ import annotations

from pathlib import Path
import subprocess
import tempfile
import unittest

from tools.agentbus_v2.webui import POLISHED_INDEX_HTML


class WebUIInteractionTests(unittest.TestCase):
    """Exercise the browser-local editor/refresh contract in a real JS runtime."""

    def test_editors_and_auto_refresh_preserve_interaction(self) -> None:
        script = POLISHED_INDEX_HTML[
            POLISHED_INDEX_HTML.index("<script>") + len("<script>") :
            POLISHED_INDEX_HTML.index("</script>")
        ].replace("__TOKEN__", '"test-token"')
        harness = r'''
const elements = new Map();
const details = {dataset:{pId:'P1'}, open:false};
const advanced = {open:false, setAttribute(){}};
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, value:'', innerHTML:'', textContent:'', open:false,
    focus(){document.activeElement=this}, scrollIntoView(){}, replaceChildren(){},
  });
  return elements.get(id);
}
globalThis.document = {
  activeElement:null,
  getElementById:element,
  querySelector(selector) {
    if (selector === '.advanced') return advanced;
    if (selector === '.advanced[open]') return advanced.open ? advanced : null;
    if (selector === '.task-details[open]') return details.open ? details : null;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '.task-details[open]' || selector === '.task-details[data-p-id]') return [details];
    return [];
  },
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = fn => fn();
globalThis.setInterval = () => 0;
globalThis.setTimeout = () => 0;
const fixture = {
  scheduler:{running:true}, browser_transport:{plan:{pending:0},judge:{pending:0},legacy_v1_extension:'ONLINE',mailbox:'available'},
  executors:[], attention:[], active:[], paused:[], archived:[],
  projects:[{p_id:'P1',active:true,enabled:true,archived:false,plan_binding:{bound:false,conversation_url:null},operator_directive:null,primary_action:null,status_code:'AWAITING_PLAN_BINDING',semantic_status:'等待 PLAN',block_reason:'',action:'PLAN',evidence:[]}],
  gpt_conversations:{judge:{bound:true,conversation_url:'https://chatgpt.com/c/judge'},block:{bound:false,conversation_url:null,auto_diagnosis_enabled:false},per_p_plan:[{p_id:'P1',bound:false,conversation_url:null}]},
  block_gpt:{enabled:false,bound:false,conversation_url:null}, events:[],
};
fixture.active=fixture.projects;
function scriptHasTaskIdentity(){return document.getElementById('task-list').innerHTML.includes('data-p-id="P1"')}
let calls=[];
let failure=false;
globalThis.fetch = async (url, options={}) => {
  const method=options.method||'GET'; calls.push(method);
  if (method==='POST' && failure) return {ok:false,status:422,json:async()=>({error:'collision'})};
  return {ok:true,status:200,json:async()=>fixture};
};
''' + script + r'''
(async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  await new Promise(resolve=>setImmediate(resolve));
  if (!scriptHasTaskIdentity()) throw Error('task Details lack stable P identity');
  toggleBlockEditor();
  if (!ui.editingBlock) throw Error('BLOCK editor did not open');
  if ((document.getElementById('gpt-conversations').innerHTML.match(/id="block-url"/g)||[]).length !== 1) throw Error('BLOCK editor is not canonical');
  if (document.getElementById('block-gpt-controls').innerHTML.includes('id="block-url"')) throw Error('Advanced owns duplicate BLOCK editor');
  ui.drafts.blockUrl='typed-block';
  const before= document.getElementById('gpt-conversations').innerHTML;
  await autoRefresh();
  if (document.getElementById('gpt-conversations').innerHTML !== before) throw Error('auto refresh replaced BLOCK editor');
  document.getElementById('block-url').value='typed-block'; failure=true; await saveBlockBinding();
  if (!ui.editingBlock || ui.drafts.blockUrl !== 'typed-block') throw Error('failed BLOCK save lost draft');
  failure=false; toggleBlockEditor();
  if (ui.editingBlock || ui.drafts.blockUrl !== null) throw Error('BLOCK cancel did not clear draft');
  ui.editingJudge=true; ui.drafts.judgeUrl='typed-judge'; render(ui.current); const judgeBefore=document.getElementById('gpt-conversations').innerHTML; await refresh();
  if (!ui.editingJudge || document.getElementById('gpt-conversations').innerHTML !== judgeBefore) throw Error('JUDGE draft was reset by refresh');
  ui.editingPlan='P1'; ui.drafts.planUrls.P1='typed-plan'; render(ui.current); const planBefore=document.getElementById('task-list').innerHTML; await autoRefresh();
  if (document.getElementById('task-list').innerHTML !== planBefore) throw Error('PLAN editor was reset by auto refresh');
  ui.editingDirective='P1'; ui.drafts.directives.P1='typed-directive'; render(ui.current); await autoRefresh();
  if (ui.drafts.directives.P1 !== 'typed-directive') throw Error('directive draft was reset');
  showForm('create'); ui.drafts.form['f-pid']='typed-p'; render(ui.current); await autoRefresh();
  if (!document.getElementById('forms').innerHTML.includes('typed-p')) throw Error('create form draft was reset');
  ui.form=null; ui.editingJudge=null; ui.editingPlan=null; ui.editingDirective=null; render(ui.current);
  ui.tab='archived'; details.open=true; advanced.open=true; render(ui.current);
  if (ui.tab!=='archived' || !details.open || !advanced.open) throw Error('disclosure/tab state was not preserved');
  const postCount=calls.filter(x=>x==='POST').length; await autoRefresh();
  if (calls.filter(x=>x==='POST').length !== postCount) throw Error('auto refresh issued POST');
  console.log('webui interaction contract PASS');
})().catch(error=>{console.error(error);process.exit(1)});
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "webui-interaction.js"
            path.write_text(harness, encoding="utf-8")
            result = subprocess.run(
                ["node", str(path)], capture_output=True, text=True, check=False
            )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("webui interaction contract PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
