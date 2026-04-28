let messages = [];
let chatTitle = "闲鱼聊天记录";
let contactName = "聊天对象";
let contactUserId = "unknown";
let productImageUrl = "";
let currentTabId = null;

let exportSubfolder = "闲鱼导出";
let autoScrollBeforeExport = true;
let isBusy = false;
let storageStatusLogged = false;
let batchStartMs = 0;
let lastScrollContainerLabel = "-";
let lastScrollDiagnostics = null;

const DEFAULT_SUBFOLDER = "闲鱼导出";
const AUTO_SCROLL_STAGNANT_ROUNDS = 2;
const AUTO_SCROLL_MAX_MS = 45000;
const AUTO_SCROLL_WAIT_MS = 300;

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  await loadSettings();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) {
      showEmpty("读取失败，请刷新页面后重试");
      return;
    }
    if (!isXianyuChatUrl(tab.url)) {
      showEmpty("当前仅支持闲鱼聊天导出");
      return;
    }

    currentTabId = tab.id;
    const data = await fetchConversationData(currentTabId);
    if (!data) {
      showEmpty("读取失败，请刷新页面后重试");
      return;
    }

    if (!Array.isArray(data.messages) || data.messages.length === 0) {
      const hint = data.hasChatPane
        ? "页面结构变化，已切换兼容模式，请先向上滚动后重试"
        : "未读取到聊天消息，请先打开具体会话再导出";
      showEmpty(hint);
      return;
    }

    applyConversationData(data, true);
    renderMessages();
    showContent();
    updateStatus();
    updateSelectAll();
  } catch (error) {
    console.error("读取聊天失败:", error);
    showEmpty("读取失败，请刷新页面后重试");
  }
});

function bindEvents() {
  document.getElementById("selectAll")?.addEventListener("change", (event) => {
    const checked = !!event.target.checked;
    messages.forEach((msg) => {
      msg.selected = checked;
    });
    document.querySelectorAll('.message-item input[type="checkbox"]').forEach((cb) => {
      cb.checked = checked;
    });
    updateStatus();
  });

  const folderInput = document.getElementById("exportSubfolder");
  folderInput?.addEventListener("blur", saveSettings);
  folderInput?.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await saveSettings();
      folderInput.blur();
    }
  });

  document.getElementById("autoScrollBeforeExport")?.addEventListener("change", saveSettings);
  document.getElementById("debugMode")?.addEventListener("change", () => {
    updateStatus();
    renderScrollDiagnostics();
  });
  document.getElementById("exportBundle")?.addEventListener("click", handleExportCurrentConversation);
  document.getElementById("exportAll")?.addEventListener("click", handleExportAllConversations);
}

function getStorageArea() {
  const storageRoot = typeof chrome !== "undefined" ? chrome.storage : undefined;
  const localArea = storageRoot?.local;
  const usable = !!localArea && typeof localArea.get === "function" && typeof localArea.set === "function";

  if (!storageStatusLogged) {
    storageStatusLogged = true;
    console.info("[settings] storage.local enabled:", usable);
  }

  return usable ? localArea : null;
}

async function loadSettings() {
  const storageArea = getStorageArea();
  if (!storageArea) {
    exportSubfolder = DEFAULT_SUBFOLDER;
    autoScrollBeforeExport = true;
    const folderInput = document.getElementById("exportSubfolder");
    const autoInput = document.getElementById("autoScrollBeforeExport");
    if (folderInput) folderInput.value = exportSubfolder;
    if (autoInput) autoInput.checked = autoScrollBeforeExport;
    return { ok: true, persisted: false, reason: "storage_unavailable" };
  }

  try {
    const saved = await storageArea.get({
      exportSubfolder: DEFAULT_SUBFOLDER,
      autoScrollBeforeExport: true
    });
    exportSubfolder = normalizeSubfolder(saved.exportSubfolder);
    autoScrollBeforeExport = saved.autoScrollBeforeExport !== false;
  } catch (error) {
    console.warn("读取设置失败:", error);
    exportSubfolder = DEFAULT_SUBFOLDER;
    autoScrollBeforeExport = true;
  }

  const folderInput = document.getElementById("exportSubfolder");
  const autoInput = document.getElementById("autoScrollBeforeExport");
  if (folderInput) folderInput.value = exportSubfolder;
  if (autoInput) autoInput.checked = autoScrollBeforeExport;
  return { ok: true, persisted: true };
}

async function saveSettings() {
  const folderInput = document.getElementById("exportSubfolder");
  const autoInput = document.getElementById("autoScrollBeforeExport");
  exportSubfolder = normalizeSubfolder(folderInput?.value || "");
  autoScrollBeforeExport = !!autoInput?.checked;

  if (folderInput && folderInput.value !== exportSubfolder) {
    folderInput.value = exportSubfolder;
  }

  const storageArea = getStorageArea();
  if (!storageArea) {
    return { ok: true, persisted: false, reason: "storage_unavailable" };
  }

  try {
    await storageArea.set({
      exportSubfolder,
      autoScrollBeforeExport
    });
    return { ok: true, persisted: true };
  } catch (error) {
    console.warn("settings save skipped:", error);
    return { ok: true, persisted: false, reason: "storage_set_failed" };
  }
}

function isXianyuChatUrl(url) {
  return String(url || "").includes("xianyu.com") || String(url || "").includes("goofish.com");
}

function setBusy(isRunning, message) {
  isBusy = isRunning;

  const btnCurrent = document.getElementById("exportBundle");
  const btnAll = document.getElementById("exportAll");
  if (btnCurrent) {
    btnCurrent.disabled = isRunning;
    btnCurrent.textContent = isRunning ? (message || "处理中...") : "导出当前会话（JSON + HTML）";
  }
  if (btnAll) {
    btnAll.disabled = isRunning;
    btnAll.textContent = isRunning ? "处理中..." : "批量导出左侧全部会话（可核对结果）";
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0秒";
  const sec = Math.ceil(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem > 0 ? `${min}分${rem}秒` : `${min}分`;
}

function updateRunProgress(stage, summary, eta) {
  const block = document.getElementById("runProgress");
  const stageEl = document.getElementById("progressStage");
  const summaryEl = document.getElementById("progressSummary");
  const etaEl = document.getElementById("progressEta");
  if (!block || !stageEl || !summaryEl || !etaEl) return;
  stageEl.textContent = `阶段：${stage || "-"}`;
  summaryEl.textContent = `进度：${summary || "-"}`;
  etaEl.textContent = `预计剩余：${eta || "-"}`;
  block.style.display = "block";
}

function hideRunProgress() {
  const block = document.getElementById("runProgress");
  if (block) block.style.display = "none";
}

function describeScrollReason(reason) {
  const mapping = {
    route_locked: "已锁定滚动链路",
    route_missing: "未锁定滚动链路",
    route_no_growth: "链路已锁定，但本轮没有继续上翻",
    content_hit_missing: "没有命中聊天内容区",
    no_scroll_route: "命中内容区，但没有找到可响应的滚动链路",
    active_node_missing: "已锁定的滚动节点失效"
  };
  return mapping[reason] || reason || "未知原因";
}

function rememberScrollDiagnostics(diag) {
  lastScrollDiagnostics = diag || null;
  renderScrollDiagnostics();
}

function clearScrollDiagnostics() {
  lastScrollDiagnostics = null;
  renderScrollDiagnostics();
}

function formatScrollChain(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return "-";
  return chain
    .map((item) => {
      if (!item) return "unknown";
      if (typeof item === "string") return item;
      const label = item.label || "unknown";
      const top = Number.isFinite(item.scrollTop) ? item.scrollTop : 0;
      const height = Number.isFinite(item.clientHeight) ? item.clientHeight : 0;
      return `${label}(top=${top},h=${height})`;
    })
    .join(" -> ");
}

function renderScrollDiagnostics() {
  const block = document.getElementById("scrollDiagnostics");
  const debugMode = document.getElementById("debugMode")?.checked;
  const contentHit = document.getElementById("diagContentHit");
  const chain = document.getElementById("diagChain");
  const mode = document.getElementById("diagMode");
  const node = document.getElementById("diagNode");
  const reason = document.getElementById("diagReason");

  if (!block || !contentHit || !chain || !mode || !node || !reason) return;

  if (!debugMode || !lastScrollDiagnostics) {
    block.style.display = "none";
    return;
  }

  contentHit.textContent = `content_hit: ${lastScrollDiagnostics.contentHit || "-"}`;
  chain.textContent = `scroll_chain: ${formatScrollChain(lastScrollDiagnostics.scrollChain)}`;
  mode.textContent = `active_scroll_mode: ${lastScrollDiagnostics.activeScrollMode || "-"}`;
  node.textContent = `active_scroll_node: ${lastScrollDiagnostics.activeScrollNode || "-"}`;
  reason.textContent = `diagnostic_reason: ${lastScrollDiagnostics.reason || "-"}`;
  block.style.display = "block";
}

function applyConversationData(data, resetSelection) {
  messages = ensureMessageRequiredFields(data.messages || []).map((msg, index) => ({
    ...msg,
    id: Number.isFinite(msg.id) ? msg.id : index,
    selected: resetSelection ? true : msg.selected !== false
  }));

  chatTitle = data.chatTitle || "闲鱼聊天记录";
  contactName = data.contactName || chatTitle || "聊天对象";
  contactUserId = data.contactUserId || "unknown";
  productImageUrl = data.productImageUrl || "";
}

function ensureMessageRequiredFields(list) {
  let lastTime = "";
  let lastProduct = "";
  return (list || []).map((msg) => {
    const rawTime = String(msg?.timestamp || "").trim();
    if (rawTime) lastTime = rawTime;
    const time = rawTime || lastTime || "未知时间";

    const rawProduct = String(msg?.product?.groupName || "").trim();
    if (rawProduct) lastProduct = rawProduct;
    const productName = rawProduct || lastProduct || "未识别商品";

    return {
      ...msg,
      timestamp: time,
      product: { ...(msg?.product || {}), groupName: productName }
    };
  });
}

async function fetchConversationData(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractCurrentConversationInjected
  });

  const imgResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const el = document.querySelector('img[src*="fleamarket"]');
      if (!el) return null;
      let src = el.getAttribute("src") || "";
      if (src.startsWith("//")) src = "https:" + src;
      return src;
    }
  });
  const productImgUrl = imgResults?.find(r => r.result)?.result || "";

  const data = result?.[0]?.result || null;
  if (data && productImgUrl) {
    data.productImageUrl = productImgUrl;
  }
  return data;
}

async function autoScrollCurrentConversation(tabId) {
  const start = Date.now();

  updateRunProgress("自动翻取中", "正在用简化模式翻取聊天记录...", "-");

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    args: [AUTO_SCROLL_STAGNANT_ROUNDS, AUTO_SCROLL_MAX_MS, AUTO_SCROLL_WAIT_MS],
    func: simpleAutoScrollInjected
  });

  const stat = result?.[0]?.result;
  if (!stat?.ok) {
    return stat || { ok: false, reason: "自动翻取失败" };
  }

  lastScrollContainerLabel = stat.isReverse ? "message-list-reverse(simple)" : "message-list(simple)";
  rememberScrollDiagnostics({
    contentHit: "simple-mode",
    scrollChain: [],
    activeScrollMode: stat.isReverse ? "scrollTop+reverse" : "scrollTop",
    activeScrollNode: lastScrollContainerLabel,
    reason: stat.stoppedBy || "done"
  });

  const elapsed = Date.now() - start;
  updateRunProgress(
    "自动翻取完成",
    `轮次 ${stat.loops} | 消息节点 ${stat.count} | ${stat.stoppedBy} | 耗时 ${Math.round(elapsed / 1000)}s | reverse=${stat.isReverse}`,
    "-"
  );

  return {
    ok: true,
    stoppedBy: stat.stoppedBy,
    loops: stat.loops || 0,
    effectiveRounds: stat.loops || 0,
    stagnantRounds: 0,
    detectedCount: stat.count || 0,
    top: stat.scrollTop || 0,
    delta: 0,
    containerLabel: lastScrollContainerLabel,
    contentHit: "simple-mode",
    scrollChain: [],
    activeScrollMode: stat.isReverse ? "reverse" : "normal",
    activeScrollNode: lastScrollContainerLabel,
    route: null,
    durationMs: elapsed
  };
}

