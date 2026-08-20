"use strict";

/*
 * Firefox/ChatGPT contenteditable compatibility shim for AgentBus v2.
 *
 * Firefox can flatten embedded LF characters when a whole multiline packet is
 * passed to execCommand("insertText"). Preserve packet line structure by
 * inserting one line at a time and creating editor-native paragraph boundaries
 * between lines. Verification serializes ChatGPT's structured composer DOM back
 * to logical text without weakening packet equality.
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
        // ChatGPT's editor preserves paragraph boundaries as logical LF. Firefox
        // insertLineBreak can be flattened to a space here, so paragraph is the
        // primary path and line-break is only a compatibility fallback.
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

  function inlineText(node, rootBlock = false) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue || "");
    if (node.nodeType !== 1) return "";

    const tag = String(node.tagName || "").toUpperCase();
    if (tag === "BR") {
      // A sole BR is the browser's placeholder for an empty paragraph. The
      // paragraph separator itself supplies that logical LF, so the placeholder
      // contributes no additional character. BR among real inline content is a
      // genuine soft line break and remains LF.
      return rootBlock ? "" : "\n";
    }

    const children = Array.from(node.childNodes || []);
    const meaningful = children.filter((child) => {
      if (child.nodeType !== 3) return true;
      return String(child.nodeValue || "").trim() !== "";
    });
    const solePlaceholderBr = meaningful.length === 1 &&
      meaningful[0].nodeType === 1 &&
      String(meaningful[0].tagName || "").toUpperCase() === "BR";

    let output = "";
    for (const child of children) {
      if (solePlaceholderBr && child === meaningful[0]) continue;
      output += inlineText(child, false);
    }
    return output;
  }

  function structuralText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    if (String(node.tagName || "").toUpperCase() === "BR") return "\n";

    const children = Array.from(node.childNodes || []);
    const blockChildren = children.filter(isBlock);
    if (blockChildren.length > 0) {
      // In ChatGPT's contenteditable each top-level paragraph is one logical
      // line. Join block contents with exactly one LF. An empty block represented
      // by <p><br></p> contributes an empty field, so A / empty / B becomes
      // exactly "A\n\nB", not "A\n\n\nB".
      const parts = [];
      for (const child of children) {
        if (isBlock(child)) {
          parts.push(inlineText(child, true));
          continue;
        }
        if (child.nodeType === 3 && String(child.nodeValue || "").trim() === "") continue;
        const piece = inlineText(child, false);
        if (piece !== "") {
          if (parts.length === 0) parts.push(piece);
          else parts[parts.length - 1] += piece;
        }
      }
      return parts.join("\n");
    }

    return inlineText(node, false);
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
