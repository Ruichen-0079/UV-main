"use strict";

/*
 * Firefox/ChatGPT contenteditable compatibility shim for AgentBus v2.
 *
 * Firefox can flatten embedded LF characters when a whole multiline packet is
 * passed to execCommand("insertText").  Preserve packet line structure by
 * inserting one line at a time and creating editor-native paragraph boundaries
 * between lines.  This file runs in the same WebExtension content-script world
 * as content.js; no page semantic state is persisted here.
 */
(() => {
  const originalExec = typeof document.execCommand === "function"
    ? document.execCommand.bind(document)
    : null;

  function multilineExec(command, showUI, value) {
    if (
      !originalExec ||
      command !== "insertText" ||
      typeof value !== "string" ||
      !/[\r\n]/.test(value)
    ) {
      return originalExec ? originalExec(command, showUI, value) : false;
    }

    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (index > 0) {
        // ChatGPT's structured editor treats paragraph boundaries as real text
        // boundaries. Firefox insertLineBreak can be normalized to a space in
        // this editor, so prefer insertParagraph and keep line-break as fallback.
        let broke = originalExec("insertParagraph", false, null);
        if (!broke) broke = originalExec("insertLineBreak", false, null);
        if (!broke) return false;
      }
      if (lines[index] !== "" && !originalExec("insertText", false, lines[index])) {
        return false;
      }
    }
    return true;
  }

  // Xray-wrapped DOM objects in Firefox do not always honor a plain expando
  // assignment for inherited native methods. Install an own property explicitly,
  // then fall back to the content-world Document prototype when necessary.
  let execShimInstalled = false;
  if (originalExec) {
    try {
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        writable: true,
        value: multilineExec
      });
      execShimInstalled = document.execCommand === multilineExec;
    } catch (_) {
      execShimInstalled = false;
    }

    if (!execShimInstalled && typeof Document !== "undefined") {
      try {
        Object.defineProperty(Document.prototype, "execCommand", {
          configurable: true,
          writable: true,
          value: multilineExec
        });
        execShimInstalled = document.execCommand === multilineExec;
      } catch (_) {
        execShimInstalled = false;
      }
    }
  }

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "UL"
  ]);

  function rawTextContent(node) {
    if (typeof Node === "undefined") return "";
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
    const containsBlocks = children.some(isBlock);
    let output = "";
    let seenDataChild = false;
    let previousWasBlock = false;

    for (const child of children) {
      const childBlock = isBlock(child);
      const piece = structuralText(child);

      // Pretty-print whitespace between block children is layout, not prompt data.
      if (child.nodeType === 3 && piece.trim() === "" && (previousWasBlock || containsBlocks)) {
        continue;
      }

      if (childBlock && seenDataChild) output += "\n";
      output += piece;
      seenDataChild = true;
      previousWasBlock = childBlock;
    }
    return output;
  }

  const textContentDescriptor = typeof Node !== "undefined"
    ? Object.getOwnPropertyDescriptor(Node.prototype, "textContent")
    : null;
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
          return structuralText(this);
        }
        return textContentDescriptor.get.call(this);
      },
      set(value) {
        return textContentDescriptor.set.call(this, value);
      }
    });
  }

  const API = {
    structuralText,
    rawTextContent,
    multilineExec,
    execShimInstalled
  };
  globalThis.AgentBusV2EditorCompat = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