function exportAllInOneInjected(stagnantRounds, maxMs, waitMs, doScroll, subfolder) {
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function getText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function isNoiseMedia(urlValue) {
    const x = String(urlValue || "").trim().toLowerCase();
    if (!x || !/^https?:\/\//.test(x)) return true;
    if (x.includes("tps-2-2") || x.includes("tps-1-1")) return true;
    if (x.includes("avatar") || x.includes("profile") || x.includes("head")) return true;
    if (x.includes("placeholder") || x.includes("default")) return true;
    return false;
  }

  function detectChatPane() {
    const preferred = Array.from(
      document.querySelectorAll(
        '[class*="chat-main"], [class*="message-list"], [class*="message-panel"], [class*="chat-content"], [class*="chat-window"], main, section, div'
      )
    )
      .filter(function (el) {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width < 300 || (rect.height < 60 && el.scrollHeight < 300)) return false;
        if (rect.left < window.innerWidth * 0.28) return false;
        if (rect.right <= 0 || rect.top >= window.innerHeight) return false;
        const cls = String(el.className || "").toLowerCase();
        if (/(sidebar|sider|header|footer|sendbox|toolbar|input|editor|composer|session-list|conv-list)/.test(cls)) return false;
        return el.querySelectorAll("div,span,p,img,video").length > 20;
      })
      .map(function (el) {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "").toLowerCase();
        let score = rect.width * rect.height;
        if (/(chat-main|message-list|message-panel|chat-content|chat-window)/.test(cls)) score += 500000;
        if (rect.left > window.innerWidth * 0.35) score += 120000;
        return { el: el, score: score };
      })
      .sort(function (a, b) { return b.score - a.score; });
    if (preferred[0]?.el) return preferred[0].el;

    var composer =
      document.querySelector('textarea[placeholder*="输入"]') ||
      document.querySelector('input[placeholder*="输入"]') ||
      document.querySelector('div[contenteditable="true"]');
    if (!composer) return null;
    var current = composer;
    for (var i = 0; i < 12 && current; i += 1) {
      if ((current.querySelectorAll("div,span,p,img,video") || []).length > 20) return current;
      current = current.parentElement;
    }
    return composer.parentElement || null;
  }

  function looksLikeSidebarNode(el) {
    var rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.left < window.innerWidth * 0.28 && rect.width < window.innerWidth * 0.45;
  }

  function getCandidates(root) {
    var legacy = Array.from(root.querySelectorAll('[class*="ant-list-item"]')).filter(function (el) { return !looksLikeSidebarNode(el); });
    if (legacy.length > 1) return { mode: "legacy", nodes: legacy };

    var modern = Array.from(
      root.querySelectorAll(
        '[data-message-id], [class*="message-row"], [class*="message-item"], [class*="msg-item"], [class*="chat-item"], [class*="bubble"]'
      )
    ).filter(function (el) { return !looksLikeSidebarNode(el); });
    if (modern.length > 0) return { mode: "modern", nodes: modern };

    var fallback = Array.from(root.querySelectorAll("div,p,span"))
      .filter(function (el) { return el.children.length === 0; })
      .filter(function (el) {
        var text = getText(el);
        return text.length >= 2 && text.length <= 240;
      })
      .filter(function (el) { return !looksLikeSidebarNode(el); })
      .slice(0, 800);
    return { mode: "fallback", nodes: fallback };
  }

  function detectIsMe(el) {
    var cls = String(el.className || "").toLowerCase();
    if (/(mine|self|me|right|owner|send|outgoing)/.test(cls)) return true;
    if (/(left|other|incoming|peer)/.test(cls)) return false;
    var style = String(el.getAttribute("style") || "").toLowerCase();
    if (style.includes("direction: rtl") || style.includes("text-align: right")) return true;
    if (style.includes("text-align: left")) return false;
    var rect = el.getBoundingClientRect?.();
    return !!rect && rect.left > window.innerWidth * 0.5;
  }

  function extractProductInfo(el) {
    var cls = String(el.className || "");
    var isProductCard = /price|product|goods|item-card/.test(cls);
    if (!isProductCard && !el.querySelector('[class*="price"]')) return null;
    var titleEl = el.querySelector('[class*="item-title"], [class*="item-name"], [class*="title"]');
    var text = getText(el);
    var priceMatch = text.match(/[￥¥]\s*\d+(?:\.\d{1,2})?/);
    if (!titleEl && !priceMatch) return null;
    return { groupName: getText(titleEl) || priceMatch?.[0] || "商品信息" };
  }

  function findProductImage() {
    // 1. Chat header product image (most reliable)
    var headerSelectors = [
      'main [class*="message-topbar"] [class*="left--"] img',
      'main [class*="container"][data-spm="head"] [class*="left--"] img',
      'main div[class*="left--"] > div > img'
    ];
    for (var hi = 0; hi < headerSelectors.length; hi++) {
      var hel = document.querySelector(headerSelectors[hi]);
      if (hel) {
        var hsrc = hel.getAttribute("src") || "";
        if (hsrc.startsWith("//")) hsrc = "https:" + hsrc;
        if (hsrc && !isNoiseMedia(hsrc)) return hsrc;
      }
    }
    // 2. Fallback: CDN pattern search
    var selectors = [
      'img[src*="fleamarket"]',
      'img[src*="goofish"]',
      'img[src*="alicdn"]',
      'img[src*="taobaocdn"]'
    ];
    for (var si = 0; si < selectors.length; si++) {
      var el = document.querySelector(selectors[si]);
      if (el && !isNoiseMedia(el.getAttribute("src") || "")) {
        var src = el.getAttribute("src") || "";
        if (src.startsWith("//")) src = "https:" + src;
        return src;
      }
    }
    var iframes = document.querySelectorAll("iframe");
    for (var i = 0; i < iframes.length; i++) {
      try {
        for (var sj = 0; sj < selectors.length; sj++) {
          var el2 = iframes[i].contentDocument?.querySelector(selectors[sj]);
          if (el2 && !isNoiseMedia(el2.getAttribute("src") || "")) {
            var src2 = el2.getAttribute("src") || "";
            if (src2.startsWith("//")) src2 = "https:" + src2;
            return src2;
          }
        }
      } catch (e) { /* cross-origin */ }
    }
    return "";
  }

  function findTransactionStatus() {
    // Only check the currently active conversation item in sidebar
    // The active item typically has a distinct background/border class
    var scrollable = document.querySelector('[id*="conv-list"]') || document.querySelector('[class*="conv-list"]');
    if (!scrollable) return "";
    // Find active item — look for highlighted/selected style indicators
    var items = scrollable.querySelectorAll(':scope > div > div, :scope > div');
    var activeItem = null;
    for (var ii = 0; ii < items.length; ii++) {
      var style = items[ii].getAttribute("style") || "";
      var cls = items[ii].className || "";
      if (style.includes("background") || style.includes("border") || cls.indexOf("active") > -1 || cls.indexOf("selected") > -1 || cls.indexOf("current") > -1) {
        activeItem = items[ii];
        break;
      }
    }
    if (!activeItem) return "";
    var badge = activeItem.querySelector('[class*="order-success"]');
    if (badge) {
      var txt = getText(badge).trim();
      if (txt) return txt;
    }
    return "";
  }

  function findProductName() {
    var headerEl = document.querySelector('[class*="goods-name"], [class*="item-title"], [class*="product-name"], [class*="commodity-name"]');
    if (headerEl) return getText(headerEl);
    var cardEl = document.querySelector('[class*="product-card"], [class*="goods-card"], [class*="item-card"]');
    if (cardEl) {
      var titleEl = cardEl.querySelector('[class*="title"], [class*="name"]');
      if (titleEl) return getText(titleEl);
    }
    return "";
  }

  function sanitizeName(value) {
    var raw = String(value || "unknown").trim();
    return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").replace(/_+/g, "_").slice(0, 64) || "unknown";
  }

  function extractTimestamp(node) {
    var ownTime = getText(node.querySelector("time")) || getText(node.querySelector('[class*="time"]'));
    if (ownTime) return ownTime;

    // Time pattern — used for both matching and extraction
    var timeRe = /((\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2}))|((\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2}))|((\d{1,2}):(\d{2}))/;

    // 向上找相对定位容器，遍历其前面的兄弟
    var container = node.closest ? node.closest('[style*="position: relative"]') : null;
    var startEl = container || node.parentElement;
    var prev = startEl ? startEl.previousElementSibling : node.previousElementSibling;
    while (prev) {
      // Only check centered elements (time separators are centered)
      var centerEl = prev.querySelector('[style*="text-align: center"]');
      if (centerEl) {
        var ct = getText(centerEl).trim();
        if (ct.length < 30 && timeRe.test(ct)) {
          var m = ct.match(timeRe);
          return m ? m[0].trim() : ct;
        }
      }
      // Also accept prev itself if it's short and looks like a time label
      var pt = getText(prev).trim();
      if (pt.length < 30 && timeRe.test(pt) && !prev.querySelector('[class*="message"], [class*="bubble"], [class*="msg"]')) {
        var m2 = pt.match(timeRe);
        return m2 ? m2[0].trim() : pt;
      }
      prev = prev.previousElementSibling;
    }
    return "";
  }

  function parseTimestampForFilename(text) {
    if (!text) return "";
    var cleaned = text.replace(/\s+/g, " ").trim();
    var now = new Date();
    var y, m, d, hh, mm;
    var match;
    match = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
    if (match) { y = +match[1]; m = +match[2]; d = +match[3]; hh = +match[4]; mm = +match[5]; }
    else {
      match = cleaned.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
      if (match) { y = now.getFullYear(); m = +match[1]; d = +match[2]; hh = +match[3]; mm = +match[4]; }
      else {
        match = cleaned.match(/(\d{1,2}):(\d{2})/);
        if (match) { y = now.getFullYear(); m = now.getMonth() + 1; d = now.getDate(); hh = +match[1]; mm = +match[2]; }
        else return "";
      }
    }
    var date = new Date(y, m - 1, d, hh, mm, 0, 0);
    return Number.isNaN(date.getTime()) ? "" : formatDateForFilename(date);
  }

  function formatDateForFilename(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, "0");
    var d = String(date.getDate()).padStart(2, "0");
    var hh = String(date.getHours()).padStart(2, "0");
    var mm = String(date.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + d + "_" + hh + "-" + mm;
  }

  return (async function () {
    try {
      // 1. Auto-scroll
      if (doScroll) {
        var ml = document.querySelector('[class*="message-list"]');
        if (ml) {
          var savedBodyOverflow = document.body.style.overflow;
          document.body.style.overflow = "hidden";
          if (ml.clientHeight === 0) {
            ml.style.minHeight = (ml.parentElement ? ml.parentElement.clientHeight : 400) + "px";
            void ml.offsetHeight;
          }
          var style = window.getComputedStyle(ml);
          var isReverse = style.flexDirection === "column-reverse" || style.flexDirection === "row-reverse";
          var start = Date.now();
          var stagnant = 0;
          var lastCount = -1;
          var loops = 0;

          while (Date.now() - start < maxMs) {
            loops++;
            var beforeSH = ml.scrollHeight;
            if (isReverse) { ml.scrollTop = -ml.scrollHeight; } else { ml.scrollTop = 0; }
            await sleep(waitMs);
            var afterSH = ml.scrollHeight;
            var count = ml.querySelectorAll('[class*="message"],[class*="msg"],[class*="bubble"],[class*="ant-list-item"],[data-message-id],img[src*="alicdn"],img[src*="goofish"],video').length;
            if (afterSH === beforeSH && count === lastCount) { stagnant++; } else { stagnant = 0; }
            lastCount = count;
            if (stagnant >= stagnantRounds) break;
          }
          // Reload newest messages — virtual scroll may have unloaded them
          if (isReverse) { ml.scrollTop = 0; } else { ml.scrollTop = ml.scrollHeight; }
          await sleep(waitMs);
          document.body.style.overflow = savedBodyOverflow;
        }
      }

      // 2. Wait for DOM settle
      await sleep(300);

      // 3. Extract contact name
      var nameDivs = Array.from(
        document.querySelectorAll('div[style*="font-size: 12px"][style*="rgb(102, 102, 102)"]')
      ).filter(function (el) { return !el.getAttribute("style").includes("align-self") && el.textContent.trim().length > 0; });
      var contactName = (nameDivs[0]?.textContent?.trim())
        || getText(document.querySelector('[class*="nickname"]'))
        || getText(document.querySelector('[class*="user-name"]'))
        || getText(document.querySelector('[class*="chat-title"]'))
        || "闲鱼聊天记录";

      // 4. Extract messages
      var pane = detectChatPane();
      var detected = getCandidates(pane || document);
      var nodes = detected.nodes || [];
      var result = [];
      var dedupe = new Set();
      var currentProduct = null;

      for (var ni = 0; ni < nodes.length; ni++) {
        var el = nodes[ni];
        var product = extractProductInfo(el);
        if (!product && el.previousElementSibling) product = extractProductInfo(el.previousElementSibling);
        if (product) currentProduct = product;

        var isMe = detectIsMe(el);
        var text =
          getText(el.querySelector('[class*="message-text"] > span')) ||
          getText(el.querySelector('[class*="message-text"]')) ||
          getText(el.querySelector('[class*="msg-text"]')) ||
          getText(el.querySelector('[class*="content"]')) ||
          getText(el.querySelector('[class*="bubble"]')) ||
          getText(el);

        var imageUrl = "";
        var imageEl = el.querySelector('[class*="image-container"] img, .ant-image-img, img[src*="alicdn"], img[src*="goofish"], img');
        if (imageEl) {
          imageUrl = imageEl.getAttribute("src") || imageEl.getAttribute("data-src") || "";
          if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
          if (isNoiseMedia(imageUrl)) imageUrl = "";
        }

        var videoEl = el.querySelector("video");
        var videoUrl = "";
        if (videoEl) {
          videoUrl = videoEl.getAttribute("src") || videoEl.getAttribute("data-src") || "";
          if (videoUrl.startsWith("//")) videoUrl = "https:" + videoUrl;
          if (isNoiseMedia(videoUrl)) videoUrl = "";
        }

        if (!text && imageUrl) text = "[图片]";
        if (!text && videoUrl) text = "[视频]";
        if (!text && !imageUrl && !videoUrl) continue;

        var dedupeKey = (isMe ? "me" : "other") + "|" + text + "|" + imageUrl + "|" + videoUrl;
        if (dedupe.has(dedupeKey)) continue;
        dedupe.add(dedupeKey);

        var timestamp = extractTimestamp(el);
        result.push({ id: result.length, isMe: isMe, text: text || "", selected: true, timestamp: timestamp || "", imageUrl: imageUrl, videoUrl: videoUrl });
      }

      if (result.length === 0) {
        return { ok: false, reason: "未读取到聊天消息" };
      }

      // Forward-fill timestamps
      var lastTime = "";
      for (var fi = 0; fi < result.length; fi++) {
        if (result[fi].timestamp) lastTime = result[fi].timestamp;
        else result[fi].timestamp = lastTime;
      }

      // 5. Search product info & transaction status
      var productName = findProductName();
      var productImgUrl = findProductImage();
      var transactionStatus = findTransactionStatus();

      // 6. Build JSON
      var product = productName || productImgUrl || "未识别商品";
      var rows = result.map(function (msg, idx) {
        return { id: idx, role: msg.isMe ? "me" : "other", text: msg.text || "", timestamp: msg.timestamp || "" };
      });
      var jsonObj = { product: product, transactionStatus: transactionStatus || "", messages: rows };
      var json = JSON.stringify(jsonObj, null, 2);

      // 7. Build filename — use last message timestamp, fallback to export time
      var lastTimestamp = "";
      for (var ri = result.length - 1; ri >= 0; ri--) {
        if (result[ri].timestamp) { lastTimestamp = result[ri].timestamp; break; }
      }
      var dateStr = parseTimestampForFilename(lastTimestamp) || formatDateForFilename(new Date());
      var safeContact = sanitizeName(contactName);
      var filename = subfolder ? subfolder + "/" + safeContact + "_" + dateStr + ".json" : safeContact + "_" + dateStr + ".json";

      return { ok: true, count: result.length, filename: filename, contactName: contactName, json: json, messages: result, product: product, transactionStatus: transactionStatus };
    } catch (e) {
      return { ok: false, reason: e.message || "未知错误" };
    }
  })();
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

