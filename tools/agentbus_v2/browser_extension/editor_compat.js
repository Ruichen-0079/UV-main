"use strict";

/*
 * Firefox/ChatGPT contenteditable compatibility shim for AgentBus v2.
 *
 * Firefox's execCommand("insertText", ..., multiLineText) can hand the editor a
 * single accepted value whose embedded LF characters are represented as spaces.
 * That is enough to make ChatGPT enable Send, but it is not semantically the
 * packet we intended to submit.  Insert multiline packets one line at a time,
 * using editor-native line-break commands between lines, and expose a narrow
 * structural text view for the prompt composer so verification sees <br>/block
 * boundaries as LF without weakening packet equality.
 */
(() => {
  const originalExec = typeof document.execCommand === "function"
    ? document.execCommand.bind(document)
    : null;

  if (originalExec) {
    document.execCommand = function agentBusExecCommand(command, showUI, value) {
      if (command !== "insertText" || typeof value !== "string" || !/[\r\n]/.test(value)) {
        return originalExec(command, showUI, value);
      }

      const lines = value.replace(/\r\n?/g, "\n").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (index > 0) {
          let broke = originalExec("insertLineBreak", false, null);
          if (!broke) broke = originalExec("insertParagraph", false, null);
          if (!broke) return false;
        }
        if (lines[index] !== "" && !originalExec("insertText", false, lines[index])) {
          return false;
        }
      }
      return true;
    };
  }

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "UL"
  ]);

  function rawTextContent(node) {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    return descriptor?.get ? String(descriptor.get.call(node) || "") : "";
  }

  function isBlock(node) {
    return Boolean(node && node.nodeType === 1 && BLOCK_TAGS.has(String(node.tagName || "").toUpperCase()));
  }

  function structuralText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    if (String(node.tagName || "").toUpperCase() === "BR") return "\n";

    const children = Array.from(node.childNodes || []);
    let output = "";
    let previous = null;
    for (const child of children) {
      const childBlock = isBlock(child);
      const previousBlock = isBlock(previous);
      let piece = structuralText(child);

      // Pretty-printed/inter-block whitespace is layout, not message data.
      if (child.nodeType === 3 && piece.trim() === "" && (previousBlock || children.some(isBlock))) {
        previous = child;
        continue;
      }

      if (output && (previousBlock || childBlock) && !output.endsWith("\n") && !piece.startsWith("\n")) {
        output += "\n";
      }
      output += piece;
      previous = child;
    }
    return output;
  }

  const textContentDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (textContentDescriptor?.get && textContentDescriptor?.set && textContentDescriptor.configurable) {
    Object.defineProperty(Node.prototype, "textContent", {
      configurable: true,
      enumerable: textContentDescriptor.enumerable,
      get() {
        if (
          this?.nodeType === 1 &&
          this.id === "prompt-textarea" &&
          this.getAttribute?.("contenteditable") === "true"
        ) {
          const structured = structuralText(this);
          if (structured !== "") return structured;
        }
        return textContentDescriptor.get.call(this);
      },
      set(value) {
        return textContentDescriptor.set.call(this, value);
      }
    });
  }

  const API = { structuralText, rawTextContent };
  globalThis.AgentBusV2EditorCompat = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
