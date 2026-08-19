"use strict";

// Small dependency-free runtime tests for the two plain WebExtension scripts.
// This file is not packaged into the XPI; it loads the real source in a VM so
// submission and watchdog assertions cannot drift from the shipped code.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = __dirname;

function loadScript(name, globals, exportNames) {
  const context = {
    console,
    Date,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    clearTimeout,
    setTimeout,
    ...globals
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(ROOT, name), "utf8");
  const exportExpression = `{${exportNames.join(",")}}`;
  vm.runInContext(`${source}\nthis.__testExports = ${exportExpression};`, context, { filename: name });
  return { context, exports: context.__testExports };
}

function node(text, extra = {}) {
  return {
    textContent: text,
    innerText: text,
    hidden: false,
    getAttribute: () => null,
    ...extra
  };
}

function contentFixture() {
  const state = {
    composer: {
      tagName: "TEXTAREA",
      value: "",
      disabled: false,
      focus() {},
      getAttribute: () => null,
      dispatchEvent() {}
    },
    send: {
      disabled: false,
      clicks: 0,
      getAttribute: () => null,
      click() { this.clicks += 1; }
    },
    users: [],
    stops: []
  };
  const document = {
    title: "ChatGPT",
    body: { innerText: "" },
    querySelector(selector) {
      if (selector.includes("prompt-textarea")) return state.composer;
      if (selector.includes("send-button") || selector.includes("Send prompt")) return state.send;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("conversation-turn-user") || selector.includes("message-author-role")) {
        return state.users;
      }
      if (selector.includes("stop") || selector.includes("generating") || selector.includes("streaming")) {
        return state.stops;
      }
      return [];
    },
    createElement() {
      return { textContent: "" };
    }
  };
  return { state, document };
}

async function testContentRuntime() {
  const fixture = contentFixture();
  function TextAreaElement() {}
  Object.defineProperty(TextAreaElement.prototype, "value", {
    get() { return this._value || ""; },
    set(value) { this._value = value; }
  });
  const loaded = loadScript("content.js", {
    document: fixture.document,
    location: { pathname: "/c/test" },
    HTMLTextAreaElement: TextAreaElement,
    InputEvent: class { constructor(type, init) { this.type = type; this.init = init; } },
    Event: class { constructor(type, init) { this.type = type; this.init = init; } }
  }, [
    "containsExactJobId",
    "isJobIdVisibleInUserTurn",
    "submissionEvidence",
    "submitPrompt",
    "waitForSubmissionConfirmation"
  ]);
  const c = loaded.exports;
  const job = "product_gpt:final_review:s1:abc123";
  fixture.state.composer.value = "prompt";

  fixture.state.users = [];
  fixture.state.stops = [];
  fixture.state.send.clicks = 0;
  const unconfirmed = await c.submitPrompt("prompt", job, { settleMs: 0, confirmTimeoutMs: 0 });
  assert.equal(unconfirmed.code, "SUBMIT_NOT_CONFIRMED");
  assert.equal(fixture.state.send.clicks, 1, "the click is attempted once but not treated as proof");

  assert.equal(
    await c.waitForSubmissionConfirmation(
      job,
      fixture.state.composer,
      { initialText: "prompt", stopVisible: false, userTurnVisible: false },
      { timeoutMs: 0 }
    ),
    null,
    "click without a semantic transition must not confirm"
  );

  fixture.state.composer.value = "";
  assert.equal(
    c.submissionEvidence(job, fixture.state.composer, {
      initialText: "prompt",
      stopVisible: false,
      userTurnVisible: false
    }),
    "COMPOSER_EMPTY"
  );

  fixture.state.composer.value = "prompt";
  fixture.state.stops = [node("", { getAttribute: (name) => name === "data-testid" ? "stop-button" : null })];
  assert.equal(
    c.submissionEvidence(job, fixture.state.composer, {
      initialText: "prompt",
      stopVisible: false,
      userTurnVisible: false
    }),
    "GENERATING"
  );

  fixture.state.stops = [];
  const observedStop = await c.waitForSubmissionConfirmation(
    job,
    fixture.state.composer,
    { initialText: "prompt", stopVisible: false, userTurnVisible: false },
    {
      timeoutMs: 100,
      pollMs: 0,
      sleep: async () => {
        fixture.state.stops = [node("generating")];
      }
    }
  );
  assert.equal(observedStop, "GENERATING");

  fixture.state.stops = [];
  fixture.state.users = [node(`user prompt JOB_ID=${job}`)];
  assert.equal(c.isJobIdVisibleInUserTurn(job), true);
  assert.equal(
    c.submissionEvidence(job, fixture.state.composer, {
      initialText: "prompt",
      stopVisible: false,
      userTurnVisible: false
    }),
    "USER_TURN"
  );
  assert.equal(c.containsExactJobId(`assistant repeats ${job}`, job), true);
  fixture.state.users = [];
  assert.equal(c.isJobIdVisibleInUserTurn(job), false, "assistant nodes are not user-turn evidence");
  fixture.state.users = [node(`user prompt JOB_ID=${job}-similar`)];
  assert.equal(c.isJobIdVisibleInUserTurn(job), false, "similar job IDs do not match");

  fixture.state.users = [node(`user prompt JOB_ID=${job}`)];
  fixture.state.send.clicks = 0;
  const duplicate = await c.submitPrompt("new prompt", job);
  assert.equal(duplicate.code, "ALREADY_SUBMITTED_VISIBLE");
  assert.equal(fixture.state.send.clicks, 0, "visible exact job suppresses duplicate click");
}