function generateHtmlExport(msgs, contactName, product, transactionStatus) {
  const messagesHtml = msgs.map(function (msg) {
    var roleClass = msg.isMe ? "me" : "other";
    var sender = msg.isMe ? "我" : escapeHtml(contactName);
    var content = "";
    if (msg.imageUrl) {
      content += '<img class="chat-img" src="' + msg.imageUrl + '" alt="图片">';
    }
    if (msg.videoUrl) {
      content += '<video class="chat-video" src="' + msg.videoUrl + '" controls></video>';
    }
    if (!msg.imageUrl && !msg.videoUrl) {
      content += '<div class="text">' + escapeHtml(msg.text) + "</div>";
    }
    var timeHtml = msg.timestamp ? '<div class="time">' + escapeHtml(msg.timestamp) + "</div>" : "";
    return '<div class="msg ' + roleClass + '">' +
      '<div class="bubble">' + content + timeHtml + "</div></div>";
  }).join("\n");

  return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>聊天记录 - ' + escapeHtml(contactName) + '</title><style>' +
    "* { margin: 0; padding: 0; box-sizing: border-box; }" +
    "body { font-family: -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Microsoft YaHei\", sans-serif; background: #f5f5f5; padding: 20px; line-height: 1.5; }" +
    ".container { max-width: 900px; width: 80%; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); overflow: hidden; }" +
    ".header { background: linear-gradient(135deg, #FFE14D, #FFC107); color: #333; padding: 16px 20px; font-weight: 600; font-size: 16px; }" +
    ".meta { padding: 10px 20px; background: #fafafa; border-bottom: 1px solid #eee; font-size: 12px; color: #999; }" +
    ".chat { padding: 16px; background: #f7f7f7; }" +
    ".msg { display: flex; margin-bottom: 16px; align-items: flex-start; }" +
    ".msg.me { justify-content: flex-end; }" +
    ".bubble { max-width: 70%; padding: 10px 14px; border-radius: 12px; position: relative; }" +
    ".msg .bubble { background: #fff; border: 1px solid #e8e8e8; }" +
    ".msg.me .bubble { background: #FFE14D; color: #333; }" +
    ".text { font-size: 14px; word-break: break-word; }" +
    ".chat-img { max-width: 200px; max-height: 300px; border-radius: 8px; display: block; cursor: pointer; }" +
    ".chat-video { max-width: 200px; border-radius: 8px; }" +
    ".time { font-size: 11px; color: #999; margin-top: 6px; text-align: right; }" +
    ".msg.me .time { color: rgba(0,0,0,0.5); }" +
    "</style></head><body><div class=\"container\">" +
    '<div class="header">💬 聊天记录：' + escapeHtml(contactName) + "</div>" +
    '<div class="meta">📅 导出时间：' + new Date().toLocaleString("zh-CN") + " | 📱 来源：闲鱼 | 商品：" + escapeHtml(product) + (transactionStatus ? " | " + escapeHtml(transactionStatus) : "") + "</div>" +
    '<div class="chat">' + messagesHtml + "</div></div></body></html>";
}

async function handleExportCurrentConversation() {
  if (isBusy) return;
  if (!currentTabId) {
    alert("当前页面未就绪，请刷新后重试");
    return;
  }

  try {
    setBusy(true, "正在导出当前会话...");
    hideBatchReport();
    updateRunProgress("导出中", "正在读取聊天记录...", "-");

    await saveSettings();

    const subfolder = normalizeSubfolder(exportSubfolder);
    const resultWrap = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      args: [AUTO_SCROLL_STAGNANT_ROUNDS, AUTO_SCROLL_MAX_MS, AUTO_SCROLL_WAIT_MS, autoScrollBeforeExport, subfolder],
      func: exportAllInOneInjected
    });

    const result = resultWrap?.[0]?.result;
    if (!result?.ok) {
      alert(`导出失败: ${result?.reason || "未知错误"}`);
      return;
    }

    // Derive base name from the JSON filename
    const jsonBaseName = result.filename.replace(/\.json$/, "");
    const baseNameNoFolder = jsonBaseName.includes("/") ? jsonBaseName.split("/").pop() : jsonBaseName;

    // JSON → json/ subfolder
    const jsonPath = subfolder ? subfolder + "/json/" + baseNameNoFolder + ".json" : "json/" + baseNameNoFolder + ".json";
    await downloadFile(result.json, jsonPath, "application/json");

    // HTML → html/ subfolder
    const html = generateHtmlExport(result.messages, result.contactName, result.product, result.transactionStatus);
    const htmlPath = subfolder ? subfolder + "/html/" + baseNameNoFolder + ".html" : "html/" + baseNameNoFolder + ".html";
    await downloadFile(html, htmlPath, "text/html");

    updateRunProgress("完成", `已导出 ${result.count} 条消息\n${jsonPath}\n${htmlPath}`, "0秒");
    alert(`导出完成\n${result.count} 条消息\nJSON: ${jsonPath}\nHTML: ${htmlPath}`);
  } catch (error) {
    console.error("导出失败:", error);
    alert(`导出失败: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function handleExportAllConversations() {
  if (isBusy) return;
  if (!currentTabId) {
    alert("当前页面未就绪，请刷新后重试");
    return;
  }

  try {
    setBusy(true, "正在批量导出...");
    hideBatchReport();
    clearScrollDiagnostics();
    batchStartMs = Date.now();
    updateRunProgress("探测会话", "正在扫描左侧会话列表", "-");
    const settingsState = await saveSettings();
    if (!settingsState?.persisted) {
      console.info("[settings] batch export continues without persistence:", settingsState?.reason || "unknown");
    }

    const discoveryWrap = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      args: [AUTO_SCROLL_STAGNANT_ROUNDS],
      func: discoverBatchConversationsInjected
    });
    const discovered = discoveryWrap?.[0]?.result;
    if (!discovered?.ok) {
      renderBatchReport({
        status: "部分完成",
        total: 0,
        success: 0,
        failed: 1,
        skipped: 0,
        unprocessed: 0,
        mdFiles: 0,
        jsonFiles: 0,
        failures: [`批量任务失败：${discovered?.reason || "未知错误"}`]
      });
      return;
    }

    const entries = discovered.entries || [];
    updateRunProgress("探测完成", `共发现 ${entries.length} 个会话，开始逐条导出`, "-");

    const allFailures = [];
    let jsonFiles = 0;
    let successCount = 0;
    let skipped = Number(discovered.skippedCount || 0);

    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i];
      const processed = i;
      const elapsed = Date.now() - batchStartMs;
      const avg = processed > 0 ? elapsed / processed : 0;
      const remain = Math.max(0, entries.length - processed);
      const etaText = processed > 0 ? formatDuration(avg * remain) : "-";
      updateRunProgress(
        "批量导出中",
        `当前 ${i + 1}/${entries.length}：${item.name || "未命名会话"}\n成功 ${successCount} | 失败 ${allFailures.length} | 跳过 ${skipped}\n文件 json=${jsonFiles}`,
        etaText
      );
      try {
        const resultWrap = await chrome.scripting.executeScript({
          target: { tabId: currentTabId },
          args: [item, AUTO_SCROLL_STAGNANT_ROUNDS, AUTO_SCROLL_MAX_MS, AUTO_SCROLL_WAIT_MS],
          func: processConversationInjected
        });
        const result = resultWrap?.[0]?.result;
        if (result?.scrollStat) {
          rememberScrollDiagnostics({
            contentHit: result.scrollStat.contentHit || "-",
            scrollChain: result.scrollStat.scrollChain || [],
            activeScrollMode: result.scrollStat.activeScrollMode || "-",
            activeScrollNode: result.scrollStat.activeScrollNode || "-",
            reason: result.scrollStat.reason || (result.scrollStat.route ? "route_locked" : "route_missing")
          });
        }
        if (!result?.ok) {
          allFailures.push(`${item.name || "未命名会话"} | ${result?.stage || "提取"} | ${describeScrollReason(result?.reason)}`);
          continue;
        }

        const convo = result.data || {};
        const bundle = buildExportBundle(convo.messages || [], {
          chatTitle: convo.chatTitle || "闲鱼聊天记录",
          contactName: convo.contactName || item.name || "聊天对象",
          contactUserId: convo.contactUserId || "unknown"
        });

        await downloadFile(bundle.json, buildDownloadPath(`${bundle.baseName}.json`), "application/json");
        jsonFiles += 1;
        successCount += 1;
      } catch (error) {
        allFailures.push(`${item.name || "未命名会话"} | 写出 | ${error.message}`);
      }
    }

    const failed = allFailures.length;
    const total = Number(entries.length);
    const unprocessed = Math.max(0, total - successCount - failed);

    // 完成判定采用三层口径：左侧探测完成 + 无未处理 + 写出成对文件。
    const complete =
      Boolean(discovered.listComplete) &&
      unprocessed === 0 &&
      jsonFiles === successCount;

    renderBatchReport({
      status: complete ? "完成" : "部分完成",
      total,
      success: successCount,
      failed,
      skipped,
      unprocessed,
      mdFiles: jsonFiles,
      jsonFiles,
      failures: allFailures
    });
    updateRunProgress(
      complete ? "批量导出完成" : "批量导出部分完成",
      `总会话 ${total} | 成功 ${successCount} | 失败 ${failed} | 跳过 ${skipped}\n文件 json=${jsonFiles}`,
      "0秒"
    );

    if (complete) {
      alert("批量导出已全部完成，可在报告里核对数量");
    } else {
      alert("批量导出部分完成，请查看失败清单");
    }
  } catch (error) {
    console.error("批量导出失败:", error);
    updateRunProgress("批量导出异常", error.message || "未知错误", "-");
    renderBatchReport({
      status: "部分完成",
      total: 0,
      success: 0,
      failed: 1,
      skipped: 0,
      unprocessed: 0,
      mdFiles: 0,
      jsonFiles: 0,
      failures: [`批量任务异常：${error.message}`]
    });
  } finally {
    setBusy(false);
  }
}

function renderBatchReport(report) {
  const block = document.getElementById("batchReport");
  const status = document.getElementById("reportStatus");
  const summary = document.getElementById("reportSummary");
  const files = document.getElementById("reportFiles");
  const failures = document.getElementById("reportFailures");
  if (!block || !status || !summary || !files || !failures) return;

  const isComplete = report.status === "完成";
  status.textContent = `任务状态：${isComplete ? "已全部导出完成" : "部分完成，请查看失败清单"}`;
  summary.textContent = `总会话: ${report.total} | 成功: ${report.success} | 失败: ${report.failed} | 跳过: ${report.skipped} | 未处理: ${report.unprocessed}`;
  files.textContent = `文件核对: json=${report.jsonFiles}`;

  if (report.failures && report.failures.length > 0) {
    failures.style.display = "block";
    failures.textContent = `失败清单:\n${report.failures.join("\n")}`;
  } else {
    failures.style.display = "none";
    failures.textContent = "";
  }

  block.style.display = "block";
}

function hideBatchReport() {
  const block = document.getElementById("batchReport");
  if (block) block.style.display = "none";
}

function renderMessages() {
  const list = document.getElementById("messageList");
  if (!list) return;

  list.innerHTML = messages
    .map(
      (msg, index) => `
      <div class="message-item" data-index="${index}">
        <input type="checkbox" data-index="${index}" ${msg.selected ? "checked" : ""}>
        <div class="message-content">
          <div class="message-meta">
            <span class="message-sender ${msg.isMe ? "me" : ""}">${msg.isMe ? "我" : escapeHtml(contactName)}</span>
            ${msg.timestamp ? `<span class="message-time">${escapeHtml(msg.timestamp)}</span>` : ""}
          </div>
          <div class="message-text ${msg.imageUrl ? "image" : ""} ${msg.videoUrl ? "video" : ""}">
            ${msg.quote ? `<div class="quote-preview">↩ ${escapeHtml(msg.quote.slice(0, 30))}${msg.quote.length > 30 ? "..." : ""}</div>` : ""}
            ${escapeHtml((msg.text || "").slice(0, 120))}${(msg.text || "").length > 120 ? "..." : ""}
          </div>
          <div class="message-product">商品：${escapeHtml(msg.product?.groupName || "未识别商品")}</div>
        </div>
      </div>
      `
    )
    .join("");

  list.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const index = Number(event.target.dataset.index);
      if (messages[index]) {
        messages[index].selected = event.target.checked;
      }
      updateStatus();
      updateSelectAll();
    });
  });
}

function updateStatus() {
  const selected = messages.filter((msg) => msg.selected).length;
  const status = document.getElementById("status");
  const debugMode = !!document.getElementById("debugMode")?.checked;
  if (status) {
    if (!debugMode) {
      status.textContent = `已选择 ${selected} 条`;
      return;
    }
    const selectedRows = messages.filter((msg) => msg.selected);
    const productHit = selectedRows.filter((msg) => String(msg.product?.groupName || "").trim() && msg.product?.groupName !== "未识别商品").length;
    const productFallback = selectedRows.filter((msg) => (msg.product?.groupName || "") === "未识别商品").length;
    status.textContent = `已选择 ${selected} 条 | 商品命中 ${productHit} | 商品回填 ${productFallback} | 滚动容器 ${lastScrollContainerLabel}`;
  }
}

function updateSelectAll() {
  const selectAll = document.getElementById("selectAll");
  if (!selectAll) return;
  selectAll.checked = messages.length > 0 && messages.every((msg) => msg.selected);
}

function buildExportBundle(selectedMessages, metaBase) {
  const dateStr = formatDateForFilename(new Date());

  const safeContact = sanitizeFilenameSegment(metaBase.contactName || metaBase.chatTitle || "unknown");
  const baseName = `${safeContact}_${dateStr}`;

  return {
    baseName,
    json: generateJson(selectedMessages, metaBase.productImageUrl || "")
  };
}

function generateJson(selectedMessages, productImgUrl) {
  const normalized = ensureMessageRequiredFields(selectedMessages || []);
  const product = productImgUrl || "未识别商品";
  const rows = normalized.map((msg, idx) => ({
    id: idx,
    role: msg.isMe ? "me" : "other",
    text: msg.text || ""
  }));
  const output = { product, messages: rows };
  return JSON.stringify(output, null, 2);
}

function getEarliestTimestamp(msgs, fallbackDate) {
  let earliest = null;
  msgs.forEach((msg) => {
    const parsed = parseTimestampText(msg.timestamp, fallbackDate);
    if (!parsed) return;
    if (!earliest || parsed.getTime() < earliest.getTime()) {
      earliest = parsed;
    }
  });
  return earliest || fallbackDate;
}

function parseTimestampText(text, fallbackDate) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  const nowYear = fallbackDate.getFullYear();

  let m = cleaned.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));

  m = cleaned.match(/(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (m) return buildDate(nowYear, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));

  m = cleaned.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    return buildDate(
      fallbackDate.getFullYear(),
      fallbackDate.getMonth() + 1,
      fallbackDate.getDate(),
      Number(m[1]),
      Number(m[2])
    );
  }

  return null;
}

function buildDate(year, month, day, hour, minute) {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDateForFilename(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${hh}-${mm}`;
}

function sanitizeFilenameSegment(value) {
  const raw = String(value || "unknown").trim();
  const safe = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64);
  return safe || "unknown";
}

