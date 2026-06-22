(function (PluginVerse) {
  "use strict";

  const VERSION = "0.6.0";
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

  let panelBody = null;
  let helperRoot = null;
  let styleEl = null;
  let customMenuEl = null;

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
      renderPanel();
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
    renderPanel();
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
        .markdown-body * {
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }

        #mianshiya-clip-helper,
        #mianshiya-clip-helper *,
        #mianshiya-custom-menu,
        #mianshiya-custom-menu * {
          -webkit-user-select: text !important;
          user-select: text !important;
          pointer-events: auto !important;
        }

        #mianshiya-clip-helper {
          position: fixed !important;
          right: 18px !important;
          bottom: 92px !important;
          z-index: 2147483647 !important;
          display: flex !important;
          flex-direction: column !important;
          gap: 8px !important;
          width: 360px !important;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        }

        #mianshiya-clip-helper button {
          border: 1px solid rgba(0, 0, 0, 0.16) !important;
          border-radius: 6px !important;
          padding: 8px 10px !important;
          color: #111827 !important;
          background: #ffffff !important;
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.18) !important;
          cursor: pointer !important;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        }

        #mianshiya-debug-panel {
          max-height: 260px !important;
          overflow: auto !important;
          white-space: pre-wrap !important;
          border: 1px solid rgba(0, 0, 0, 0.16) !important;
          border-radius: 6px !important;
          padding: 8px !important;
          color: #111827 !important;
          background: rgba(255, 255, 255, 0.97) !important;
          box-shadow: 0 6px 18px rgba(15, 23, 42, 0.18) !important;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
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

  function renderPanel() {
    if (!panelBody) {
      return;
    }

    const main = getMainContentNode();
    const status = [
      `插件：mianshiya v${VERSION}`,
      `客户端：${PluginVerse.client.name} ${PluginVerse.client.version}`,
      `URL：${location.href}`,
      `readyState：${document.readyState}`,
      `选区：${selectedText().length} 字`,
      `正文：${main ? visibleText(main).length : 0} 字`,
      `body user-select：${document.body ? getComputedStyle(document.body).userSelect : "n/a"}`,
      `事件：${Object.entries(eventCounts).map(([key, value]) => `${key}=${value}`).join(" ") || "暂无"}`,
      "",
      "日志：详见 PluginVerse 菜单或 Supabase pluginverse_logs 表。",
    ];

    panelBody.textContent = status.join("\n");
  }

  function makeButton(text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", async () => {
      const oldText = button.textContent;
      try {
        await onClick();
        button.textContent = "完成";
      } catch (error) {
        log("error", "mianshiya_button_failed", {
          action: text,
          error: String(error?.stack || error),
        });
        button.textContent = "失败";
      } finally {
        window.setTimeout(() => {
          button.textContent = oldText;
        }, 1200);
      }
    });
    return button;
  }

  function ensureHelper() {
    runWhenDomReady(() => {
      if (document.querySelector("#mianshiya-clip-helper")) {
        helperRoot = document.querySelector("#mianshiya-clip-helper");
        panelBody = document.querySelector("#mianshiya-debug-panel");
        renderPanel();
        return;
      }

      helperRoot = document.createElement("div");
      helperRoot.id = "mianshiya-clip-helper";

      panelBody = document.createElement("div");
      panelBody.id = "mianshiya-debug-panel";

      helperRoot.append(
        makeButton("复制当前选区", copySelection),
        makeButton("复制题目 Markdown", copyMarkdown),
        makeButton("上报页面快照", reportSnapshot),
        makeButton("复制页面快照", copySnapshot),
        makeButton("重新解除限制", async () => {
          installEventGuards();
          injectPageContextGuard();
          injectStyle();
          removeModalBlockers();
          log("info", "mianshiya_reinforce_by_button", {});
        }),
        panelBody,
      );

      domRoot().appendChild(helperRoot);
      log("info", "mianshiya_helper_inserted", {});
      renderPanel();
    }, "插入浮层");
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

    const reinforce = () => {
      try {
        removeModalBlockers();
        injectStyle();
        ensureHelper();
        renderPanel();
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
