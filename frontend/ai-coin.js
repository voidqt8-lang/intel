const STORAGE_KEY = "ai_coins_history";

const titleEl = document.getElementById("title");
const subredditEl = document.getElementById("subreddit");
const flairEl = document.getElementById("flair");
const generateBtn = document.getElementById("generateBtn");
const saveBtn = document.getElementById("saveBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const resultEl = document.getElementById("result");
const historyEl = document.getElementById("history");

let currentCoin = null;

function safeText(s) {
  const str = String(s ?? "");
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function renderHistory() {
  const items = loadHistory();
  historyEl.innerHTML = items.length
    ? items.map(c => {
        const key = c?.ticker || c?.name || "coin";
        return `
          <div class="flex justify-between items-center gap-2 text-xs border border-green-500/10 rounded px-2 py-1">
            <div class="text-green-200 truncate">${safeText(key)} </div>
            <button class="border border-blue-500/30 px-2 py-0.5 hover:bg-blue-500/20 rounded"
              onclick="window.loadCoinFromHistory('${encodeURIComponent(key)}')">
              LOAD
            </button>
          </div>
        `;
      }).join("")
    : `<div class="text-blue-500/50 text-xs">No history yet.</div>`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function setError(msg) {
  errorEl.textContent = msg || "";
}

function renderCoin(coin) {
  currentCoin = coin;
  resultEl.textContent = JSON.stringify(coin, null, 2);
}

function coinKey(coin) {
  return (coin?.ticker || coin?.name || "").toString().trim();
}

saveBtn.addEventListener("click", () => {
  if (!currentCoin) return;

  const items = loadHistory();
  const key = coinKey(currentCoin);
  if (!key) return;

  // De-dupe by key.
  const filtered = items.filter(x => coinKey(x) !== key);
  filtered.unshift(currentCoin);
  saveHistory(filtered.slice(0, 20));

  renderHistory();
});

clearBtn.addEventListener("click", () => {
  saveHistory([]);
  currentCoin = null;
  resultEl.textContent = "No coin generated yet.";
  renderHistory();
});

generateBtn.addEventListener("click", async () => {
  const title = titleEl.value.trim();
  const subreddit = subredditEl.value.trim();
  const flair = flairEl.value.trim();

  if (!title) return setError("Enter a post title first.");
  if (!subreddit) return setError("Enter a subreddit first.");

  setError("");
  setStatus("GENERATING...");
  generateBtn.disabled = true;

  try {
    const res = await fetch("/ai/coin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, subreddit, flair: flair || undefined })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);

    renderCoin(data);
    setStatus("DONE");
  } catch (e) {
    setStatus("ERROR");
    setError(e.message || "Unknown error");
  } finally {
    generateBtn.disabled = false;
  }
});

// Simple history loader; uses the key derived from ticker/name.
window.loadCoinFromHistory = function (encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const items = loadHistory();
  const coin = items.find(c => coinKey(c) === key);
  if (coin) renderCoin(coin);
};

// Init
renderHistory();