function normalizeSubfolder(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 120);
  return cleaned || "";
}

function buildDownloadPath(fileName) {
  const folder = normalizeSubfolder(exportSubfolder);
  return folder ? `${folder}/${fileName}` : fileName;
}


function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isNoiseMediaUrl(url) {
  const normalized = String(url || "").trim().toLowerCase();
  if (!normalized) return true;
  if (!/^https?:\/\//.test(normalized)) return true;
  if (normalized.includes("tps-2-2") || normalized.includes("tps-1-1")) return true;
  if (normalized.includes("placeholder") || normalized.includes("default")) return true;
  if (normalized.includes("avatar") || normalized.includes("profile") || normalized.includes("head")) return true;
  return false;
}

function showEmpty(hint) {
  document.getElementById("loading").style.display = "none";
  document.getElementById("content").style.display = "none";
  document.getElementById("empty").style.display = "block";
  const emptyHint = document.getElementById("emptyHint");
  if (emptyHint) emptyHint.textContent = hint || "请在闲鱼聊天页面使用本插件";
}

function showContent() {
  document.getElementById("loading").style.display = "none";
  document.getElementById("empty").style.display = "none";
  document.getElementById("content").style.display = "block";
}

function downloadFile(content, filename, type) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false
      },
      (downloadId) => {
        URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

function extractCurrentConversationInjected() {
  function getText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function isNoiseMedia(urlValue) {
    const x = String(urlValue || "").trim().toLowerCase();
    if (!x || !/^https?:\/\//.test(x)) return true;
    if (x.includes("tps-2-2") || x.includes("tps-1-1")) return true;
    if (x.includes("avatar") || x.includes("profile") || x.includes("head")) return true;
    if (x.includes("placeholder") || x.includes("default")) return true;
    return false;
  }

  function detectChatPane() {
    const preferred = Array.from(
      document.querySelectorAll(
        '[class*="chat-main"], [class*="message-list"], [class*="message-panel"], [class*="chat-content"], [class*="chat-window"], main, section, div'
      )
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width < 300 || (rect.height < 60 && el.scrollHeight < 300)) return false;
        if (rect.left < window.innerWidth * 0.28) return false;
        if (rect.right <= 0 || rect.top >= window.innerHeight) return false;
        const cls = String(el.className || "").toLowerCase();
        if (/(sidebar|sider|header|footer|sendbox|toolbar|input|editor|composer|session-list|conv-list)/.test(cls)) {
          return false;
        }
        return el.querySelectorAll("div,span,p,img,video").length > 20;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "").toLowerCase();
        let score = rect.width * rect.height;
        if (/(chat-main|message-list|message-panel|chat-content|chat-window)/.test(cls)) score += 500000;
        if (rect.left > window.innerWidth * 0.35) score += 120000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    if (preferred[0]?.el) return preferred[0].el;

    const composer =
      document.querySelector('textarea[placeholder*="输入"]') ||
      document.querySelector('input[placeholder*="输入"]') ||
      document.querySelector('div[contenteditable="true"]');
    if (!composer) return null;
    let current = composer;
    for (let i = 0; i < 12 && current; i += 1) {
      if ((current.querySelectorAll("div,span,p,img,video") || []).length > 20) return current;
      current = current.parentElement;
    }
    return composer.parentElement || null;
  }

  function looksLikeSidebarNode(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.left < window.innerWidth * 0.28 && rect.width < window.innerWidth * 0.45;
  }

  function getCandidates(root) {
    const legacy = Array.from(root.querySelectorAll('[class*="ant-list-item"]')).filter((el) => !looksLikeSidebarNode(el));
    if (legacy.length > 1) return { mode: "legacy", nodes: legacy };

    const modern = Array.from(
      root.querySelectorAll(
        '[data-message-id], [class*="message-row"], [class*="message-item"], [class*="msg-item"], [class*="chat-item"], [class*="bubble"]'
      )
    ).filter((el) => !looksLikeSidebarNode(el));
    if (modern.length > 0) return { mode: "modern", nodes: modern };

    const fallback = Array.from(root.querySelectorAll("div,p,span"))
      .filter((el) => el.children.length === 0)
      .filter((el) => {
        const text = getText(el);
        return text.length >= 2 && text.length <= 240;
      })
      .filter((el) => !looksLikeSidebarNode(el))
      .slice(0, 800);

    return { mode: "fallback", nodes: fallback };
  }

  function detectIsMe(el) {
    const cls = String(el.className || "").toLowerCase();
    if (/(mine|self|me|right|owner|send|outgoing)/.test(cls)) return true;
    if (/(left|other|incoming|peer)/.test(cls)) return false;
    const style = String(el.getAttribute("style") || "").toLowerCase();
    if (style.includes("direction: rtl") || style.includes("text-align: right")) return true;
    if (style.includes("text-align: left")) return false;
    const rect = el.getBoundingClientRect?.();
    return !!rect && rect.left > window.innerWidth * 0.5;
  }

  function extractProductInfo(el) {
    const cls = String(el.className || "");
    const isProductCard = /price|product|goods|item-card/.test(cls);
    if (!isProductCard && !el.querySelector('[class*="price"]')) return null;
    const titleEl = el.querySelector('[class*="item-title"], [class*="item-name"], [class*="title"]');
    const text = getText(el);
    const priceMatch = text.match(/[￥¥]\s*\d+(?:\.\d{1,2})?/);
    if (!titleEl && !priceMatch) return null;
    return { groupName: getText(titleEl) || priceMatch?.[0] || "商品信息" };
  }

  function extractTimestamp(node) {
    const ownTime = getText(node.querySelector("time")) || getText(node.querySelector('[class*="time"]'));
    if (ownTime) return ownTime;
    let prev = node.previousElementSibling;
    while (prev) {
      const t = getText(prev.querySelector('[style*="text-align: center"]')) || getText(prev);
      if (/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2})|(\d{1,2}:\d{2})/.test(t)) return t;
      prev = prev.previousElementSibling;
    }
    return "";
  }

  function extractUserId() {
    const url = location.href || "";
    const uid = url.match(/[?&](?:userId|userid|uid|toUserId|to_user_id)=([^&#]+)/i);
    if (uid?.[1]) return decodeURIComponent(uid[1]);
    return "unknown";
  }

  const nameDivs = Array.from(
    document.querySelectorAll('div[style*="font-size: 12px"][style*="rgb(102, 102, 102)"]')
  ).filter(
    (el) => !el.getAttribute("style").includes("align-self") && el.textContent.trim().length > 0
  );
  const chatTitle = nameDivs[0]?.textContent?.trim() || "闲鱼聊天记录";
  const contactName = chatTitle || "聊天对象";
  const contactUserId = extractUserId();

  const pane = detectChatPane();
  const detected = getCandidates(pane || document);
  const nodes = detected.nodes || [];

  const productImgEl = document.querySelector('img[src*="fleamarket"]');
  let productImageUrl = productImgEl ? (productImgEl.getAttribute("src") || "") : "";
  if (productImageUrl.startsWith("//")) productImageUrl = `https:${productImageUrl}`;

  const result = [];
  let currentProduct = null;
  const dedupe = new Set();

  for (const el of nodes) {
    let product = extractProductInfo(el);
    if (!product && el.previousElementSibling) product = extractProductInfo(el.previousElementSibling);
    if (product) currentProduct = product;

    const isMe = detectIsMe(el);
    let text =
      getText(el.querySelector('[class*="message-text"] > span')) ||
      getText(el.querySelector('[class*="message-text"]')) ||
      getText(el.querySelector('[class*="msg-text"]')) ||
      getText(el.querySelector('[class*="content"]')) ||
      getText(el.querySelector('[class*="bubble"]')) ||
      getText(el);

    let imageUrl = "";
    let videoUrl = "";

    const imageEl = el.querySelector(
      '[class*="image-container"] img, .ant-image-img, img[src*="alicdn"], img[src*="goofish"], img'
    );
    if (imageEl) {
      imageUrl = imageEl.getAttribute("src") || imageEl.getAttribute("data-src") || "";
      if (imageUrl.startsWith("//")) imageUrl = `https:${imageUrl}`;
      if (isNoiseMedia(imageUrl)) imageUrl = "";
    }

    const videoEl = el.querySelector("video");
    if (videoEl) {
      videoUrl = videoEl.getAttribute("src") || videoEl.getAttribute("data-src") || "";
      if (videoUrl.startsWith("//")) videoUrl = `https:${videoUrl}`;
      if (isNoiseMedia(videoUrl)) videoUrl = "";
    }

    const quoteEl = el.querySelector('[class*="reply-container"], [class*="quote"], [class*="reply"]');
    const quoteText = quoteEl ? getText(quoteEl) : "";

    if (!text && imageUrl) text = "[图片]";
    if (!text && videoUrl) text = "[视频]";
    if (!text && quoteText) text = quoteText;

    if (!text && !imageUrl && !videoUrl) continue;

    const timestamp = extractTimestamp(el);
    const dedupeKey = `${isMe ? "me" : "other"}|${timestamp}|${text}|${imageUrl}|${videoUrl}`;
    if (dedupe.has(dedupeKey)) continue;
    dedupe.add(dedupeKey);

    result.push({
      id: result.length,
      isMe,
      text: text || "",
      imageUrl: imageUrl || "",
      videoUrl: videoUrl || "",
      quote: quoteText || "",
      timestamp,
      product: currentProduct || null,
      selected: true
    });
  }

  return {
    chatTitle,
    contactName,
    contactUserId,
    productImageUrl,
    hasChatPane: !!pane,
    extract_mode: detected.mode || "fallback",
    extracted_product: currentProduct?.groupName || "",
    detected_nodes: nodes.length,
    messages: result
  };
}

function autoScrollCurrentConversationStepInjected(stepPx, waitMs, routeSeed) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function countMessages(root) {
    const target = root || document;
    return target.querySelectorAll(
      '[class*="message"], [class*="msg"], [class*="bubble"], [class*="ant-list-item"], [data-message-id], video, img'
    ).length;
  }

  function shortClassName(el) {
    if (!el) return "unknown";
    const raw = String(el.className || "").trim();
    if (!raw) return el.tagName?.toLowerCase?.() || "unknown";
    return raw.split(/\s+/).slice(0, 2).join(".").slice(0, 48);
  }

  function isVisible(node) {
    if (!node) return false;
    const rect = node.getBoundingClientRect?.();
    if (!rect) return false;
    if (rect.width < 24 || rect.height < 24) return false;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
    if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
    const style = window.getComputedStyle?.(node);
    return !!style && style.display !== "none" && style.visibility !== "hidden";
  }

  function canScroll(node) {
    if (!node) return false;
    if (node.clientHeight > 40 && node.scrollHeight > node.clientHeight + 20) return true;
    try {
      const style = window.getComputedStyle(node);
      if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > 200) return true;
    } catch (e) {}
    return false;
  }

  function getPath(node) {
    const path = [];
    let cursor = node;
    while (cursor && cursor !== document.body) {
      const parent = cursor.parentElement;
      if (!parent) break;
      path.unshift(Array.prototype.indexOf.call(parent.children, cursor));
      cursor = parent;
    }
    return path;
  }

  function resolvePath(path) {
    let cursor = document.body;
    for (const index of path || []) {
      cursor = cursor?.children?.[index];
      if (!cursor) return null;
    }
    return cursor;
  }

  function collectChain(node) {
    const chain = [];
    let cursor = node;
    for (let i = 0; i < 8 && cursor; i += 1) {
      chain.push(cursor);
      if (cursor === document.body) break;
      cursor = cursor.parentElement;
    }
    return chain.filter(isVisible);
  }

  function snapshot(nodes) {
    return (nodes || []).map((node) => Number(node?.scrollTop || 0));
  }

  function scrollChanged(before, nodes) {
    return (nodes || []).some((node, index) => Number(node?.scrollTop || 0) !== Number(before[index] || 0));
  }

  function describeChain(nodes) {
    return (nodes || []).map((node) => ({
      label: shortClassName(node),
      scrollTop: Number(node?.scrollTop || 0),
      scrollHeight: Number(node?.scrollHeight || 0),
      clientHeight: Number(node?.clientHeight || 0)
    }));
  }

  function captureVisibleSignature() {
    const visibleNodes = Array.from(
      document.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [data-message-id]')
    )
      .filter((node) => {
        const rect = node.getBoundingClientRect?.();
        return !!rect && rect.width > 24 && rect.height > 18 && rect.left > window.innerWidth * 0.35;
      })
      .slice(0, 8);
    return visibleNodes
      .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36))
      .join("|");
  }

  function detectChatPane() {
    const preferred = Array.from(
      document.querySelectorAll(
        '[class*="chat-main"], [class*="message-list"], [class*="message-panel"], [class*="chat-content"], [class*="chat-window"], main, section, div'
      )
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width < 300 || (rect.height < 60 && el.scrollHeight < 300)) return false;
        if (rect.left < window.innerWidth * 0.28) return false;
        if (rect.right <= 0 || rect.top >= window.innerHeight) return false;
        const cls = String(el.className || "").toLowerCase();
        if (/(sidebar|sider|header|footer|sendbox|toolbar|input|editor|composer|session-list|conv-list)/.test(cls)) return false;
        return el.querySelectorAll('div,span,p,img,video').length > 20;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "").toLowerCase();
        let score = rect.width * rect.height;
        if (/(chat-main|message-list|message-panel|chat-content|chat-window)/.test(cls)) score += 500000;
        if (rect.left > window.innerWidth * 0.35) score += 120000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    if (preferred[0]?.el) return preferred[0].el;
    return null;
  }

  function locateHit() {
    const pane = detectChatPane();
    const paneRect = pane?.getBoundingClientRect?.() || null;
    if (paneRect) {
      const samplePoints = [
        [0.52, 0.24],
        [0.52, 0.4],
        [0.52, 0.56],
        [0.7, 0.36]
      ];
      for (const [rx, ry] of samplePoints) {
        const x = Math.round(paneRect.left + Math.max(60, paneRect.width * rx));
        const y = Math.round(paneRect.top + Math.max(40, Math.min(paneRect.height * ry, paneRect.height - 40)));
        const hit = document.elementFromPoint(x, y);
        if (hit && isVisible(hit)) return hit;
      }
    }

    return Array.from(document.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [data-message-id]')).find(
      (node) => {
        const rect = node.getBoundingClientRect?.();
        return rect && rect.width > 24 && rect.height > 18 && rect.left > window.innerWidth * 0.35;
      }
    );
  }

  function fireWheel(node, delta) {
    node?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: delta }));
  }

  function firePageUp(node) {
    try {
      node?.focus?.({ preventScroll: true });
    } catch (error) {
      void error;
    }
    node?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageUp", code: "PageUp" }));
  }

  function firePageDown(node) {
    try {
      node?.focus?.({ preventScroll: true });
    } catch (error) {
      void error;
    }
    node?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageDown", code: "PageDown" }));
  }

  function isReverseLayout(node) {
    if (!node) return false;
    try {
      const style = window.getComputedStyle(node);
      return style.flexDirection === "column-reverse" || style.flexDirection === "row-reverse";
    } catch (e) {
      return false;
    }
  }

  function ensureScrollableHeight(node) {
    if (!node || node.clientHeight > 0) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (!node.dataset._origMinHeight) {
      node.dataset._origMinHeight = node.style.minHeight || "";
    }
    node.style.minHeight = parent.clientHeight + "px";
  }

  async function detectRoute(step) {
    const hitNode = locateHit();
    if (!hitNode) {
      return {
        ok: false,
        reason: "content_hit_missing",
        contentHit: "-",
        scrollChain: [],
        activeScrollMode: "-",
        activeScrollNode: "-"
      };
    }

    const chainNodes = collectChain(hitNode);
    const chainDesc = describeChain(chainNodes);

    for (const node of chainNodes) {
      const beforeCount = countMessages(document);
      const beforeSig = captureVisibleSignature();
      const reversed = isReverseLayout(node);
      if (canScroll(node)) {
        ensureScrollableHeight(node);
        const beforeTop = Number(node.scrollTop || 0);
        if (reversed) {
          node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, beforeTop + step);
        } else {
          node.scrollTop = Math.max(0, beforeTop - step);
        }
        await sleep(80);
        const afterSig = captureVisibleSignature();
        if (Number(node.scrollTop || 0) !== beforeTop || countMessages(document) > beforeCount || afterSig !== beforeSig) {
          return {
            ok: true,
            reason: "route_locked",
            contentHit: shortClassName(hitNode),
            scrollChain: chainDesc,
            activeScrollMode: "scrollTop",
            activeScrollNode: shortClassName(node),
            route: {
              contentHit: shortClassName(hitNode),
              scrollChain: chainDesc,
              activeScrollMode: "scrollTop",
              activeScrollNode: shortClassName(node),
              activeNodePath: getPath(node),
              watchNodePaths: chainNodes.map(getPath),
              scrollDirection: reversed ? "down" : "up"
            }
          };
        }
      }

      const wheelBefore = snapshot(chainNodes);
      const wheelCount = countMessages(document);
      const wheelSigBefore = captureVisibleSignature();
      fireWheel(node, reversed ? step : -step);
      await sleep(80);
      const wheelSigAfter = captureVisibleSignature();
      if (scrollChanged(wheelBefore, chainNodes) || countMessages(document) > wheelCount || wheelSigAfter !== wheelSigBefore) {
        return {
          ok: true,
          reason: "route_locked",
          contentHit: shortClassName(hitNode),
          scrollChain: chainDesc,
          activeScrollMode: "wheel",
          activeScrollNode: shortClassName(node),
          route: {
            contentHit: shortClassName(hitNode),
            scrollChain: chainDesc,
            activeScrollMode: "wheel",
            activeScrollNode: shortClassName(node),
            activeNodePath: getPath(node),
            watchNodePaths: chainNodes.map(getPath),
            scrollDirection: reversed ? "down" : "up"
          }
        };
      }

      const pageBefore = snapshot(chainNodes);
      const pageCount = countMessages(document);
      const pageSigBefore = captureVisibleSignature();
      if (reversed) {
        firePageDown(node);
      } else {
        firePageUp(node);
      }
      await sleep(80);
      const pageSigAfter = captureVisibleSignature();
      if (scrollChanged(pageBefore, chainNodes) || countMessages(document) > pageCount || pageSigAfter !== pageSigBefore) {
        return {
          ok: true,
          reason: "route_locked",
          contentHit: shortClassName(hitNode),
          scrollChain: chainDesc,
          activeScrollMode: reversed ? "pagedown" : "pageup",
          activeScrollNode: shortClassName(node),
          route: {
            contentHit: shortClassName(hitNode),
            scrollChain: chainDesc,
            activeScrollMode: reversed ? "pagedown" : "pageup",
            activeScrollNode: shortClassName(node),
            activeNodePath: getPath(node),
            watchNodePaths: chainNodes.map(getPath),
            scrollDirection: reversed ? "down" : "up"
          }
        };
      }
    }

    return {
      ok: false,
      reason: "no_scroll_route",
      contentHit: shortClassName(hitNode),
      scrollChain: chainDesc,
      activeScrollMode: "-",
      activeScrollNode: "-"
    };
  }

  async function runRoute(route, step) {
    const activeNode = resolvePath(route?.activeNodePath || []);
    const watchNodes = (route?.watchNodePaths || []).map(resolvePath).filter(Boolean);
    const targets = watchNodes.length > 0 ? watchNodes : activeNode ? collectChain(activeNode) : [];
    if (!activeNode) {
      return {
        ok: false,
        reason: "active_node_missing",
        contentHit: route?.contentHit || "-",
        scrollChain: route?.scrollChain || [],
        activeScrollMode: route?.activeScrollMode || "-",
        activeScrollNode: route?.activeScrollNode || "-"
      };
    }

    ensureScrollableHeight(activeNode);
    const beforeTop = Number(activeNode.scrollTop || 0);
    const beforeCount = countMessages(document);
    const beforeSnapshot = snapshot(targets);
    const beforeSig = captureVisibleSignature();
    const dir = route.scrollDirection || "up";

    if (route.activeScrollMode === "scrollTop") {
      if (dir === "down") {
        activeNode.scrollTop = Math.min(activeNode.scrollHeight - activeNode.clientHeight, beforeTop + step);
      } else {
        activeNode.scrollTop = Math.max(0, beforeTop - step);
      }
    } else if (route.activeScrollMode === "wheel") {
      fireWheel(activeNode, dir === "down" ? step : -step);
    } else {
      if (dir === "down") {
        firePageDown(activeNode);
      } else {
        firePageUp(activeNode);
      }
    }

    await sleep(Math.max(220, Number(waitMs || 650)));

    const afterTop = Number(activeNode.scrollTop || 0);
    const afterCount = countMessages(document);
    const delta = dir === "down" ? Math.max(0, afterTop - beforeTop) : Math.max(0, beforeTop - afterTop);
    const afterSig = captureVisibleSignature();
    const moved = delta > 0 || scrollChanged(beforeSnapshot, targets) || afterCount > beforeCount || afterSig !== beforeSig;

    return {
      ok: true,
      moved,
      delta,
      top: afterTop,
      detectedCount: afterCount,
      containerLabel: route.activeScrollNode || "unknown",
      contentHit: route.contentHit || "-",
      scrollChain: route.scrollChain || [],
      activeScrollMode: route.activeScrollMode || "-",
      activeScrollNode: route.activeScrollNode || "-",
      route,
      reason: moved ? "route_locked" : "route_no_growth"
    };
  }

  return (async () => {
    const effectiveStep = Math.max(120, Number(stepPx || 320));
    const routeInfo = routeSeed?.activeNodePath
      ? { ok: true, route: routeSeed }
      : await detectRoute(Math.max(90, Math.floor(effectiveStep * 0.5)));
    if (!routeInfo?.ok || !routeInfo.route) return routeInfo;
    return runRoute(routeInfo.route, effectiveStep);
  })();
}
function processConversationInjected(entry, stagnantTarget, maxMs, waitMs) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function getText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() || "";
  }
  function isNoiseMedia(urlValue) {
    const x = String(urlValue || "").trim().toLowerCase();
    if (!x || !/^https?:\/\//.test(x)) return true;
    if (x.includes("tps-2-2") || x.includes("tps-1-1")) return true;
    if (x.includes("avatar") || x.includes("profile") || x.includes("head")) return true;
    if (x.includes("placeholder") || x.includes("default")) return true;
    return false;
  }
  function detectSidebar() {
    const candidates = Array.from(document.querySelectorAll("div,aside,section"))
      .filter((el) => el.scrollHeight > el.clientHeight + 30)
      .filter((el) => {
        const r = el.getBoundingClientRect?.();
        if (!r) return false;
        return r.left < window.innerWidth * 0.4 && r.width < window.innerWidth * 0.45;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || null;
  }
  function getConversationElements(sidebar) {
    return Array.from(sidebar.querySelectorAll("div,li,a")).filter((el) => {
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 100) return false;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.height < 24) return false;
      const cls = String(el.className || "").toLowerCase();
      if (/(message|session|conversation|chat|item|list)/.test(cls)) return true;
      return !!el.querySelector("img");
    });
  }
  function keyOfConversation(el) {
    const txt = getText(el).slice(0, 60);
    const dataId =
      el.getAttribute("data-id") ||
      el.getAttribute("data-key") ||
      el.getAttribute("data-conversation-id") ||
      "";
    return `${dataId}__${txt}`.trim();
  }
  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  function detectChatPane() {
    const preferred = Array.from(
      document.querySelectorAll(
        '[class*="chat-main"], [class*="message-list"], [class*="message-panel"], [class*="chat-content"], [class*="chat-window"], main, section, div'
      )
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width < 300 || (rect.height < 60 && el.scrollHeight < 300)) return false;
        if (rect.left < window.innerWidth * 0.28) return false;
        if (rect.right <= 0 || rect.top >= window.innerHeight) return false;
        const cls = String(el.className || "").toLowerCase();
        if (/(sidebar|sider|header|footer|sendbox|toolbar|input|editor|composer|session-list|conv-list)/.test(cls)) {
          return false;
        }
        return el.querySelectorAll("div,span,p,img,video").length > 20;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "").toLowerCase();
        let score = rect.width * rect.height;
        if (/(chat-main|message-list|message-panel|chat-content|chat-window)/.test(cls)) score += 500000;
        if (rect.left > window.innerWidth * 0.35) score += 120000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    if (preferred[0]?.el) return preferred[0].el;

    const composer =
      document.querySelector('textarea[placeholder*="输入"]') ||
      document.querySelector('input[placeholder*="输入"]') ||
      document.querySelector('div[contenteditable="true"]');
    if (!composer) return null;
    let current = composer;
    for (let i = 0; i < 12 && current; i += 1) {
      if ((current.querySelectorAll("div,span,p,img,video") || []).length > 20) return current;
      current = current.parentElement;
    }
    return composer.parentElement || null;
  }
  function looksLikeSidebarNode(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.left < window.innerWidth * 0.28 && rect.width < window.innerWidth * 0.45;
  }
  function getMessageCandidates(root) {
    const legacy = Array.from(root.querySelectorAll('[class*="ant-list-item"]')).filter((el) => !looksLikeSidebarNode(el));
    if (legacy.length > 1) return { mode: "legacy", nodes: legacy };
    const modern = Array.from(
      root.querySelectorAll(
        '[data-message-id], [class*="message-row"], [class*="message-item"], [class*="msg-item"], [class*="chat-item"], [class*="bubble"]'
      )
    ).filter((el) => !looksLikeSidebarNode(el));
    if (modern.length > 0) return { mode: "modern", nodes: modern };
    const fallback = Array.from(root.querySelectorAll("div,p,span"))
      .filter((el) => el.children.length === 0)
      .filter((el) => {
        const text = getText(el);
        return text.length >= 2 && text.length <= 240;
      })
      .filter((el) => !looksLikeSidebarNode(el))
      .slice(0, 800);
    return { mode: "fallback", nodes: fallback };
  }
  function detectIsMe(el) {
    const cls = String(el.className || "").toLowerCase();
    if (/(mine|self|me|right|owner|send|outgoing)/.test(cls)) return true;
    if (/(left|other|incoming|peer)/.test(cls)) return false;
    const style = String(el.getAttribute("style") || "").toLowerCase();
    if (style.includes("direction: rtl") || style.includes("text-align: right")) return true;
    if (style.includes("text-align: left")) return false;
    const rect = el.getBoundingClientRect?.();
    return !!rect && rect.left > window.innerWidth * 0.5;
  }
  function extractProductInfo(rootEl) {
    const titleEl =
      rootEl.querySelector('[class*="item-title"]') ||
      rootEl.querySelector('[class*="item-name"]') ||
      rootEl.querySelector('[class*="title"]');
    const textContent = rootEl.textContent || "";
    const matchedPrice = textContent.match(/[￥¥]\s*\d+(?:\.\d{1,2})?/);
    if (!titleEl && !matchedPrice) return null;
    return { groupName: getText(titleEl) || "未识别商品" };
  }
  function extractTimestamp(node) {
    const ownTime = getText(node.querySelector("time")) || getText(node.querySelector('[class*="time"]'));
    if (ownTime) return ownTime;
    let prev = node.previousElementSibling;
    while (prev) {
      const t = getText(prev.querySelector('[style*="text-align: center"]')) || getText(prev);
      if (/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2})|(\d{1,2}:\d{2})/.test(t)) return t;
      prev = prev.previousElementSibling;
    }
    const text = getText(node);
    const m = text.match(/(\d{1,2}:\d{2})/);
    return m?.[1] || "";
  }
  function extractUserId() {
    const url = location.href || "";
    const uid = url.match(/[?&](?:userId|userid|uid|toUserId|to_user_id)=([^&#]+)/i);
    if (uid?.[1]) return decodeURIComponent(uid[1]);
    return "unknown";
  }
  async function autoScrollMessagesToTop() {
    function batchCountMessages(root) {
      const target = root || document;
      return target.querySelectorAll(
        '[class*="message"], [class*="msg"], [class*="bubble"], [class*="ant-list-item"], [data-message-id], img, video'
      ).length;
    }

    function batchShortLabel(node) {
      if (!node) return "unknown";
      const cls = String(node.className || "").trim();
      return cls ? cls.split(/\s+/).slice(0, 2).join(".").slice(0, 48) : (node.tagName || "unknown").toLowerCase();
    }

    function batchGetPath(node) {
      const path = [];
      let cursor = node;
      while (cursor && cursor !== document.body) {
        const parent = cursor.parentElement;
        if (!parent) break;
        path.unshift(Array.prototype.indexOf.call(parent.children, cursor));
        cursor = parent;
      }
      return path;
    }

    function batchResolvePath(path) {
      let cursor = document.body;
      for (const index of path || []) {
        cursor = cursor?.children?.[index];
        if (!cursor) return null;
      }
      return cursor;
    }

    function batchCollectChain(node) {
      const chain = [];
      let cursor = node;
      for (let i = 0; i < 8 && cursor; i += 1) {
        chain.push(cursor);
        if (cursor === document.body) break;
        cursor = cursor.parentElement;
      }
      return chain.filter(batchVisible);
    }

    function batchVisible(node) {
      if (!node) return false;
      const rect = node.getBoundingClientRect?.();
      if (!rect) return false;
      if (rect.width < 24 || rect.height < 24) return false;
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
      if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
      const style = window.getComputedStyle?.(node);
      return !!style && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function batchCanScroll(node) {
      if (!node) return false;
      if (node.clientHeight > 40 && node.scrollHeight > node.clientHeight + 20) return true;
      try {
        const style = window.getComputedStyle(node);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && node.scrollHeight > 200) return true;
      } catch (e) {}
      return false;
    }

    function batchSnapshot(nodes) {
      return (nodes || []).map((node) => Number(node?.scrollTop || 0));
    }

    function batchScrollChanged(before, nodes) {
      return (nodes || []).some((node, index) => Number(node?.scrollTop || 0) !== Number(before[index] || 0));
    }

    function batchDescribe(nodes) {
      return (nodes || []).map((node) => ({
        label: batchShortLabel(node),
        scrollTop: Number(node?.scrollTop || 0),
        scrollHeight: Number(node?.scrollHeight || 0),
        clientHeight: Number(node?.clientHeight || 0)
      }));
    }

    function batchCaptureVisibleSignature() {
      const visibleNodes = Array.from(
        document.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [data-message-id]')
      )
        .filter((node) => {
          const rect = node.getBoundingClientRect?.();
          return !!rect && rect.width > 24 && rect.height > 18 && rect.left > window.innerWidth * 0.35;
        })
        .slice(0, 8);
      return visibleNodes
        .map((node) => String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 36))
        .join("|");
    }

    function batchLocateHit() {
      const pane = detectChatPane();
      const paneRect = pane?.getBoundingClientRect?.() || null;
      if (paneRect) {
        const samplePoints = [
          [0.52, 0.24],
          [0.52, 0.4],
          [0.52, 0.56],
          [0.7, 0.36]
        ];
        for (const [rx, ry] of samplePoints) {
          const x = Math.round(paneRect.left + Math.max(60, paneRect.width * rx));
          const y = Math.round(paneRect.top + Math.max(40, Math.min(paneRect.height * ry, paneRect.height - 40)));
          const hit = document.elementFromPoint(x, y);
          if (hit && batchVisible(hit)) return hit;
        }
      }

      return Array.from(document.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [data-message-id]')).find(
        (node) => {
          const rect = node.getBoundingClientRect?.();
          return rect && rect.width > 24 && rect.height > 18 && rect.left > window.innerWidth * 0.35;
        }
      );
    }

    function batchWheel(node, delta) {
      node?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: delta }));
    }

    function batchPageUp(node) {
      try {
        node?.focus?.({ preventScroll: true });
      } catch (error) {
        void error;
      }
      node?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageUp', code: 'PageUp' }));
    }

    function batchPageDown(node) {
      try {
        node?.focus?.({ preventScroll: true });
      } catch (error) {
        void error;
      }
      node?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown', code: 'PageDown' }));
    }

    function batchIsReverseLayout(node) {
      if (!node) return false;
      try {
        const style = window.getComputedStyle(node);
        return style.flexDirection === 'column-reverse' || style.flexDirection === 'row-reverse';
      } catch (e) {
        return false;
      }
    }

    function batchEnsureScrollableHeight(node) {
      if (!node || node.clientHeight > 0) return;
      const parent = node.parentElement;
      if (!parent) return;
      if (!node.dataset._origMinHeight) {
        node.dataset._origMinHeight = node.style.minHeight || '';
      }
      node.style.minHeight = parent.clientHeight + 'px';
    }

    async function batchDetectRoute(step) {
      const hitNode = batchLocateHit();
      if (!hitNode) {
        return {
          ok: false,
          reason: 'content_hit_missing',
          contentHit: '-',
          scrollChain: [],
          activeScrollMode: '-',
          activeScrollNode: '-'
        };
      }

      const chainNodes = batchCollectChain(hitNode);
      const chainDesc = batchDescribe(chainNodes);

      for (const node of chainNodes) {
        const beforeCount = batchCountMessages(document);
        const beforeSig = batchCaptureVisibleSignature();
        const reversed = batchIsReverseLayout(node);
        if (batchCanScroll(node)) {
          batchEnsureScrollableHeight(node);
          const beforeTop = Number(node.scrollTop || 0);
          if (reversed) {
            node.scrollTop = Math.min(node.scrollHeight - node.clientHeight, beforeTop + step);
          } else {
            node.scrollTop = Math.max(0, beforeTop - step);
          }
          await sleep(80);
          const afterSig = batchCaptureVisibleSignature();
          if (Number(node.scrollTop || 0) !== beforeTop || batchCountMessages(document) > beforeCount || afterSig !== beforeSig) {
            return {
              ok: true,
              reason: 'route_locked',
              contentHit: batchShortLabel(hitNode),
              scrollChain: chainDesc,
              activeScrollMode: 'scrollTop',
              activeScrollNode: batchShortLabel(node),
              route: {
                contentHit: batchShortLabel(hitNode),
                scrollChain: chainDesc,
                activeScrollMode: 'scrollTop',
                activeScrollNode: batchShortLabel(node),
                activeNodePath: batchGetPath(node),
                watchNodePaths: chainNodes.map(batchGetPath),
                scrollDirection: reversed ? 'down' : 'up'
              }
            };
          }
        }

        const wheelBefore = batchSnapshot(chainNodes);
        const wheelCount = batchCountMessages(document);
        const wheelSigBefore = batchCaptureVisibleSignature();
        batchWheel(node, reversed ? step : -step);
        await sleep(80);
        const wheelSigAfter = batchCaptureVisibleSignature();
        if (batchScrollChanged(wheelBefore, chainNodes) || batchCountMessages(document) > wheelCount || wheelSigAfter !== wheelSigBefore) {
          return {
            ok: true,
            reason: 'route_locked',
            contentHit: batchShortLabel(hitNode),
            scrollChain: chainDesc,
            activeScrollMode: 'wheel',
            activeScrollNode: batchShortLabel(node),
            route: {
              contentHit: batchShortLabel(hitNode),
              scrollChain: chainDesc,
              activeScrollMode: 'wheel',
              activeScrollNode: batchShortLabel(node),
              activeNodePath: batchGetPath(node),
              watchNodePaths: chainNodes.map(batchGetPath),
              scrollDirection: reversed ? 'down' : 'up'
            }
          };
        }

        const pageBefore = batchSnapshot(chainNodes);
        const pageCount = batchCountMessages(document);
        const pageSigBefore = batchCaptureVisibleSignature();
        if (reversed) {
          batchPageDown(node);
        } else {
          batchPageUp(node);
        }
        await sleep(80);
        const pageSigAfter = batchCaptureVisibleSignature();
        if (batchScrollChanged(pageBefore, chainNodes) || batchCountMessages(document) > pageCount || pageSigAfter !== pageSigBefore) {
          return {
            ok: true,
            reason: 'route_locked',
            contentHit: batchShortLabel(hitNode),
            scrollChain: chainDesc,
            activeScrollMode: reversed ? 'pagedown' : 'pageup',
            activeScrollNode: batchShortLabel(node),
            route: {
              contentHit: batchShortLabel(hitNode),
              scrollChain: chainDesc,
              activeScrollMode: reversed ? 'pagedown' : 'pageup',
              activeScrollNode: batchShortLabel(node),
              activeNodePath: batchGetPath(node),
              watchNodePaths: chainNodes.map(batchGetPath),
              scrollDirection: reversed ? 'down' : 'up'
            }
          };
        }
      }

      return {
        ok: false,
        reason: 'no_scroll_route',
        contentHit: batchShortLabel(hitNode),
        scrollChain: chainDesc,
        activeScrollMode: '-',
        activeScrollNode: '-'
      };
    }

    async function batchRunRoute(route, step) {
      const activeNode = batchResolvePath(route?.activeNodePath || []);
      const watchNodes = (route?.watchNodePaths || []).map(batchResolvePath).filter(Boolean);
      const targets = watchNodes.length > 0 ? watchNodes : activeNode ? batchCollectChain(activeNode) : [];
      if (!activeNode) {
        return {
          ok: false,
          reason: 'active_node_missing',
          contentHit: route?.contentHit || '-',
          scrollChain: route?.scrollChain || [],
          activeScrollMode: route?.activeScrollMode || '-',
          activeScrollNode: route?.activeScrollNode || '-'
        };
      }

      batchEnsureScrollableHeight(activeNode);
      const beforeTop = Number(activeNode.scrollTop || 0);
      const beforeCount = batchCountMessages(document);
      const beforeSnapshot = batchSnapshot(targets);
      const beforeSig = batchCaptureVisibleSignature();
      const dir = route.scrollDirection || 'up';

      if (route.activeScrollMode === 'scrollTop') {
        if (dir === 'down') {
          activeNode.scrollTop = Math.min(activeNode.scrollHeight - activeNode.clientHeight, beforeTop + step);
        } else {
          activeNode.scrollTop = Math.max(0, beforeTop - step);
        }
      } else if (route.activeScrollMode === 'wheel') {
        batchWheel(activeNode, dir === 'down' ? step : -step);
      } else {
        if (dir === 'down') {
          batchPageDown(activeNode);
        } else {
          batchPageUp(activeNode);
        }
      }

      await sleep(Math.max(220, Number(waitMs || 650)));

      const afterTop = Number(activeNode.scrollTop || 0);
      const afterCount = batchCountMessages(document);
      const delta = dir === 'down' ? Math.max(0, afterTop - beforeTop) : Math.max(0, beforeTop - afterTop);
      const afterSig = batchCaptureVisibleSignature();
      const moved = delta > 0 || batchScrollChanged(beforeSnapshot, targets) || afterCount > beforeCount || afterSig !== beforeSig;

      return {
        ok: true,
        moved,
        delta,
        top: afterTop,
        detectedCount: afterCount,
        containerLabel: route.activeScrollNode || 'unknown',
        contentHit: route.contentHit || '-',
        scrollChain: route.scrollChain || [],
        activeScrollMode: route.activeScrollMode || '-',
        activeScrollNode: route.activeScrollNode || '-',
        route,
        reason: moved ? 'route_locked' : 'route_no_growth'
      };
    }

    const start = Date.now();
    let loops = 0;
    let stagnant = 0;
    let lastCount = 0;

    // Simple scroll: find message-list, force height, scroll
    var ml = document.querySelector('[class*="message-list"]');
    if (ml) {
      if (ml.clientHeight === 0) {
        var parent = ml.parentElement;
        ml.style.minHeight = (parent ? parent.clientHeight : 400) + 'px';
        void ml.offsetHeight;
      }
      var bstyle = window.getComputedStyle(ml);
      var bisReverse = bstyle.flexDirection === 'column-reverse' || bstyle.flexDirection === 'row-reverse';

      var savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';

      while (Date.now() - start < maxMs) {
        loops++;
        var beforeST = ml.scrollTop;
        var beforeSH = ml.scrollHeight;

        if (bisReverse) {
          ml.scrollTop = -ml.scrollHeight;
        } else {
          ml.scrollTop = 0;
        }
        await sleep(waitMs);

        var afterST = ml.scrollTop;
        var afterSH = ml.scrollHeight;
        var count = document.querySelectorAll('[class*="message"],[class*="msg"],[class*="bubble"],[class*="ant-list-item"],[data-message-id]').length;

        var stChanged = afterST !== beforeST;
        var shChanged = afterSH !== beforeSH;
        var cntChanged = count > lastCount;

        if (!stChanged && !shChanged && !cntChanged) stagnant++;
        else stagnant = 0;
        lastCount = count;

        if (stagnant >= (stagnantTarget || 4)) break;
      }

      document.body.style.overflow = savedBodyOverflow;
    }

    return {
      ok: true,
      loops,
      effectiveRounds: loops,
      stagnantRounds: stagnant,
      detectedCount: lastCount,
      top: ml ? ml.scrollTop : 0,
      delta: 0,
      durationMs: Date.now() - start,
      containerLabel: ml ? 'simple-scroll' : 'none',
      contentHit: 'simple-mode',
      scrollChain: [],
      activeScrollMode: 'simple',
      activeScrollNode: 'simple',
      route: null,
      reason: 'simple_scroll'
    };
  }
  function extractCurrentConversationLocal() {
    const result = [];
    let currentProduct = "";
    let currentTime = "";
    const chatTitle =
      getText(document.querySelector('[class*="nickname"]')) ||
      getText(document.querySelector('[class*="user-name"]')) ||
      getText(document.querySelector('[class*="chat-title"]')) ||
      "闲鱼聊天记录";
    const contactName = chatTitle || "聊天对象";
    const contactUserId = extractUserId();
    const pane = detectChatPane();
    const detected = getMessageCandidates(pane || document);
    const nodes = detected.nodes || [];
    const dedupe = new Set();

    for (const el of nodes) {
      let product = extractProductInfo(el);
      if (!product && el.previousElementSibling) product = extractProductInfo(el.previousElementSibling);
      if (product?.groupName) currentProduct = product.groupName;
      const isMe = detectIsMe(el);
      let text =
        getText(el.querySelector('[class*="message-text"] > span')) ||
        getText(el.querySelector('[class*="message-text"]')) ||
        getText(el.querySelector('[class*="msg-text"]')) ||
        getText(el.querySelector('[class*="content"]')) ||
        getText(el.querySelector('[class*="bubble"]')) ||
        getText(el);
      let imageUrl = "";
      let videoUrl = "";
      const imageEl = el.querySelector(
        '[class*="image-container"] img, .ant-image-img, img[src*="alicdn"], img[src*="goofish"], img'
      );
      if (imageEl) {
        imageUrl = imageEl.getAttribute("src") || imageEl.getAttribute("data-src") || "";
        if (imageUrl.startsWith("//")) imageUrl = `https:${imageUrl}`;
        if (isNoiseMedia(imageUrl)) imageUrl = "";
      }
      const videoEl = el.querySelector("video");
      if (videoEl) {
        videoUrl = videoEl.getAttribute("src") || videoEl.getAttribute("data-src") || "";
        if (videoUrl.startsWith("//")) videoUrl = `https:${videoUrl}`;
        if (isNoiseMedia(videoUrl)) videoUrl = "";
      }
      if (!text && imageUrl) text = "[图片]";
      if (!text && videoUrl) text = "[视频]";
      if (!text && !imageUrl && !videoUrl) continue;

      const t = extractTimestamp(el);
      if (t) currentTime = t;
      const safeTime = t || currentTime || "未知时间";
      const safeProduct = currentProduct || "未识别商品";
      const dedupeKey = `${isMe ? "me" : "other"}|${safeTime}|${text}|${imageUrl}|${videoUrl}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);
      result.push({
        id: result.length,
        isMe,
        text: text || "",
        imageUrl: imageUrl || "",
        videoUrl: videoUrl || "",
        quote: "",
        timestamp: safeTime,
        product: { groupName: safeProduct },
        selected: true
      });
    }

    return {
      chatTitle,
      contactName,
      contactUserId,
      extract_mode: detected.mode || "fallback",
      detected_nodes: nodes.length,
      messages: result
    };
  }

  return (async () => {
    try {
      const sidebar = detectSidebar();
      if (!sidebar) return { ok: false, stage: "打开", reason: "未找到左侧会话列表" };
      sidebar.scrollTop = Math.max(0, Number(entry?.firstSeenTop || 0) - 40);
      await sleep(220);
      const candidates = getConversationElements(sidebar);
      const target =
        candidates.find((el) => keyOfConversation(el) === entry?.key) ||
        candidates.find((el) => getText(el).slice(0, 30) === String(entry?.name || "").slice(0, 30));
      if (!target) return { ok: false, stage: "打开", reason: "会话节点未找到" };

      clickElement(target);
      await sleep(400);
      const scrollStat = await autoScrollMessagesToTop();
      if (!scrollStat.ok) return { ok: false, stage: "翻取", reason: scrollStat.reason || "翻取失败" };

      const convo = extractCurrentConversationLocal();
      if (!Array.isArray(convo.messages) || convo.messages.length === 0) {
        return { ok: false, stage: "提取", reason: `消息为空（模式:${convo.extract_mode || "unknown"} 节点:${convo.detected_nodes || 0}）`, scrollStat };
      }

      return { ok: true, data: convo, scrollStat };
    } catch (error) {
      return { ok: false, stage: "提取", reason: error?.message || "未知错误" };
    }
  })();
}

function discoverBatchConversationsInjected(stagnantTarget) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function detectSidebar() {
    const candidates = Array.from(document.querySelectorAll("div,aside,section"))
      .filter((el) => el.scrollHeight > el.clientHeight + 30)
      .filter((el) => {
        const r = el.getBoundingClientRect?.();
        if (!r) return false;
        return r.left < window.innerWidth * 0.4 && r.width < window.innerWidth * 0.45;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || null;
  }

  function getConversationElements(sidebar) {
    return Array.from(sidebar.querySelectorAll("div,li,a")).filter((el) => {
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 100) return false;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.height < 24) return false;
      const cls = String(el.className || "").toLowerCase();
      if (/(message|session|conversation|chat|item|list)/.test(cls)) return true;
      return !!el.querySelector("img");
    });
  }

  function keyOfConversation(el) {
    const txt = getText(el).slice(0, 60);
    const dataId =
      el.getAttribute("data-id") ||
      el.getAttribute("data-key") ||
      el.getAttribute("data-conversation-id") ||
      "";
    return `${dataId}__${txt}`.trim();
  }

  return (async () => {
    try {
      const sidebar = detectSidebar();
      if (!sidebar) return { ok: false, reason: "未找到左侧会话列表" };

      const discovered = new Map();
      let duplicateHits = 0;
      let stagnantRounds = 0;
      let listComplete = false;

      sidebar.scrollTop = 0;
      await sleep(250);

      for (let loops = 0; loops < 360; loops += 1) {
        const beforeSize = discovered.size;
        const current = getConversationElements(sidebar);

        current.forEach((el) => {
          const key = keyOfConversation(el);
          if (!key) return;
          if (discovered.has(key)) {
            duplicateHits += 1;
            return;
          }
          discovered.set(key, {
            key,
            name: getText(el).slice(0, 60) || "未命名会话",
            firstSeenTop: sidebar.scrollTop
          });
        });

        const grew = discovered.size > beforeSize;
        if (!grew) stagnantRounds += 1;
        else stagnantRounds = 0;

        const atBottom = sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 4;
        if (atBottom && stagnantRounds >= stagnantTarget) {
          listComplete = true;
          break;
        }

        const nextTop = Math.min(
          sidebar.scrollTop + Math.max(120, Math.floor(sidebar.clientHeight * 0.85)),
          sidebar.scrollHeight - sidebar.clientHeight
        );
        if (nextTop === sidebar.scrollTop) stagnantRounds += 1;
        sidebar.scrollTop = nextTop;
        await sleep(220);
      }

      return {
        ok: true,
        entries: Array.from(discovered.values()),
        skippedCount: duplicateHits,
        listComplete,
        discoveredCount: discovered.size
      };
    } catch (error) {
      return { ok: false, reason: error?.message || "未知错误" };
    }
  })();
}

function batchCollectAllConversationsInjected(stagnantTarget, maxMs, waitMs) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getText(el) {
    return el?.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function isNoiseMedia(urlValue) {
    const x = String(urlValue || "").trim().toLowerCase();
    if (!x || !/^https?:\/\//.test(x)) return true;
    if (x.includes("tps-2-2") || x.includes("tps-1-1")) return true;
    if (x.includes("avatar") || x.includes("profile") || x.includes("head")) return true;
    if (x.includes("placeholder") || x.includes("default")) return true;
    return false;
  }

  function detectChatPane() {
    const preferred = Array.from(
      document.querySelectorAll(
        '[class*="chat-main"], [class*="message-list"], [class*="message-panel"], [class*="chat-content"], [class*="chat-window"], main, section, div'
      )
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width < 300 || (rect.height < 60 && el.scrollHeight < 300)) return false;
        if (rect.left < window.innerWidth * 0.28) return false;
        if (rect.right <= 0 || rect.top >= window.innerHeight) return false;
        const cls = String(el.className || "").toLowerCase();
        if (/(sidebar|sider|header|footer|sendbox|toolbar|input|editor|composer|session-list|conv-list)/.test(cls)) {
          return false;
        }
        return el.querySelectorAll("div,span,p,img,video").length > 20;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const cls = String(el.className || "").toLowerCase();
        let score = rect.width * rect.height;
        if (/(chat-main|message-list|message-panel|chat-content|chat-window)/.test(cls)) score += 500000;
        if (rect.left > window.innerWidth * 0.35) score += 120000;
        return { el, score };
      })
      .sort((a, b) => b.score - a.score);
    if (preferred[0]?.el) return preferred[0].el;

    const composer =
      document.querySelector('textarea[placeholder*="输入"]') ||
      document.querySelector('input[placeholder*="输入"]') ||
      document.querySelector('div[contenteditable="true"]');
    if (!composer) return null;
    let current = composer;
    for (let i = 0; i < 12 && current; i += 1) {
      if ((current.querySelectorAll("div,span,p,img,video") || []).length > 20) return current;
      current = current.parentElement;
    }
    return composer.parentElement || null;
  }

  function looksLikeSidebarNode(el) {
    const rect = el.getBoundingClientRect?.();
    if (!rect) return false;
    return rect.left < window.innerWidth * 0.28 && rect.width < window.innerWidth * 0.45;
  }

  function getMessageCandidates(root) {
    const legacy = Array.from(root.querySelectorAll('[class*="ant-list-item"]')).filter((el) => !looksLikeSidebarNode(el));
    if (legacy.length > 1) return { mode: "legacy", nodes: legacy };

    const modern = Array.from(
      root.querySelectorAll(
        '[data-message-id], [class*="message-row"], [class*="message-item"], [class*="msg-item"], [class*="chat-item"], [class*="bubble"]'
      )
    ).filter((el) => !looksLikeSidebarNode(el));
    if (modern.length > 0) return { mode: "modern", nodes: modern };

    const fallback = Array.from(root.querySelectorAll("div,p,span"))
      .filter((el) => el.children.length === 0)
      .filter((el) => {
        const text = getText(el);
        return text.length >= 2 && text.length <= 240;
      })
      .filter((el) => !looksLikeSidebarNode(el))
      .slice(0, 800);

    return { mode: "fallback", nodes: fallback };
  }

  function detectIsMe(el) {
    const cls = String(el.className || "").toLowerCase();
    if (/(mine|self|me|right|owner|send|outgoing)/.test(cls)) return true;
    if (/(left|other|incoming|peer)/.test(cls)) return false;
    const style = String(el.getAttribute("style") || "").toLowerCase();
    if (style.includes("direction: rtl") || style.includes("text-align: right")) return true;
    if (style.includes("text-align: left")) return false;
    const rect = el.getBoundingClientRect?.();
    return !!rect && rect.left > window.innerWidth * 0.5;
  }

  function extractProductInfo(el) {
    const cls = String(el.className || "");
    const isProductCard = /price|product|goods|item-card/.test(cls);
    if (!isProductCard && !el.querySelector('[class*="price"]')) return null;
    const titleEl = el.querySelector('[class*="item-title"], [class*="item-name"], [class*="title"]');
    const text = getText(el);
    const priceMatch = text.match(/[￥¥]\s*\d+(?:\.\d{1,2})?/);
    if (!titleEl && !priceMatch) return null;
    return { groupName: getText(titleEl) || priceMatch?.[0] || "商品信息" };
  }

  function extractTimestamp(node) {
    const ownTime = getText(node.querySelector("time")) || getText(node.querySelector('[class*="time"]'));
    if (ownTime) return ownTime;
    let prev = node.previousElementSibling;
    while (prev) {
      const t = getText(prev.querySelector('[style*="text-align: center"]')) || getText(prev);
      if (/(\d{4}[-/]\d{1,2}[-/]\d{1,2})|(\d{1,2}[-/]\d{1,2})|(\d{1,2}:\d{2})/.test(t)) return t;
      prev = prev.previousElementSibling;
    }
    return "";
  }

  function extractUserId() {
    const url = location.href || "";
    const uid = url.match(/[?&](?:userId|userid|uid|toUserId|to_user_id)=([^&#]+)/i);
    if (uid?.[1]) return decodeURIComponent(uid[1]);
    return "unknown";
  }

  function extractCurrentConversationLocal() {
    const result = [];
    let currentProduct = null;
    const chatTitle =
      getText(document.querySelector('[class*="nickname"]')) ||
      getText(document.querySelector('[class*="user-name"]')) ||
      getText(document.querySelector('[class*="chat-title"]')) ||
      "闲鱼聊天记录";
    const contactName = chatTitle || "聊天对象";
    const contactUserId = extractUserId();

    const pane = detectChatPane();
    const detected = getMessageCandidates(pane || document);
    const nodes = detected.nodes || [];

    const dedupe = new Set();

    for (const el of nodes) {
      let product = extractProductInfo(el);
      if (!product && el.previousElementSibling) product = extractProductInfo(el.previousElementSibling);
      if (product) currentProduct = product;

      const isMe = detectIsMe(el);
      let text =
        getText(el.querySelector('[class*="message-text"] > span')) ||
        getText(el.querySelector('[class*="message-text"]')) ||
        getText(el.querySelector('[class*="msg-text"]')) ||
        getText(el.querySelector('[class*="content"]')) ||
        getText(el.querySelector('[class*="bubble"]')) ||
        getText(el);

      let imageUrl = "";
      let videoUrl = "";
      const imageEl = el.querySelector(
        '[class*="image-container"] img, .ant-image-img, img[src*="alicdn"], img[src*="goofish"], img'
      );
      if (imageEl) {
        imageUrl = imageEl.getAttribute("src") || imageEl.getAttribute("data-src") || "";
        if (imageUrl.startsWith("//")) imageUrl = `https:${imageUrl}`;
        if (isNoiseMedia(imageUrl)) imageUrl = "";
      }

      const videoEl = el.querySelector("video");
      if (videoEl) {
        videoUrl = videoEl.getAttribute("src") || videoEl.getAttribute("data-src") || "";
        if (videoUrl.startsWith("//")) videoUrl = `https:${videoUrl}`;
        if (isNoiseMedia(videoUrl)) videoUrl = "";
      }

      const quoteEl = el.querySelector('[class*="reply-container"], [class*="quote"], [class*="reply"]');
      const quoteText = quoteEl ? getText(quoteEl) : "";

      if (!text && imageUrl) text = "[图片]";
      if (!text && videoUrl) text = "[视频]";
      if (!text && quoteText) text = quoteText;
      if (!text && !imageUrl && !videoUrl) continue;

      const timestamp = extractTimestamp(el);
      const dedupeKey = `${isMe ? "me" : "other"}|${timestamp}|${text}|${imageUrl}|${videoUrl}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      result.push({
        id: result.length,
        isMe,
        text: text || "",
        imageUrl: imageUrl || "",
        videoUrl: videoUrl || "",
        quote: quoteText || "",
        timestamp,
        product: currentProduct || null,
        selected: true
      });
    }

    return {
      chatTitle,
      contactName,
      contactUserId,
      extract_mode: detected.mode || "fallback",
      detected_nodes: nodes.length,
      messages: result
    };
  }

  function detectSidebar() {
    const candidates = Array.from(document.querySelectorAll("div,aside,section"))
      .filter((el) => el.scrollHeight > el.clientHeight + 30)
      .filter((el) => {
        const r = el.getBoundingClientRect?.();
        if (!r) return false;
        return r.left < window.innerWidth * 0.4 && r.width < window.innerWidth * 0.45;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    return candidates[0] || null;
  }

  function getConversationElements(sidebar) {
    return Array.from(sidebar.querySelectorAll("div,li,a")).filter((el) => {
      const text = getText(el);
      if (!text || text.length < 2 || text.length > 100) return false;
      const rect = el.getBoundingClientRect?.();
      if (!rect || rect.height < 24) return false;
      const cls = String(el.className || "").toLowerCase();
      if (/(message|session|conversation|chat|item|list)/.test(cls)) return true;
      return !!el.querySelector("img");
    });
  }

  function keyOfConversation(el) {
    const txt = getText(el).slice(0, 60);
    const dataId =
      el.getAttribute("data-id") ||
      el.getAttribute("data-key") ||
      el.getAttribute("data-conversation-id") ||
      "";
    return `${dataId}__${txt}`.trim();
  }

  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }

  async function autoScrollMessagesToTop() {
    const start = Date.now();
    const pane = detectChatPane();
    const containers = Array.from(document.querySelectorAll("div,section,main"))
      .filter((el) => el.scrollHeight > el.clientHeight + 20)
      .filter((el) => {
        const r = el.getBoundingClientRect?.();
        if (!r) return false;
        return r.left > window.innerWidth * 0.2 && r.width > window.innerWidth * 0.35;
      })
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const container = containers[0] || pane;

    if (!container) return { ok: false, reason: "未找到消息滚动区域" };

    let reversed = false;
    try {
      const style = window.getComputedStyle(container);
      reversed = style.flexDirection === "column-reverse" || style.flexDirection === "row-reverse";
    } catch (e) {}

    let loops = 0;
    let stagnant = 0;
    let lastCount = -1;

    while (Date.now() - start < maxMs) {
      loops += 1;
      if (reversed) {
        container.scrollTop = container.scrollHeight;
      } else {
        container.scrollTop = 0;
      }
      await sleep(waitMs);

      const count = container.querySelectorAll('[class*="message"], [class*="msg"], [class*="bubble"], [class*="ant-list-item"], img, video').length;
      if (count <= lastCount) stagnant += 1;
      else stagnant = 0;
      lastCount = count;

      if (stagnant >= stagnantTarget) {
        return {
          ok: true,
          stoppedBy: "stagnation",
          loops,
          stagnantRounds: stagnant,
          detectedCount: count,
          durationMs: Date.now() - start
        };
      }
    }

    return {
      ok: true,
      stoppedBy: "timeout",
      loops,
      stagnantRounds: stagnant,
      detectedCount: lastCount,
      durationMs: Date.now() - start
    };
  }

  return (async () => {
    try {
      const sidebar = detectSidebar();
      if (!sidebar) return { ok: false, reason: "未找到左侧会话列表" };

      const discovered = new Map();
      let duplicateHits = 0;
      let stagnantRounds = 0;
      let listComplete = false;

      sidebar.scrollTop = 0;
      await sleep(250);

      // 先把左侧会话尽量探测完整：到底且多轮无新增才结束。
      for (let loops = 0; loops < 360; loops += 1) {
        const beforeSize = discovered.size;
        const current = getConversationElements(sidebar);

        current.forEach((el) => {
          const key = keyOfConversation(el);
          if (!key) return;
          if (discovered.has(key)) {
            duplicateHits += 1;
            return;
          }
          discovered.set(key, {
            key,
            name: getText(el).slice(0, 60) || "未命名会话",
            firstSeenTop: sidebar.scrollTop
          });
        });

        const grew = discovered.size > beforeSize;
        if (!grew) stagnantRounds += 1;
        else stagnantRounds = 0;

        const atBottom = sidebar.scrollTop + sidebar.clientHeight >= sidebar.scrollHeight - 4;
        if (atBottom && stagnantRounds >= 4) {
          listComplete = true;
          break;
        }

        const nextTop = Math.min(
          sidebar.scrollTop + Math.max(120, Math.floor(sidebar.clientHeight * 0.85)),
          sidebar.scrollHeight - sidebar.clientHeight
        );
        if (nextTop === sidebar.scrollTop) stagnantRounds += 1;
        sidebar.scrollTop = nextTop;
        await sleep(220);
      }

      const successes = [];
      const failures = [];
      const entries = Array.from(discovered.values());

      for (const item of entries) {
        try {
          sidebar.scrollTop = Math.max(0, item.firstSeenTop - 40);
          await sleep(220);

          const candidates = getConversationElements(sidebar);
          const target =
            candidates.find((el) => keyOfConversation(el) === item.key) ||
            candidates.find((el) => getText(el).slice(0, 30) === item.name.slice(0, 30));

          if (!target) {
            failures.push({ name: item.name, stage: "打开", reason: "会话节点未找到" });
            continue;
          }

          clickElement(target);
          await sleep(400);

          const scrollStat = await autoScrollMessagesToTop();
          if (!scrollStat.ok) {
            failures.push({ name: item.name, stage: "翻取", reason: scrollStat.reason || "翻取失败" });
            continue;
          }

          const convo = extractCurrentConversationLocal();
          if (!Array.isArray(convo.messages) || convo.messages.length === 0) {
            failures.push({
              name: item.name,
              stage: "提取",
              reason: `消息为空（模式:${convo.extract_mode || "unknown"} 节点:${convo.detected_nodes || 0}）`
            });
            continue;
          }

          successes.push({
            name: item.name,
            key: item.key,
            data: convo
          });
        } catch (error) {
          failures.push({ name: item.name, stage: "提取", reason: error?.message || "未知错误" });
        }
      }

      return {
        ok: true,
        listComplete,
        discoveredCount: entries.length,
        skippedCount: duplicateHits,
        successes,
        failures
      };
    } catch (error) {
      return { ok: false, reason: error?.message || "未知错误" };
    }
  })();
}



