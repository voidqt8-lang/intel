require("dotenv/config");
const https = require("https");
const TelegramBot = require("node-telegram-bot-api");
const WebSocket = require("ws");

process.on("unhandledRejection", (err) => console.error("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_IDS = (process.env.CHAT_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const POLL_MS = Math.max(300, parseInt(process.env.POLL_MS || "900", 10) || 900);
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || "2", 10) || 2);
const FAST_POLL_MS = Math.max(200, parseInt(process.env.FAST_POLL_MS || "350", 10) || 350);
const FAST_POLLS = Math.max(0, parseInt(process.env.FAST_POLLS || "8", 10) || 8);
const FETCH_TIMEOUT_MS = Math.max(1000, parseInt(process.env.FETCH_TIMEOUT_MS || "4000", 10) || 4000);
const USE_AXIOM_WS = String(process.env.USE_AXIOM_WS || "true").toLowerCase() !== "false";
const GLOBAL_429_BASE_COOLDOWN_MS = Math.max(
  500,
  parseInt(process.env.GLOBAL_429_BASE_COOLDOWN_MS || "2000", 10) || 2000
);
const GLOBAL_429_MAX_COOLDOWN_MS = Math.max(
  GLOBAL_429_BASE_COOLDOWN_MS,
  parseInt(process.env.GLOBAL_429_MAX_COOLDOWN_MS || "20000", 10) || 20000
);

if (!TELEGRAM_TOKEN) {
  console.error("Set TELEGRAM_TOKEN in .env");
  process.exit(1);
}
if (CHAT_IDS.length === 0) {
  console.error("Set CHAT_IDS in .env (comma-separated Telegram user/chat IDs)");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
process.on("SIGINT", () => {
  bot.stopPolling();
  process.exit(0);
});
process.on("SIGTERM", () => {
  bot.stopPolling();
  process.exit(0);
});
bot.on("polling_error", (err) => console.error("Polling error:", err.message));

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20, keepAliveMsecs: 10000 });

/** @typedef {"processing" | "approved" | "paid"} AlertStage */
const ALERT_STAGES = new Set(["processing", "approved", "paid"]);
const STAGE_ORDER = { processing: 1, approved: 2, paid: 3 };

/** @type {Map<string, Set<AlertStage>>} */
const alertedStages = new Map();
/** @type {Set<string>} */
const watchedTokens = new Set();
/** @type {Set<string>} */
const waitingForAddress = new Set();
/** @type {Map<string, Set<string>>} */
const seenOrderKeys = new Map();
/** @type {Map<string, {name?: string, symbol?: string, dex?: string}>} */
const tokenInfoCache = new Map();

const SUPPORTED_DEXES = ["pumpfun", "raydium", "raydium-clmm", "raydium-cp"];
const AXIOM_WS_URL = process.env.AXIOM_WS_URL || "wss://cluster-gcp-euw1.axiom.trade/";

let axiomWs = null;
let axiomConnected = false;
const pendingRooms = new Set();
let wsDisabledByAuth = false;

let activeRequests = 0;
const requestQueue = [];
let global429Streak = 0;
let globalCooldownUntil = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function acquireSlot() {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
    } else {
      requestQueue.push(() => {
        activeRequests++;
        resolve();
      });
    }
  });
}

function releaseSlot() {
  activeRequests--;
  const next = requestQueue.shift();
  if (next) next();
}

async function waitForGlobalCooldown() {
  const waitMs = globalCooldownUntil - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

function registerGlobal429() {
  global429Streak = Math.min(global429Streak + 1, 8);
  const cooldown = Math.min(
    GLOBAL_429_BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, global429Streak - 1)),
    GLOBAL_429_MAX_COOLDOWN_MS
  );
  globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + cooldown);
  return cooldown;
}

function registerGlobalSuccess() {
  if (global429Streak > 0) global429Streak--;
}

function axiomJoinRoom(tokenAddress) {
  if (!USE_AXIOM_WS || wsDisabledByAuth) return;
  const room = `${tokenAddress}-dex-paid`;
  if (axiomConnected && axiomWs?.readyState === WebSocket.OPEN) {
    axiomWs.send(JSON.stringify({ action: "join", room }));
    console.log(`📡 [Axiom WS] Joined room: ${room}`);
  } else {
    pendingRooms.add(room);
  }
}

function axiomLeaveRoom(tokenAddress) {
  const room = `${tokenAddress}-dex-paid`;
  pendingRooms.delete(room);
  if (axiomConnected && axiomWs?.readyState === WebSocket.OPEN) {
    axiomWs.send(JSON.stringify({ action: "leave", room }));
  }
}