function backgroundFixture() {
  const stored = { jobs: {}, lastSubmitAt: 0 };
  const state = { visible: true, responses: 0 };
  const browser = {
    storage: {
      local: {
        async get() { return stored; },
        async set(value) { Object.assign(stored, value); }
      }
    },
    tabs: {
      async query() { return [{ id: 1, url: "https://chatgpt.com/c/test", status: "complete" }]; },
      async get() { return { id: 1, status: "complete" }; },
      async sendMessage() {
        state.responses += 1;
        if (state.responseCode) return state.responseCode;
        return state.visible
          ? { ok: true, visible: true, code: "ALREADY_SUBMITTED_VISIBLE" }
          : { ok: true, visible: false, code: "NOT_SUBMITTED_VISIBLE" };
      }
    },
    runtime: {}
  };
  return { browser, state, stored };
}

async function testBackgroundRuntime() {
  const fixture = backgroundFixture();
  const loaded = loadScript("background.js", { browser: fixture.browser }, [
    "markWaitingForGithub",
    "bridgeProjection",
    "schedulerProjection",
    "waitingWatchdogDue",
    "watchdogWaitingForGithub",
    "WAITING_FOR_GITHUB_WATCHDOG_MS",
    "tick"
  ]);
  const b = loaded.exports;
  const old = Date.now() - b.WAITING_FOR_GITHUB_WATCHDOG_MS - 1;
  const job = { job_id: "product_gpt:plan_spec:s1:gen", conversation_url: "https://chatgpt.com/c/test" };
  const visible = { state: "WAITING_FOR_GITHUB", submittedAt: old, nextWatchdogAt: old };
  assert.equal(b.waitingWatchdogDue(visible, Date.now()), true);
  assert.equal(b.waitingWatchdogDue({ state: "WAITING_FOR_GITHUB" }, Date.now()), true);
  await b.watchdogWaitingForGithub(job, visible);
  assert.equal(visible.state, "WAITING_FOR_GITHUB");
  assert.equal(visible.lastError, "SUBMITTED_VISIBLE_WAITING_GITHUB");
  assert.equal(visible.nextWatchdogAt > Date.now(), true);
  assert.equal(fixture.state.responses, 1);

  fixture.state.visible = false;
  const missing = { state: "WAITING_FOR_GITHUB", submittedAt: old, nextWatchdogAt: old };
  await b.watchdogWaitingForGithub(job, missing);
  assert.equal(missing.state, "BACKOFF");
  assert.equal(missing.lastError, "SUBMISSION_NOT_VISIBLE_RETRY");
  assert.equal(missing.submittedAt, null);

  const projected = b.schedulerProjection({ jobs: {
    [job.job_id]: {
      role: "PRODUCT_GPT",
      task: "PLAN_SPEC",
      state: "WAITING_FOR_GITHUB",
      attempts: 1,
      submittedAt: old,
      lastError: "SUBMITTED_VISIBLE_WAITING_GITHUB",
      prompt: "must not be projected"
    }
  }});
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), {
    job_id: job.job_id,
    role: "PRODUCT_GPT",
    task: "PLAN_SPEC",
    state: "WAITING_FOR_GITHUB",
    attempts: 1,
    submitted_at: old,
    next_attempt_at: null,
    last_error: "SUBMITTED_VISIBLE_WAITING_GITHUB"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(projected, "prompt"), false);
  assert.equal(b.bridgeProjection({ bridgeStatus: "OFFLINE", jobs: {} }).bridge, "OFFLINE");
  assert.equal(
    b.bridgeProjection({ bridgeStatus: "ONLINE", jobs: { [job.job_id]: { state: "AUTH_REQUIRED" } } }).bridge,
    "AUTH_REQUIRED"
  );

  const tickContext = loaded.context;
  const tickJob = {
    job_id: "product_gpt:plan_spec:s1:tick-gen",
    role: "PRODUCT_GPT",
    task: "PLAN_SPEC",
    conversation_url: "https://chatgpt.com/c/test",
    prompt: "contains no server authority"
  };
  tickContext.fetch = async () => ({ ok: true, json: async () => ({ jobs: [] }) });
  fixture.stored.jobs = {
    [tickJob.job_id]: { state: "WAITING_FOR_GITHUB", submittedAt: old, updatedAt: old }
  };
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "DONE");

  fixture.stored.lastSubmitAt = Date.now();
  fixture.stored.jobs = {
    [tickJob.job_id]: { state: "WAITING_FOR_GITHUB", submittedAt: old, nextWatchdogAt: old }
  };
  fixture.state.visible = true;
  tickContext.fetch = async () => ({ ok: true, json: async () => ({ jobs: [tickJob] }) });
  const beforeVisibleCheck = fixture.state.responses;
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "WAITING_FOR_GITHUB");
  assert.equal(fixture.stored.jobs[tickJob.job_id].lastError, "SUBMITTED_VISIBLE_WAITING_GITHUB");
  assert.equal(fixture.state.responses, beforeVisibleCheck + 1);

  fixture.state.visible = false;
  fixture.stored.jobs = {
    [tickJob.job_id]: { state: "WAITING_FOR_GITHUB", submittedAt: old, nextWatchdogAt: old }
  };
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "BACKOFF");
  assert.equal(fixture.stored.jobs[tickJob.job_id].lastError, "SUBMISSION_NOT_VISIBLE_RETRY");

  fixture.stored.lastSubmitAt = Date.now();
  fixture.stored.jobs = {
    [tickJob.job_id]: { state: "SUBMITTING", updatedAt: old, attempts: 0 }
  };
  fixture.state.visible = false;
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "BACKOFF");

  const newJob = { ...tickJob, job_id: "product_gpt:plan_spec:s1:new-generation" };
  fixture.stored.jobs = {
    [tickJob.job_id]: { state: "WAITING_FOR_GITHUB", submittedAt: old },
  };
  tickContext.fetch = async () => ({ ok: true, json: async () => ({ jobs: [newJob] }) });
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "DONE");
  assert.equal(fixture.stored.jobs[newJob.job_id].state, "QUEUED");

  fixture.stored.lastSubmitAt = 0;
  fixture.stored.jobs = { [tickJob.job_id]: { state: "QUEUED", attempts: 0 } };
  fixture.state.responseCode = { ok: false, code: "AUTH_REQUIRED" };
  tickContext.fetch = async () => ({ ok: true, json: async () => ({ jobs: [tickJob] }) });
  await b.tick();
  assert.equal(fixture.stored.jobs[tickJob.job_id].state, "AUTH_REQUIRED");
  fixture.state.responseCode = null;

  const offline = { ...fixture.stored.jobs };
  tickContext.fetch = async () => { throw new Error("offline"); };
  await b.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.stored.jobs)), JSON.parse(JSON.stringify(offline)));
}

Promise.resolve()
  .then(testContentRuntime)
  .then(testBackgroundRuntime)
  .then(() => console.log("browser extension runtime tests: ok"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
