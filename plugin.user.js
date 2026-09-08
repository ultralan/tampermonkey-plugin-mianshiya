(function (TM) {
  "use strict";

  const VERSION = "0.7.1";

  const CONTENT_WAIT_TIMEOUT = 15000;
  const QUIET_PERIOD = 1500;
  const QUIET_MAX_WAIT = 8000;
  const CAPTURE_DEBOUNCE = 300;

  const QUESTION_PATH_RE = /^\/(?:bank\/(\d+)\/)?question\/(\d+)(?:[/?#]|$)/;
  const SECTION_TITLES = ["回答重点", "扩展知识", "面试官追问"];
  const DIFFICULTIES = ["简单", "中等", "困难"];

  let styleEl = null;
  let routeDebounceTimer = 0;
  let lastCaptureKey = "";

  function log(level, event, data) {
    TM.log(level, event, { pluginVersion: VERSION, data: data || {} });
  }

  function domRoot() {
    return document.body || document.documentElement;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  // ============================================================
  // URL 解析
  // ============================================================

  function parseQuestionPath(pathname) {
    const match = String(pathname || "").match(QUESTION_PATH_RE);
    if (!match) {
      return null;
    }
    // 站点 ID 是 19 位数字，超出 JS Number 精度（2^53），必须保持字符串。
    return {
      bankId: match[1] || null,
      questionId: match[2],
    };
  }

  // ============================================================
  // 解除页面选择/复制限制（无 UI，纯行为解锁）
  // ============================================================

  const guardedEvents = ["contextmenu", "selectstart", "copy", "cut", "dragstart", "keydown", "keyup"];

  function isProtectedShortcut(event) {
    const key = String(event.key || "").toLowerCase();
    return (
      key === "f12" ||
      ((event.metaKey || event.ctrlKey) && ["c", "s", "u"].includes(key)) ||
      ((event.metaKey || event.ctrlKey) && event.shiftKey && ["i", "j", "c"].includes(key))
    );
  }

  function guardEvent(event) {
    if ((event.type === "keydown" || event.type === "keyup") && !isProtectedShortcut(event)) {
      return;
    }

    // 阻断站点的限制 handler，不阻止默认行为：
    // contextmenu 恢复浏览器原生菜单，copy 保留系统剪贴板写入。
    event.stopImmediatePropagation();
  }

  function installEventGuards() {
    for (const type of guardedEvents) {
      window.addEventListener(type, guardEvent, true);
      document.addEventListener(type, guardEvent, true);
    }
  }

  function injectPageContextGuard() {
    const code = `
      (() => {
        if (window.__tmbMianshiyaGuardInstalled) return;
        window.__tmbMianshiyaGuardInstalled = true;

        const blockedEvents = ["contextmenu", "selectstart", "copy", "cut", "dragstart"];
        const keyEvents = ["keydown", "keyup"];
        const isProtectedShortcut = (event) => {
          const key = String(event.key || "").toLowerCase();
          return key === "f12" ||
            ((event.metaKey || event.ctrlKey) && ["c", "s", "u"].includes(key)) ||
            ((event.metaKey || event.ctrlKey) && event.shiftKey && ["i", "j", "c"].includes(key));
        };
        const guard = (event) => {
          if (keyEvents.includes(event.type) && !isProtectedShortcut(event)) return;
          event.stopImmediatePropagation();
        };

        [...blockedEvents, ...keyEvents].forEach((type) => {
          window.addEventListener(type, guard, true);
          document.addEventListener(type, guard, true);
        });

        const rawAdd = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (blockedEvents.includes(type)) {
            return rawAdd.call(this, type, function(event) {
              event.stopImmediatePropagation();
            }, options);
          }
          if (keyEvents.includes(type)) {
            return rawAdd.call(this, type, function(event) {
              if (isProtectedShortcut(event)) return;
              return listener && listener.apply(this, arguments);
            }, options);
          }
          return rawAdd.call(this, type, listener, options);
        };

        for (const target of [window, document, document.documentElement]) {
          if (!target) continue;
          for (const prop of ["oncontextmenu", "onselectstart", "oncopy", "oncut", "ondragstart"]) {
            try {
              Object.defineProperty(target, prop, {
                configurable: true,
                get() { return null; },
                set() {},
              });
            } catch {}
          }
        }

        const rawSetInterval = window.setInterval;
        const rawSetTimeout = window.setTimeout;
        const hasDebugger = (fn) => /debugger/.test(String(fn));
        window.setInterval = function(fn, ...rest) {
          if (hasDebugger(fn)) return 0;
          return rawSetInterval.call(this, fn, ...rest);
        };
        window.setTimeout = function(fn, ...rest) {
          if (hasDebugger(fn)) return 0;
          return rawSetTimeout.call(this, fn, ...rest);
        };
      })();
    `;

    const inject = () => {
      const script = document.createElement("script");
      script.textContent = code;
      (document.head || document.documentElement || document.body).appendChild(script);
      script.remove();
    };

    if (domRoot()) {
      inject();
    } else {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    }
  }

  function injectStyle() {
    const inject = () => {
      styleEl?.remove();
      styleEl = document.createElement("style");
      styleEl.id = "tmb-mianshiya-unlock-style";
      styleEl.textContent = `
        html, body, body * {
          -webkit-user-select: text !important;
          -moz-user-select: text !important;
          user-select: text !important;
        }

        body {
          -webkit-touch-callout: default !important;
        }
      `;
      (document.head || document.documentElement || document.body).appendChild(styleEl);

      for (const node of [document.documentElement, document.body].filter(Boolean)) {
        node.style.setProperty("-webkit-user-select", "text", "important");
        node.style.setProperty("user-select", "text", "important");
        node.oncontextmenu = null;
        node.oncopy = null;
        node.onselectstart = null;
      }
    };

    if (domRoot()) {
      inject();
    } else {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
    }
  }

  // ============================================================
  // DOM -> Markdown 转换（content_md 全页原始文本用）
  // ============================================================

  function normalizeMarkdown(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function escapeMarkdown(text) {
    return String(text || "").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
  }

  function escapeTableCell(text) {
    return normalizeMarkdown(text)
      .replace(/\n+/g, "<br>")
      .replace(/\|/g, "\\|");
  }

  function absoluteUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      return raw;
    }

    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  }

  function firstSrcFromSrcset(value) {
    return String(value || "")
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .find(Boolean) || "";
  }

  function cloneContentNode(node) {
    const clone = node.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "noscript",
      "svg",
      "button",
      "textarea",
      "input",
      "select",
      ".ant-modal-root",
      ".login-modal",
      ".ant-modal-mask",
      ".question-title-actions",
      ".ant-tabs-nav",
      "footer",
    ];

    for (const selector of removeSelectors) {
      for (const item of clone.querySelectorAll(selector)) {
        item.remove();
      }
    }

    return clone;
  }

  function childNodesToMarkdown(node, context = {}) {
    return Array.from(node.childNodes || [])
      .map((child) => nodeToMarkdown(child, context))
      .join("");
  }

  function blockMarkdown(text) {
    const normalized = normalizeMarkdown(text);
    return normalized ? `${normalized}\n\n` : "";
  }

  function inlineMarkdown(node, context = {}) {
    return normalizeMarkdown(childNodesToMarkdown(node, { ...context, inline: true })).replace(/\n+/g, " ");
  }

  function markdownImage(node) {
    const src =
      node.currentSrc ||
      node.getAttribute("src") ||
      node.getAttribute("data-src") ||
      node.getAttribute("data-original") ||
      firstSrcFromSrcset(node.getAttribute("srcset") || node.getAttribute("data-srcset")) ||
      "";
    const url = absoluteUrl(src);
    if (!url) {
      return "";
    }

    const alt = node.getAttribute("alt") || node.getAttribute("title") || "图片";
    return `![${String(alt).replace(/[[\]]/g, "")}](${url})`;
  }

  function markdownList(node, context = {}) {
    const ordered = node.tagName === "OL";
    const items = Array.from(node.children || []).filter((child) => child.tagName === "LI");
    const depth = context.listDepth || 0;
    const indent = "  ".repeat(depth);

    return items
      .map((item, index) => {
        const marker = ordered ? `${index + 1}. ` : "- ";
        const content = normalizeMarkdown(childNodesToMarkdown(item, { ...context, listDepth: depth + 1 }));
        const lines = content.split("\n").filter(Boolean);
        if (!lines.length) {
          return `${indent}${marker}`;
        }

        const [first, ...rest] = lines;
        const nested = rest.map((line) => `${indent}  ${line}`).join("\n");
        return `${indent}${marker}${first}${nested ? `\n${nested}` : ""}`;
      })
      .join("\n") + "\n\n";
  }

  function markdownTable(node) {
    const rows = Array.from(node.querySelectorAll("tr"))
      .map((row) => Array.from(row.children || []).map((cell) => escapeTableCell(childNodesToMarkdown(cell, { inline: true }))))
      .filter((cells) => cells.length);

    if (!rows.length) {
      return "";
    }

    const width = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => {
      const copy = row.slice();
      while (copy.length < width) {
        copy.push("");
      }
      return copy;
    });
    const header = normalizedRows[0];
    const divider = header.map(() => "---");
    const body = normalizedRows.slice(1);
    const tableRows = [header, divider, ...body].map((row) => `| ${row.join(" | ")} |`);

    return `${tableRows.join("\n")}\n\n`;
  }

  function nodeToMarkdown(node, context = {}) {
    if (!node) {
      return "";
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return context.inline ? escapeMarkdown(node.textContent || "") : node.textContent || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tag = node.tagName;

    if (node.hidden || node.getAttribute("aria-hidden") === "true") {
      return "";
    }

    if (tag === "IMG") {
      return markdownImage(node);
    }

    if (tag === "BR") {
      return "\n";
    }

    if (tag === "A") {
      const text = inlineMarkdown(node, context) || node.getAttribute("href") || "";
      const href = absoluteUrl(node.getAttribute("href") || "");
      return href ? `[${text}](${href})` : text;
    }

    if (tag === "STRONG" || tag === "B") {
      const text = inlineMarkdown(node, context);
      return text ? `**${text}**` : "";
    }

    if (tag === "EM" || tag === "I") {
      const text = inlineMarkdown(node, context);
      return text ? `_${text}_` : "";
    }

    if (tag === "CODE" && node.parentElement?.tagName !== "PRE") {
      return `\`${String(node.textContent || "").replace(/`/g, "\\`")}\``;
    }

    if (tag === "PRE") {
      const code = node.textContent || "";
      const lang = node.querySelector("code")?.className?.match(/language-([a-z0-9_-]+)/i)?.[1] || "";
      return `\`\`\`${lang}\n${code.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    }

    if (/^H[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = inlineMarkdown(node, context);
      return text ? `${"#".repeat(level)} ${text}\n\n` : "";
    }

    if (tag === "P") {
      return blockMarkdown(childNodesToMarkdown(node, context));
    }

    if (tag === "BLOCKQUOTE") {
      const text = normalizeMarkdown(childNodesToMarkdown(node, context));
      return text ? `${text.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }

    if (tag === "UL" || tag === "OL") {
      return markdownList(node, context);
    }

    if (tag === "TABLE") {
      return markdownTable(node);
    }

    if (tag === "HR") {
      return "---\n\n";
    }

    if (["DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "ASIDE", "NAV"].includes(tag)) {
      return blockMarkdown(childNodesToMarkdown(node, context));
    }

    if (["SPAN", "SMALL", "LABEL", "MARK"].includes(tag)) {
      return childNodesToMarkdown(node, context);
    }

    return childNodesToMarkdown(node, context);
  }

  // ============================================================
  // 页面定位与元数据解析
  // ============================================================

  function getMainContentNode() {
    return (
      document.querySelector("#question-content-in-bank-client") ||
      document.querySelector("#question-main") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function visibleText(node) {
    if (!node) {
      return "";
    }
    return normalizeMarkdown(cloneContentNode(node).innerText);
  }

  function parseTitle(main) {
    const h1 = main?.querySelector("h1") || document.querySelector("h1");
    const raw = normalizeMarkdown(h1?.textContent) ||
      document.title.replace(/\s+-\s+面试鸭.*$/, "");
    const match = raw.match(/^(\d+)\.\s*(.+)$/);
    if (match) {
      return { questionNo: Number(match[1]), title: match[2].trim() };
    }
    return { questionNo: null, title: raw };
  }

  // 在正文容器前部的小徽标元素里找难度/VIP 标记。
  function parseBadges(main) {
    const badges = { difficulty: null, isVip: false };
    if (!main) {
      return badges;
    }

    const candidates = main.querySelectorAll("span, div, p, i");
    let scanned = 0;
    for (const node of candidates) {
      if (scanned > 200) {
        break;
      }
      if (node.children.length > 0) {
        continue;
      }
      const text = normalizeMarkdown(node.textContent);
      if (!text || text.length > 6) {
        continue;
      }
      scanned += 1;
      if (!badges.difficulty && DIFFICULTIES.includes(text)) {
        badges.difficulty = text;
      } else if (!badges.isVip && text.toUpperCase() === "VIP") {
        badges.isVip = true;
      }
      if (badges.difficulty && badges.isVip) {
        break;
      }
    }
    return badges;
  }

  function parseTags(main) {
    if (!main) {
      return [];
    }
    const tags = new Set();
    for (const anchor of main.querySelectorAll('a[href*="/tag/"]')) {
      const text = normalizeMarkdown(anchor.textContent);
      if (text) {
        tags.add(text);
      }
    }
    return Array.from(tags);
  }

  function parseBankIds() {
    const ids = new Set();
    for (const anchor of document.querySelectorAll('a[href*="/bank/"]')) {
      const match = String(anchor.getAttribute("href") || "").match(/\/bank\/(\d+)/);
      if (match) {
        ids.add(Number(match[1]));
      }
    }
    return Array.from(ids);
  }

  // 按 h2 标题切分正文段落，返回 {标题: 段落文本(md)}。
  function parseSections(main) {
    const sections = {};
    if (!main) {
      return sections;
    }

    const headings = Array.from(main.querySelectorAll("h2")).filter((heading) =>
      SECTION_TITLES.includes(normalizeMarkdown(heading.textContent)),
    );
    if (headings.length === 0) {
      return sections;
    }

    const headingSet = new Set(headings);
    for (let index = 0; index < headings.length; index += 1) {
      const heading = headings[index];
      const parts = [];
      let node = heading.nextElementSibling;
      while (node && !headingSet.has(node)) {
        parts.push(nodeToMarkdown(node));
        node = node.nextElementSibling;
      }
      sections[normalizeMarkdown(heading.textContent)] = normalizeMarkdown(parts.join(""));
    }
    return sections;
  }

  // 追问段："#### 提问：X" + 后续文本中 "回答：Y" 配对。
  function parseFollowUps(sectionText) {
    if (!sectionText) {
      return null;
    }

    const followUps = [];
    const blocks = sectionText.split(/^#### (?=提问)/m);
    for (const block of blocks) {
      const questionMatch = block.match(/^提问[：:]\s*(.+)/);
      if (!questionMatch) {
        continue;
      }
      const rest = block
        .slice(questionMatch[0].length)
        .replace(/^提问[：:].*/m, "")
        .trim();
      const answerMatch = rest.match(/回答[：:]\s*([\s\S]*)$/);
      followUps.push({
        q: questionMatch[1].trim(),
        a: answerMatch ? answerMatch[1].trim() : rest.trim(),
      });
    }
    return followUps.length > 0 ? followUps : null;
  }

  // ============================================================
  // 采集与写入
  // ============================================================

  async function sha256Hex(text) {
    if (!crypto?.subtle || typeof TextEncoder !== "function") {
      return String(text.length);
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function buildContentMd(main, title) {
    const bodyNode = main ? cloneContentNode(main) : null;
    let firstHeading = bodyNode?.querySelector?.("h1");
    if (firstHeading && normalizeMarkdown(firstHeading.textContent) === normalizeMarkdown(title)) {
      firstHeading.remove();
    }
    const body = normalizeMarkdown(bodyNode ? nodeToMarkdown(bodyNode) : visibleText(main));
    const url = location.href.replace(/#.*$/, "");

    return [`# ${title}`, "", `> 来源：${url}`, "", body]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";
  }

  async function captureQuestion(info) {
    const main = getMainContentNode();
    const { questionNo, title } = parseTitle(main);
    const badges = parseBadges(main);
    const tags = parseTags(main);
    const sections = parseSections(main);

    let bankIds = parseBankIds();
    if (info.bankId && !bankIds.includes(info.bankId)) {
      bankIds.push(info.bankId);
    }
    bankIds.sort();

    const followUps = parseFollowUps(sections["面试官追问"]);
    const contentMd = buildContentMd(main, title);
    const contentHash = await sha256Hex(
      [
        title,
        badges.difficulty || "",
        tags.join(","),
        sections["回答重点"] || "",
        sections["扩展知识"] || "",
        JSON.stringify(followUps || null),
      ].join("\n\u0000\n"),
    );

    const payload = {
      question_id: info.questionId,
      question_no: questionNo,
      title,
      difficulty: badges.difficulty,
      is_vip: badges.isVip,
      tags,
      bank_ids: bankIds,
      answer_key: sections["回答重点"] || null,
      extended_knowledge: sections["扩展知识"] || null,
      follow_ups: followUps,
      content_md: contentMd,
      content_hash: contentHash,
      source_url: location.href.replace(/#.*$/, ""),
    };

    await TM.rest("questions", {
      method: "POST",
      payload,
      prefer: "resolution=merge-duplicates,return=minimal",
    });

    log("info", "mianshiya_question_upserted", {
      questionId: info.questionId,
      title,
      answerKeyLength: payload.answer_key?.length || 0,
      extendedLength: payload.extended_knowledge?.length || 0,
      followUps: followUps?.length || 0,
      bankIds,
    });
  }

  // ============================================================
  // 就绪等待
  // ============================================================

  function mainContentReady() {
    const main = getMainContentNode();
    if (!main) {
      return false;
    }
    // "回答重点" 是官方解答的固定首节，出现即认为正文渲染完成。
    return Array.from(main.querySelectorAll("h2")).some((heading) =>
      normalizeMarkdown(heading.textContent) === "回答重点",
    );
  }

  async function waitForContent() {
    const deadline = Date.now() + CONTENT_WAIT_TIMEOUT;
    while (Date.now() < deadline) {
      if (mainContentReady()) {
        return true;
      }
      await sleep(300);
    }
    return mainContentReady();
  }

  // 等待 DOM 静默：懒加载图片、代码高亮等渲染完再抓。
  function waitForQuiet() {
    return new Promise((resolve) => {
      let quietTimer = 0;
      const hardStop = window.setTimeout(() => {
        window.clearTimeout(quietTimer);
        observer.disconnect();
        resolve();
      }, QUIET_MAX_WAIT);

      const settle = () => {
        window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => {
          window.clearTimeout(hardStop);
          observer.disconnect();
          resolve();
        }, QUIET_PERIOD);
      };

      const observer = new MutationObserver(settle);
      const root = domRoot();
      if (root) {
        observer.observe(root, { childList: true, subtree: true });
      }
      settle();
    });
  }

  async function waitAndCapture(info) {
    try {
      const ready = await waitForContent();
      if (!ready) {
        log("warn", "mianshiya_content_not_ready", { questionId: info.questionId });
      }
      await waitForQuiet();

      // 等待期间页面可能又跳走了。
      const current = parseQuestionPath(location.pathname);
      if (!current || current.questionId !== info.questionId) {
        log("info", "mianshiya_capture_abandoned", { questionId: info.questionId });
        return;
      }

      await captureQuestion(current);
    } catch (error) {
      log("error", "mianshiya_capture_failed", {
        questionId: info.questionId,
        error: String(error?.stack || error),
      });
    }
  }

  // ============================================================
  // SPA 路由监听
  // ============================================================

  function patchHistory() {
    for (const method of ["pushState", "replaceState"]) {
      const raw = history[method];
      if (typeof raw !== "function" || raw.__tmbPatched) {
        continue;
      }
      const patched = function (...args) {
        const result = raw.apply(this, args);
        window.dispatchEvent(new CustomEvent("__tmb_route_change__"));
        return result;
      };
      patched.__tmbPatched = true;
      history[method] = patched;
    }
  }

  function onRouteChange() {
    window.clearTimeout(routeDebounceTimer);
    routeDebounceTimer = window.setTimeout(() => {
      const info = parseQuestionPath(location.pathname);
      if (!info) {
        lastCaptureKey = "";
        return;
      }

      const key = `${info.questionId}@${info.bankId || ""}`;
      if (key === lastCaptureKey) {
        return;
      }
      lastCaptureKey = key;
      log("info", "mianshiya_question_page_detected", { questionId: info.questionId, bankId: info.bankId });
      waitAndCapture(info);
    }, CAPTURE_DEBOUNCE);
  }

  function installRouteWatcher() {
    patchHistory();
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("__tmb_route_change__", onRouteChange);
    onRouteChange();
  }

  // ============================================================
  // 启动
  // ============================================================

  function boot() {
    log("info", "mianshiya_plugin_boot", {
      version: VERSION,
      url: location.href,
      readyState: document.readyState,
    });

    installEventGuards();
    injectPageContextGuard();
    injectStyle();
    installRouteWatcher();
  }

  try {
    boot();
  } catch (error) {
    log("error", "mianshiya_plugin_boot_failed", { error: String(error?.stack || error) });
  }
})(TM);
