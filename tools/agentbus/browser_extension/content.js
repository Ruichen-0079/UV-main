"use strict";

// Keep selectors deliberately small and semantic. If ChatGPT changes its
// composer, fail closed instead of clicking a nearby arbitrary control.
function findComposer() {
  const candidates = [...new Set([
    document.querySelector("textarea#prompt-textarea"),
    document.querySelector('div#prompt-textarea[contenteditable="true"]'),
    document.querySelector('textarea[data-testid="prompt-textarea"]'),
    document.querySelector('[contenteditable="true"][data-testid="prompt-textarea"]')
  ].filter(Boolean))];
  return candidates.length === 1 ? candidates[0] : null;
}

function findSendButton() {
  const candidates = [
    document.querySelector('button[data-testid="send-button"]'),
    document.querySelector('button[aria-label="Send prompt"]')
  ].filter(Boolean);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) return null;
  const button = unique[0];
  return button.disabled || button.getAttribute("aria-disabled") === "true" ? null : button;
}

function detectTemporaryError() {
  const errorNodes = [...new Set([
    document.querySelector('[role="alert"]'),
    document.querySelector('[data-testid="error-message"]'),
    document.querySelector('[data-testid="conversation-turn-error"]')
  ].filter(Boolean))];
  let text = errorNodes.map((node) => node.innerText || node.textContent || "").join(" ").toLowerCase();
  // On a login/restriction/error page there is no conversation composer, so
  // bounded page text is safe to inspect for backoff without reading replies.
  if (!text && !findComposer()) {
    text = `${document.title || ""} ${(document.body && document.body.innerText || "").slice(0, 2000)}`.toLowerCase();
  }
  const longBackoff = [
    "usage limit", "try again later", "too many requests", "rate limit",
    "you have reached", "temporarily restricted"
  ];
  if (longBackoff.some((needle) => text.includes(needle))) {
    return { code: "BROWSER_CAPACITY", long_backoff: true };
  }
  const transient = ["something went wrong", "network error", "failed to load"];
  if (transient.some((needle) => text.includes(needle))) {
    return { code: "BROWSER_TEMPORARY", long_backoff: false };
  }
  return null;
}

function isComposerReady() {
  return Boolean(findComposer() && findSendButton());
}

function setPrompt(composer, prompt) {
  composer.focus(); // Focuses the editor inside an inactive document, not the tab/window.
  if (composer.tagName === "TEXTAREA") {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(composer, prompt);
  } else {
    composer.textContent = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = prompt;
    composer.appendChild(paragraph);
  }
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt
  }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
}

async function submitPrompt(prompt) {
  const temporary = detectTemporaryError();
  if (temporary) return { ok: false, ...temporary };
  const composer = findComposer();
  if (!composer) return { ok: false, code: "COMPOSER_NOT_FOUND" };
  setPrompt(composer, prompt);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const send = findSendButton();
  if (!send || !isComposerReady()) return { ok: false, code: "COMPOSER_NOT_READY" };
  send.click();
  return { ok: true, code: "SUBMITTED" };
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "AGENTBUS_SUBMIT" || typeof message.prompt !== "string") {
    return undefined;
  }
  return submitPrompt(message.prompt);
});
