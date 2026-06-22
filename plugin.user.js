(function (PluginVerse) {
  "use strict";

  const VERSION = "0.6.1";
  const eventCounts = Object.create(null);
  const blockedEvents = [
    "contextmenu",
    "selectstart",
    "copy",
    "cut",
    "dragstart",
    "keydown",
    "keyup",
  ];

  let styleEl = null;
  let customMenuEl = null;
  let downloadButtonEl = null;

  function log(level, event, data) {
    PluginVerse.log(level, event, {
      pluginVersion: VERSION,
      url: location.href,
      readyState: document.readyState,
      data,
    });
  }

  function domRoot() {
    return document.body || document.documentElement;
  }

  function runWhenDomReady(fn, label) {
    const run = () => {
      try {
        fn();
      } catch (error) {
        log("error", "mianshiya_dom_task_failed", { label, error: String(error?.stack || error) });
      }
    };

    if (domRoot()) {
      run();
      return;
    }

    document.addEventListener("DOMContentLoaded", run, { once: true });
    window.setTimeout(run, 500);
    window.setTimeout(run, 1500);
  }

  function selectedText() {
    return String(window.getSelection?.() || "").trim();
  }

  function safeClipboardWrite(text) {
    if (!text) {
      throw new Error("没有可复制内容");
    }
    PluginVerse.setClipboard(text);
  }

  function safeFileName(value) {
    const cleaned = String(value || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90)
      .trim();
    return cleaned || "mianshiya-page";
  }

  function markdownFileName() {
    return `${safeFileName(getPageTitle())}.md`;
  }

  function downloadTextFile(filename, text) {
    if (!window.URL || typeof URL.createObjectURL !== "function") {
      safeClipboardWrite(text);
      throw new Error("当前浏览器不支持 Blob 下载，已复制 Markdown 到剪贴板");
    }

    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.style.display = "none";

    try {
      domRoot().appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  async function downloadMarkdown() {
    const markdown = buildMarkdown();
    const filename = markdownFileName();
    downloadTextFile(filename, markdown);
    log("info", "mianshiya_markdown_downloaded", { filename, length: markdown.length });
  }

  function hideCustomMenu() {
    if (customMenuEl) {
      customMenuEl.remove();
      customMenuEl = null;
    }
  }

  function menuItem(text, onClick) {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = text;
    item.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick();
      } catch (error) {
        log("error", "mianshiya_menu_action_failed", {
          action: text,
          error: String(error?.stack || error),
        });
      } finally {
        hideCustomMenu();
      }
    });
    return item;
  }

  function showCustomMenu(x, y) {
    runWhenDomReady(() => {
      hideCustomMenu();

      customMenuEl = document.createElement("div");
      customMenuEl.id = "mianshiya-custom-menu";
      customMenuEl.append(
        menuItem("复制当前选区", copySelection),
        menuItem("复制题目 Markdown", copyMarkdown),
        menuItem("下载当前页 Markdown", downloadMarkdown),
        menuItem("上报页面快照", reportSnapshot),
        menuItem("复制页面快照", copySnapshot),
        menuItem("重新解除限制", async () => {
          installEventGuards();
          injectPageContextGuard();
          injectStyle();
          removeModalBlockers();
          log("info", "mianshiya_reinforce_by_context_menu", {});
        }),
      );

      domRoot().appendChild(customMenuEl);

      const rect = customMenuEl.getBoundingClientRect();
      const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - rect.width - 8));
      const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - rect.height - 8));
      customMenuEl.style.left = `${left}px`;
      customMenuEl.style.top = `${top}px`;

      log("info", "mianshiya_context_menu_shown", { x, y, selectedLength: selectedText().length });
    }, "显示自定义右键菜单");
  }

  function installDownloadButton() {
    runWhenDomReady(() => {
      const main = getMainContentNode();
      if (!main) {
        return;
      }

      const existing = document.getElementById("mianshiya-md-download-toolbar");
      if (existing && existing.parentElement === main) {
        downloadButtonEl = document.getElementById("mianshiya-md-download-button");
        return;
      }
      existing?.remove();

      const toolbar = document.createElement("div");
      toolbar.id = "mianshiya-md-download-toolbar";

      const button = document.createElement("button");
      button.id = "mianshiya-md-download-button";
      button.type = "button";
      button.textContent = "下载 MD";
      button.title = "下载当前页面 Markdown";
      button.setAttribute("aria-label", "下载当前页面 Markdown");
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await downloadMarkdown();
        } catch (error) {
          log("error", "mianshiya_markdown_download_failed", {
            error: String(error?.stack || error),
          });
        }
      });

      toolbar.appendChild(button);
      main.insertBefore(toolbar, main.firstChild);
      downloadButtonEl = button;
      log("info", "mianshiya_download_button_installed", {
        target: main.id ? `#${main.id}` : String(main.tagName || "main").toLowerCase(),
      });
    }, "安装 Markdown 下载按钮");
  }

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

    eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;

    if (event.type === "contextmenu") {
      event.preventDefault();
      showCustomMenu(event.clientX || 20, event.clientY || 20);
      event.stopImmediatePropagation();
      return;
    }

    if (event.type === "copy") {
      const text = selectedText();
      if (text && event.clipboardData) {
        event.clipboardData.setData("text/plain", text);
        event.preventDefault();
        log("info", "mianshiya_copy_intercepted", { selectedLength: text.length });
      } else {
        log("warn", "mianshiya_copy_without_selection", {});
      }
    }

    event.stopImmediatePropagation();
  }

  function installEventGuards() {
    for (const type of blockedEvents) {
      window.addEventListener(type, guardEvent, true);
      document.addEventListener(type, guardEvent, true);
    }
    log("info", "mianshiya_event_guards_installed", {});
  }

  function injectPageContextGuard() {
    runWhenDomReady(() => {
      const code = `
        (() => {
          if (window.__pluginverseMianshiyaInstalled) return;
          window.__pluginverseMianshiyaInstalled = true;

          const log = (message) => {
            try {
              window.dispatchEvent(new CustomEvent("__pluginverse_plugin_log__", {
                detail: { pluginId: "mianshiya", message }
              }));
            } catch {}
          };
          const blockedEvents = ["contextmenu", "selectstart", "copy", "cut", "dragstart"];
          const keyEvents = ["keydown", "keyup"];
          const selectedText = () => String(window.getSelection && window.getSelection() || "").trim();
          const isProtectedShortcut = (event) => {
            const key = String(event.key || "").toLowerCase();
            return key === "f12" ||
              ((event.metaKey || event.ctrlKey) && ["c", "s", "u"].includes(key)) ||
              ((event.metaKey || event.ctrlKey) && event.shiftKey && ["i", "j", "c"].includes(key));
          };
          const guard = (event) => {
            if (keyEvents.includes(event.type) && !isProtectedShortcut(event)) return;
            if (event.type === "contextmenu") {
              event.preventDefault();
              try {
                window.dispatchEvent(new CustomEvent("__pluginverse_mianshiya_contextmenu__", {
                  detail: { x: event.clientX || 20, y: event.clientY || 20 }
                }));
              } catch {}
              event.stopImmediatePropagation();
              return;
            }
            if (event.type === "copy") {
              const text = selectedText();
              if (text && event.clipboardData) {
                event.clipboardData.setData("text/plain", text);
                event.preventDefault();
                log("页面上下文接管 copy，写入选区 " + text.length + " 字");
              }
            }
            event.stopImmediatePropagation();
          };

          [...blockedEvents, ...keyEvents].forEach((type) => {
            window.addEventListener(type, guard, true);
            document.addEventListener(type, guard, true);
          });

          const rawAdd = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            if (blockedEvents.includes(type)) {
              log("拦截页面注册限制事件：" + type);
              return rawAdd.call(this, type, function(event) {
                if (event.type === "copy") {
                  const text = selectedText();
                  if (text && event.clipboardData) {
                    event.clipboardData.setData("text/plain", text);
                    event.preventDefault();
                  }
                }
              }, options);
            }
            if (keyEvents.includes(type)) {
              return rawAdd.call(this, type, function(event) {
                if (isProtectedShortcut(event)) {
                  log("跳过页面快捷键拦截：" + type + " " + event.key);
                  return;
                }
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
                  set() { log("阻止赋值 " + prop); },
                });
              } catch {}
            }
          }

          const rawSetInterval = window.setInterval;
          const rawSetTimeout = window.setTimeout;
          const hasDebugger = (fn) => /debugger/.test(String(fn));
          window.setInterval = function(fn, ...rest) {
            if (hasDebugger(fn)) {
              log("阻止 debugger interval");
              return 0;
            }
            return rawSetInterval.call(this, fn, ...rest);
          };
          window.setTimeout = function(fn, ...rest) {
            if (hasDebugger(fn)) {
              log("阻止 debugger timeout");
              return 0;
            }
            return rawSetTimeout.call(this, fn, ...rest);
          };

          log("页面上下文保护已安装");
        })();
      `;

      const script = document.createElement("script");
      script.textContent = code;
      (document.head || document.documentElement || document.body).appendChild(script);
      script.remove();
      log("info", "mianshiya_page_context_guard_injected", {});
    }, "注入页面上下文保护");
  }

  function injectStyle() {
    runWhenDomReady(() => {
      styleEl?.remove();
      styleEl = document.createElement("style");
      styleEl.id = "mianshiya-unlock-style";
      styleEl.textContent = `
        html, body, body * {
          -webkit-user-select: text !important;
          -moz-user-select: text !important;
          -ms-user-select: text !important;
          user-select: text !important;
        }

        body {
          -webkit-touch-callout: default !important;
        }

        #question-content-in-bank-client,
        #question-content-in-bank-client *,
        #question-main,
        #question-main *,
        .markdown-body,
        .markdown-body *,
        #mianshiya-md-download-toolbar,
        #mianshiya-md-download-toolbar * {
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }

        #mianshiya-custom-menu,
        #mianshiya-custom-menu * {
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }

        #mianshiya-custom-menu {
          position: fixed !important;
          z-index: 2147483647 !important;
          display: flex !important;
          flex-direction: column !important;
          min-width: 190px !important;
          padding: 6px !important;
          border: 1px solid rgba(0, 0, 0, 0.16) !important;
          border-radius: 8px !important;
          background: rgba(255, 255, 255, 0.98) !important;
          box-shadow: 0 12px 28px rgba(15, 23, 42, 0.22) !important;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        }

        #mianshiya-custom-menu button {
          display: block !important;
          width: 100% !important;
          padding: 8px 10px !important;
          border: 0 !important;
          border-radius: 6px !important;
          color: #111827 !important;
          background: transparent !important;
          text-align: left !important;
          cursor: pointer !important;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        }

        #mianshiya-custom-menu button:hover {
          background: #f3f4f6 !important;
        }

        #mianshiya-md-download-toolbar {
          display: flex !important;
          justify-content: flex-end !important;
          align-items: center !important;
          min-height: 34px !important;
          margin: 10px 0 12px !important;
          padding: 0 !important;
          position: relative !important;
          z-index: 20 !important;
          pointer-events: auto !important;
        }

        #mianshiya-md-download-button {
          appearance: none !important;
          min-width: 76px !important;
          min-height: 32px !important;
          padding: 6px 10px !important;
          border: 1px solid rgba(17, 24, 39, 0.22) !important;
          border-radius: 6px !important;
          background: #ffffff !important;
          color: #111827 !important;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08) !important;
          cursor: pointer !important;
          font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
          letter-spacing: 0 !important;
          white-space: nowrap !important;
        }

        #mianshiya-md-download-button:hover {
          border-color: rgba(20, 84, 255, 0.42) !important;
          background: #f8fafc !important;
          color: #0f172a !important;
        }

        #mianshiya-md-download-button:active {
          transform: translateY(1px) !important;
        }

        #mianshiya-md-download-button:focus-visible {
          outline: 2px solid rgba(20, 84, 255, 0.36) !important;
          outline-offset: 2px !important;
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
    }, "注入样式");
  }

  function removeModalBlockers() {
    for (const selector of [".ant-modal-mask", ".ant-modal-wrap.login-modal"]) {
      for (const node of document.querySelectorAll(selector)) {
        node.style.pointerEvents = "none";
      }
    }
  }

  function visibleText(node) {
    if (!node) {
      return "";
    }

    const clone = node.cloneNode(true);
    const removeSelectors = [
      "script",
      "style",
      "svg",
      "button",
      "textarea",
      "#mianshiya-md-download-toolbar",
      "#mianshiya-md-download-button",
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

    return clone.innerText
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getMainContentNode() {
    return (
      document.querySelector("#question-content-in-bank-client") ||
      document.querySelector("#question-main") ||
      document.querySelector("main") ||
      document.body
    );
  }

  function getPageTitle() {
    const main = getMainContentNode();
    const h1 = main?.querySelector("h1") || document.querySelector("h1");
    return visibleText(h1) || document.title.replace(/\s+-\s+面试鸭.*$/, "");
  }

  function buildMarkdown() {
    const main = getMainContentNode();
    const title = getPageTitle();
    const body = visibleText(main);
    const url = location.href.replace(/#.*$/, "");

    return [`# ${title}`, "", `> 来源：${url}`, "", body]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n";
  }

  function buildSnapshot() {
    const main = getMainContentNode();
    const markdown = buildMarkdown();
    return {
      pluginId: "mianshiya",
      pluginVersion: VERSION,
      capturedAt: new Date().toISOString(),
      title: getPageTitle(),
      source: location.href.replace(/#.*$/, ""),
      description: document.querySelector('meta[name="description"]')?.content || "",
      readyState: document.readyState,
      selectedLength: selectedText().length,
      bodyLength: main ? visibleText(main).length : 0,
      markdownLength: markdown.length,
      eventCounts: { ...eventCounts },
      markdown,
    };
  }

  async function copySelection() {
    const text = selectedText();
    safeClipboardWrite(text);
    log("info", "mianshiya_selection_copied", { length: text.length });
  }

  async function copyMarkdown() {
    const markdown = buildMarkdown();
    safeClipboardWrite(markdown);
    log("info", "mianshiya_markdown_copied", { length: markdown.length });
  }

  async function copySnapshot() {
    const snapshot = buildSnapshot();
    safeClipboardWrite(JSON.stringify(snapshot, null, 2));
    log("info", "mianshiya_snapshot_copied", {
      markdownLength: snapshot.markdownLength,
      bodyLength: snapshot.bodyLength,
    });
  }

  async function reportSnapshot() {
    const snapshot = buildSnapshot();
    log("info", "mianshiya_snapshot_reported", snapshot);
  }

  function boot() {
    log("info", "mianshiya_plugin_boot", {
      version: VERSION,
      url: location.href,
      readyState: document.readyState,
      hasBody: Boolean(document.body),
      hasDocumentElement: Boolean(document.documentElement),
    });

    window.addEventListener("__pluginverse_plugin_log__", (event) => {
      if (event.detail?.pluginId !== "mianshiya") {
        return;
      }
      log("info", "mianshiya_page_context_log", { message: event.detail?.message || "" });
    });
    window.addEventListener("__pluginverse_mianshiya_contextmenu__", (event) => {
      const detail = event.detail || {};
      showCustomMenu(detail.x || 20, detail.y || 20);
    });
    window.addEventListener("click", hideCustomMenu, true);
    window.addEventListener("scroll", hideCustomMenu, true);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideCustomMenu();
      }
    }, true);

    installEventGuards();
    injectPageContextGuard();
    injectStyle();
    installDownloadButton();

    const reinforce = () => {
      try {
        removeModalBlockers();
        injectStyle();
        installDownloadButton();
      } catch (error) {
        log("error", "mianshiya_reinforce_failed", { error: String(error?.stack || error) });
      }
    };

    window.setTimeout(reinforce, 100);
    window.setTimeout(reinforce, 600);
    window.setTimeout(reinforce, 1500);

    const timer = window.setInterval(reinforce, 2000);
    window.setTimeout(() => {
      window.clearInterval(timer);
      log("info", "mianshiya_reinforce_finished", {});
    }, 90000);
  }

  try {
    boot();
  } catch (error) {
    log("error", "mianshiya_plugin_boot_failed", { error: String(error?.stack || error) });
  }
})(PluginVerse);