function startAxiomWatcher() {
  if (!USE_AXIOM_WS || wsDisabledByAuth) return;
  let pingInterval;

  function connect() {
    console.log("🔌 [Axiom WS] Connecting...");
    axiomWs = new WebSocket(AXIOM_WS_URL, {
      headers: {
        Origin: "https://axiom.trade",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      },
    });

    axiomWs.on("open", () => {
      axiomConnected = true;
      console.log("✅ [Axiom WS] Connected");
      for (const room of pendingRooms) {
        axiomWs.send(JSON.stringify({ action: "join", room }));
      }
      pendingRooms.clear();
      for (const token of watchedTokens) {
        axiomWs.send(JSON.stringify({ action: "join", room: `${token}-dex-paid` }));
      }
      pingInterval = setInterval(() => {
        if (axiomWs?.readyState === WebSocket.OPEN) {
          axiomWs.send(JSON.stringify({ action: "ping" }));
        }
      }, 30000);
    });

    axiomWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const room = msg.room || msg.channel || "";
        const tokenAddress = room.replace(/-dex-paid$/, "").toLowerCase();
        if (!tokenAddress || !watchedTokens.has(tokenAddress)) return;

        const status = String(msg.status || msg.orderStatus || msg.data?.status || "").toLowerCase();
        const type = String(msg.type || msg.orderType || msg.data?.type || msg.event || "");
        if (!status && !type) return;
        if (msg.action === "join" || msg.action === "ping" || msg.action === "leave") return;

        console.log(`[Axiom WS] ${tokenAddress} — type: ${type} | status: ${status}`);
        await handleOrderEvent(tokenAddress, type, status, "AxiomWS");
      } catch {
        // ignore parse errors
      }
    });

    axiomWs.on("close", () => {
      axiomConnected = false;
      if (pingInterval) clearInterval(pingInterval);
      if (wsDisabledByAuth) {
        console.warn("⚠️ [Axiom WS] Disabled after 401; running polling-only.");
        return;
      }
      console.warn("⚠️ [Axiom WS] Disconnected — reconnecting in 3s...");
      setTimeout(connect, 3000);
    });

    axiomWs.on("error", (err) => {
      const msg = String(err?.message || "");
      if (msg.includes("401")) {
        wsDisabledByAuth = true;
        console.error("[Axiom WS] 401 Unauthorized. Disabling WS and continuing with polling-only.");
      } else {
        console.error("[Axiom WS] Error:", msg);
      }
      axiomWs?.close();
    });
  }

  connect();
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: keepAliveAgent,
        timeout: FETCH_TIMEOUT_MS,
        headers: { Accept: "application/json", "User-Agent": "dex-watcher-free/1.0" },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          } else {
            const err = new Error(`HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
  });
}

const tokenPollTimers = new Map();

async function handleOrderEvent(tokenAddress, type, status, source) {
  if (!status) return;
  const normalStatus = String(status).toLowerCase();
  if (normalStatus === "rejected" || normalStatus === "cancelled") return;
  if (!ALERT_STAGES.has(/** @type {AlertStage} */ (normalStatus))) return;
  const stage = /** @type {AlertStage} */ (normalStatus);

  if (!alertedStages.has(tokenAddress)) alertedStages.set(tokenAddress, new Set());
  const stages = alertedStages.get(tokenAddress);

  if (stages.has(stage)) {
    console.log(`[${source}] Already alerted stage "${stage}" for ${tokenAddress} — skipping`);
    return;
  }

  stages.add(stage);
  console.log(`🔥 [${source}] Stage "${stage}" for ${tokenAddress}`);

  const ts = getTimestamp();
  const url = `https://dexscreener.com/solana/${tokenAddress}`;
  const stageEmoji = stage === "processing" ? "⏳" : stage === "approved" ? "✅" : "🚨";
  const stageLabel =
    stage === "processing"
      ? "Processing — DEX order submitted"
      : stage === "approved"
        ? "Approved — DEX listing confirmed"
        : "PAID — DEX listing live";

  const cachedInfo = tokenInfoCache.get(tokenAddress) || {};
  const tickerLine = `🏷 Ticker: \`${cachedInfo.symbol || "loading..."}\``;
  const nameLine = cachedInfo.name ? `🧠 Name: \`${cachedInfo.name}\`\n` : "";

  void broadcast(
    `${stageEmoji} *${stageLabel}*\n\n${tickerLine}\n${nameLine}📍 CA: \`${tokenAddress}\`\n⏱ \`${ts}\`\n\n🔍 [View on DEX Screener](${url})`,
    { parse_mode: "Markdown", disable_web_page_preview: true }
  ).catch((err) => {
    console.error(`[${source}] Failed immediate broadcast for ${tokenAddress}:`, err?.message || err);
  });

  void fetchTokenInfo(tokenAddress).then(async (info) => {
    tokenInfoCache.set(tokenAddress, info || {});
    if (!info.name && !info.symbol) return;
    await broadcast(
      `ℹ️ *${info.name || "?"}* (${info.symbol || "?"}) on ${info.dex || "Unknown"}\n📍 CA: \`${tokenAddress}\``,
      { parse_mode: "Markdown" }
    );
  });

  // Auto-clean watchlist once listing is approved.
  if (stage === "approved" && watchedTokens.has(tokenAddress)) {
    removeWatchedToken(tokenAddress);
    void broadcast(`✅ Auto-removed approved token \`${tokenAddress}\` from watch list.`, {
      parse_mode: "Markdown",
      ...mainMenu,
    }).catch(() => {});
  }
}

function startPollingToken(tokenAddress) {
  if (tokenPollTimers.has(tokenAddress)) return;

  let pollsCompleted = 0;
  let backoffMs = Math.min(POLL_MS, FAST_POLL_MS);
  let consecutiveErrors = 0;

  async function poll() {
    if (!watchedTokens.has(tokenAddress)) return;
    const pollStartedAt = Date.now();

    await acquireSlot();
    try {
      await waitForGlobalCooldown();
      const targetPollMs = pollsCompleted < FAST_POLLS ? Math.min(POLL_MS, FAST_POLL_MS) : POLL_MS;
      const data = await fetchJson(
        `https://api.dexscreener.com/orders/v1/solana/${tokenAddress}`
      );
      consecutiveErrors = 0;
      backoffMs = targetPollMs;
      registerGlobalSuccess();

      const orders = data?.orders;
      if (!Array.isArray(orders) || orders.length === 0) {
        // continue scheduling
      } else {
        if (!seenOrderKeys.has(tokenAddress)) seenOrderKeys.set(tokenAddress, new Set());
        const seen = seenOrderKeys.get(tokenAddress);

        const normalizedOrders = orders
          .map((order) => {
            const t = order.type || "unknown";
            const st = String(order.status || "unknown").toLowerCase();
            const ts = order.paymentTimestamp ?? order.createdAt ?? 0;
            return { type: t, status: st, ts };
          })
          .sort((a, b) => a.ts - b.ts);

        for (const order of normalizedOrders) {
          const type = order.type || "unknown";
          const status = order.status || "unknown";
          const ts = order.ts ?? 0;
          const key = `${type}:${status}:${ts}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (status === "rejected" || status === "cancelled") continue;
          console.log(`[Polling] ${tokenAddress} — type: ${type} | status: ${status}`);
          void handleOrderEvent(tokenAddress, type, status, "Polling");
        }
      }
    } catch (err) {
      if (err.statusCode === 429) {
        consecutiveErrors++;
        backoffMs = Math.min(Math.max(backoffMs * 2, POLL_MS), 20000);
        const globalCooldownMs = registerGlobal429();
        console.warn(
          `[Polling] ⚠️ 429 for ${tokenAddress} — token backoff ${backoffMs}ms | global cooldown ${globalCooldownMs}ms`
        );
      } else if (err.message !== "timeout") {
        console.error(`[Polling] Error for ${tokenAddress}:`, err.message);
      }
    } finally {
      releaseSlot();
      pollsCompleted++;
      if (watchedTokens.has(tokenAddress)) {
        const elapsedMs = Date.now() - pollStartedAt;
        const jitter = 0.9 + Math.random() * 0.25;
        const nextDelayMs = Math.max(150, Math.floor(backoffMs * jitter) - elapsedMs);
        const timer = setTimeout(poll, nextDelayMs);
        tokenPollTimers.set(tokenAddress, timer);
      }
    }
  }

  const initialDelayMs = Math.floor(Math.random() * 350);
  const timer = setTimeout(poll, initialDelayMs);
  tokenPollTimers.set(tokenAddress, timer);
}

function stopPollingToken(tokenAddress) {
  const timer = tokenPollTimers.get(tokenAddress);
  if (timer) {
    clearTimeout(timer);
    tokenPollTimers.delete(tokenAddress);
  }
}

async function broadcast(message, options) {
  await Promise.all(
    CHAT_IDS.map((chatId) =>
      bot.sendMessage(chatId, message, options).catch((err) =>
        console.error(`Failed to send to ${chatId}:`, err.message)
      )
    )
  );
}

function isAllowed(chatId) {
  return CHAT_IDS.includes(chatId);
}

function getTimestamp() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

async function fetchTokenInfo(address) {
  try {
    const cached = tokenInfoCache.get(address);
    if (cached && (cached.symbol || cached.name)) return cached;
    const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const pairs = (data.pairs || []).filter(
      (p) => p.chainId === "solana" && SUPPORTED_DEXES.includes(p.dexId)
    );
    if (pairs.length === 0) return {};
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const info = {
      name: best?.baseToken?.name,
      symbol: best?.baseToken?.symbol,
      dex:
        best?.dexId === "pumpfun"
          ? "Pump.fun"
          : best?.dexId?.startsWith("raydium")
            ? "Raydium"
            : best?.dexId,
    };
    tokenInfoCache.set(address, info);
    return info;
  } catch {
    return {};
  }
}

async function addWatchedToken(address, requesterChatId) {
  const lower = address.toLowerCase();
  if (watchedTokens.has(lower)) {
    await bot.sendMessage(requesterChatId, `⚠️ Already watching \`${lower}\``, {
      parse_mode: "Markdown",
      ...mainMenu,
    });
    return;
  }
  watchedTokens.add(lower);
  alertedStages.set(lower, new Set());
  await fetchTokenInfo(lower).catch(() => ({}));

  try {
    const data = await fetchJson(`https://api.dexscreener.com/orders/v1/solana/${lower}`);
    const orders = data?.orders;
    const seen = new Set();
    seenOrderKeys.set(lower, seen);

    if (Array.isArray(orders)) {
      for (const order of orders) {
        const type = order.type || "unknown";
        const status = order.status || "unknown";
        const ts = order.paymentTimestamp ?? order.createdAt ?? 0;
        const key = `${type}:${status}:${ts}`;
        if (status === "paid" || status === "rejected" || status === "cancelled") {
          seen.add(key);
          if (status === "paid") {
            alertedStages.get(lower).add("paid");
          }
        }
      }
    }
  } catch {
    seenOrderKeys.set(lower, new Set());
  }

  startPollingToken(lower);
  axiomJoinRoom(lower);

  console.log(`👀 Watching: ${lower} | total: ${watchedTokens.size}`);
  const cachedInfo = tokenInfoCache.get(lower) || {};
  await broadcast(
    `👀 Now watching \`${lower}\`${cachedInfo.symbol ? ` (${cachedInfo.symbol})` : " (?)"}\n📊 Total: ${watchedTokens.size} token(s)\n⏱ Poll every ~${POLL_MS}ms (free DEX Screener API)\n⚡ Fast start: ${FAST_POLL_MS}ms for first ${FAST_POLLS} polls`,
    { parse_mode: "Markdown", ...mainMenu }
  );
}

function removeWatchedToken(address) {
  axiomLeaveRoom(address);
  watchedTokens.delete(address);
  alertedStages.delete(address);
  seenOrderKeys.delete(address);
  tokenInfoCache.delete(address);
  stopPollingToken(address);
}

function clearAllTokens() {
  for (const token of watchedTokens) {
    axiomLeaveRoom(token);
    stopPollingToken(token);
  }
  watchedTokens.clear();
  alertedStages.clear();
  seenOrderKeys.clear();
  tokenInfoCache.clear();
  console.log("🗑 Cleared all watched tokens");
}

function buildListTokensMenu() {
  const rows = [...watchedTokens].slice(0, 25).map((token) => {
    const symbol = tokenInfoCache.get(token)?.symbol || "?";
    return [{ text: `❌ ${symbol} ${token.slice(0, 6)}...${token.slice(-4)}`, callback_data: `remove:${token}` }];
  });
  rows.push([{ text: "🗑 Clear All", callback_data: "clear_all" }, { text: "❓ Help", callback_data: "help" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

const mainMenu = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "➕ Add Token", callback_data: "add_token" },
        { text: "📋 List Tokens", callback_data: "list_tokens" },
      ],
      [
        { text: "🗑 Clear All", callback_data: "clear_all" },
        { text: "❓ Help", callback_data: "help" },
      ],
    ],
  },
};

bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat.id.toString() || "";
  if (!isAllowed(chatId)) return;
  await bot.answerCallbackQuery(query.id);

  if (query.data === "add_token") {
    waitingForAddress.add(chatId);
    await bot.sendMessage(chatId, "📋 Paste the Solana token mint address you want to watch:");
  } else if (query.data === "list_tokens") {
    if (watchedTokens.size === 0) {
      await bot.sendMessage(chatId, "📭 No tokens being watched.", mainMenu);
    } else {
      const list = [...watchedTokens]
        .map((a, i) => {
          const stages = [...(alertedStages.get(a) || [])].join(", ") || "waiting";
          const symbol = tokenInfoCache.get(a)?.symbol || "?";
          return `${i + 1}. \`${a}\` (${symbol}) — ${stages}`;
        })
        .join("\n");
      await bot.sendMessage(chatId, `👀 *Watching ${watchedTokens.size} token(s)*\n\n${list}`, {
        parse_mode: "Markdown",
        ...buildListTokensMenu(),
      });
    }
  } else if (query.data?.startsWith("remove:")) {
    const address = query.data.slice("remove:".length).trim().toLowerCase();
    if (!address || !watchedTokens.has(address)) {
      await bot.sendMessage(chatId, "❌ Token not found.", mainMenu);
      return;
    }
    removeWatchedToken(address);
    await broadcast(`🗑 Removed \`${address}\` from watch list`, { parse_mode: "Markdown", ...mainMenu });
  } else if (query.data === "clear_all") {
    const count = watchedTokens.size;
    if (count === 0) {
      await bot.sendMessage(chatId, "📭 Nothing to clear.", mainMenu);
      return;
    }
    clearAllTokens();
    await broadcast(`🗑 Cleared ${count} token(s).`, mainMenu);
  } else if (query.data === "help") {
    await bot.sendMessage(
      chatId,
      `*DEX Watcher (free)*\n\n` +
        `Uses DEX Screener's public API only — no paid keys.\n\n` +
        `*Alert stages (each fires once per token):*\n` +
        `⏳ processing\n` +
        `✅ approved\n` +
        `🚨 paid\n\n` +
        `*/watch* \`<mint>\`\n` +
        `*/unwatch* \`<mint>\`\n` +
        `*/menu*\n\n` +
        `If you hit rate limits, set POLL_MS higher in .env (e.g. 1500).`,
      { parse_mode: "Markdown", ...mainMenu }
    );
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id.toString();
  if (!isAllowed(chatId)) return;
  const text = msg.text?.trim();
  if (!text) return;

  if (waitingForAddress.has(chatId) && !text.startsWith("/")) {
    waitingForAddress.delete(chatId);
    if (text.length < 32) {
      await bot.sendMessage(chatId, "❌ Invalid address.", mainMenu);
      return;
    }
    await addWatchedToken(text, chatId);
    return;
  }
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  if (!isAllowed(chatId)) return;
  await bot.sendMessage(chatId, "👋 *DEX Watcher (free)*\n\nUse the buttons below.", {
    parse_mode: "Markdown",
    ...mainMenu,
  });
});

bot.onText(/\/menu/, async (msg) => {
  const chatId = msg.chat.id.toString();
  if (!isAllowed(chatId)) return;
  await bot.sendMessage(chatId, "🎛 Main Menu:", mainMenu);
});

bot.onText(/\/watch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (!isAllowed(chatId)) return;
  const address = match?.[1]?.trim();
  if (!address || address.length < 32) {
    await bot.sendMessage(chatId, "❌ Usage: /watch <address>");
    return;
  }
  await addWatchedToken(address, chatId);
});

bot.onText(/\/unwatch (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (!isAllowed(chatId)) return;
  const address = match?.[1]?.trim().toLowerCase();
  if (!address || !watchedTokens.has(address)) {
    await bot.sendMessage(chatId, "❌ Token not found.");
    return;
  }
  removeWatchedToken(address);
  await broadcast(`🗑 Stopped watching \`${address}\``, { parse_mode: "Markdown", ...mainMenu });
});

console.log("🚀 DEX Watcher (free) started");
console.log(`👥 Allowed chats: ${CHAT_IDS.length} (${CHAT_IDS.join(", ")})`);
console.log(`⏱ POLL_MS=${POLL_MS} | FAST_POLL_MS=${FAST_POLL_MS} | FAST_POLLS=${FAST_POLLS} | MAX_CONCURRENT=${MAX_CONCURRENT}`);
console.log(`📡 Axiom WS=${USE_AXIOM_WS ? "ON" : "OFF"}${wsDisabledByAuth ? " (disabled by auth)" : ""}`);
console.log("💬 Send /menu in Telegram to get started");
startAxiomWatcher();