function simpleAutoScrollInjected(stagnantTarget, maxMs, waitMs) {
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function countNodes(root) {
    return root.querySelectorAll(
      '[class*="message"],[class*="msg"],[class*="bubble"],[class*="ant-list-item"],[data-message-id],img[src*="alicdn"],img[src*="goofish"],video'
    ).length;
  }

  return (async function () {
    try {
      var ml = document.querySelector('[class*="message-list"]');
      if (!ml) return { ok: false, reason: "未找到消息列表" };

      // Lock body scroll to prevent page jumping
      var savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      if (ml.clientHeight === 0) {
        var parent = ml.parentElement;
        ml.style.minHeight = (parent ? parent.clientHeight : 400) + "px";
        void ml.offsetHeight;
      }

      var style = window.getComputedStyle(ml);
      var isReverse = style.flexDirection === "column-reverse" || style.flexDirection === "row-reverse";

      var start = Date.now();
      var stagnant = 0;
      var lastCount = -1;
      var lastST = null;
      var loops = 0;

      while (Date.now() - start < maxMs) {
        loops++;
        var beforeST = ml.scrollTop;
        var beforeSH = ml.scrollHeight;

        if (isReverse) {
          ml.scrollTop = -ml.scrollHeight;
        } else {
          ml.scrollTop = 0;
        }

        await sleep(waitMs);

        var afterST = ml.scrollTop;
        var afterSH = ml.scrollHeight;
        var count = countNodes(ml);

        var scrollTopChanged = afterST !== beforeST;
        var scrollHeightChanged = afterSH !== beforeSH;
        var countChanged = count > lastCount;

        if (!scrollTopChanged && !scrollHeightChanged && !countChanged) {
          stagnant++;
        } else {
          stagnant = 0;
        }
        lastCount = count;

        if (stagnant >= stagnantTarget) {
          document.body.style.overflow = savedBodyOverflow;
          return { ok: true, stoppedBy: "stagnation", loops: loops, count: count, scrollTop: ml.scrollTop, scrollHeight: afterSH, clientHeight: ml.clientHeight, isReverse: isReverse, durationMs: Date.now() - start };
        }
      }

      document.body.style.overflow = savedBodyOverflow;

      return { ok: true, stoppedBy: "timeout", loops: loops, count: lastCount, scrollTop: ml.scrollTop, scrollHeight: lastSH, clientHeight: ml.clientHeight, isReverse: isReverse, durationMs: Date.now() - start };
    } catch (e) {
      return { ok: false, reason: e.message || "未知错误" };
    }
  })();
}
