let trackers = JSON.parse(localStorage.getItem("tw_trackers") || "[]");
let tracking = false;
let interval = null;
let seenIdsByQuery = {}; // { [query]: Set(tweetId) }
let notifPermission = false;

/* =========================
   REQUEST NOTIFICATION PERMISSION
========================= */

async function requestNotifPermission() {
  if (!("Notification" in window)) return;
  const perm = await Notification.requestPermission();
  notifPermission = perm === "granted";
}

requestNotifPermission();

/* =========================
   ELEMENTS
========================= */

const feedEl = document.getElementById("feed");
const trackerListEl = document.getElementById("trackerList");
const likesSlider = document.getElementById("likes");
const likeVal = document.getElementById("likeVal");
const tokenRadarEl = document.getElementById("tokenRadar");
const autoBriefEl = document.getElementById("autoBrief");
const briefBtn = document.getElementById("briefBtn");
const briefStatusEl = document.getElementById("briefStatus");
const briefMomentumEl = document.getElementById("briefMomentum");
const briefTextEl = document.getElementById("briefText");

likesSlider.addEventListener("input", () => {
  likeVal.innerText = fmt(Number(likesSlider.value));
});

/* =========================
   NORMALIZE TWEET
========================= */

function normalize(t) {
  return {
    id: t.id,
    text: t.text || "",
    url: t.url || "#",
    username: t.username || "unknown",
    display_name: t.display_name || "",
    likes: Number(t.likes || 0),
    followers: Number(t.followers || 0),
    verified: !!t.verified,
    is_quote: !!t.is_quote,
    is_reply: !!t.is_reply,
    media: t.media || [],
    created_at: new Date(t.created_at || t.date || t.timestamp)
  };
}

/* =========================
   FORMATTERS
========================= */

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n;
}

function timeAgo(d) {
  if (!d || isNaN(d)) return "unknown";
  const diff = Date.now() - d.getTime();
  const h = diff / 3600000;
  const day = diff / 86400000;
  if (day >= 1) return Math.floor(day) + "d";
  if (h >= 1) return Math.floor(h) + "h";
  return Math.floor(diff / 60000) + "m";
}

/* =========================
   TRACKER UI
========================= */

function renderTrackers() {
  trackerListEl.innerHTML = trackers
    .map(
      t => `
    <div class="flex gap-1 items-center">
      <button onclick="setQuery('${t.query}')"
        class="border border-blue-500/40 px-2 py-0.5 text-blue-300 hover:bg-blue-500/20">
        ${t.query}
      </button>
      <button onclick="removeTracker('${t.query}')" class="text-red-400 hover:text-red-300">×</button>
    </div>
  `
    )
    .join("");
}

window.addTracker = function () {
  const val = document.getElementById("search").value.trim();
  if (!val) return;
  if (trackers.find(t => t.query === val)) return;
  trackers.push({ query: val });
  localStorage.setItem("tw_trackers", JSON.stringify(trackers));
  renderTrackers();
};

/* =========================
   INTEL BRIEF (AI)
========================= */
let lastSources = [];
let lastBriefKey = null;
let briefBusy = false;

function tokenizeInput(s) {
  return Array.from(
    new Set(
      String(s || "")
        .split(/[,\s]+/)
        .map(x => x.trim())
        .filter(Boolean)
    )
  ).slice(0, 10);
}

function computeMentionCounts(sources, tokens) {
  const now = Date.now();
  const tokenList = tokens.length ? tokens : [];

  function mentionsWithin(hours) {
    let count = 0;
    for (const s of sources) {
      const ageH = (now - s.createdAtMs) / 3600000;
      if (ageH > hours) continue;
      if (!tokenList.length) {
        count++;
        continue;
      }
      const hay = `${s.title}\n${s.text}`.toLowerCase();
      if (tokenList.some(t => hay.includes(t.toLowerCase()))) count++;
    }
    return count;
  }

  return {
    mentions1h: mentionsWithin(1),
    mentions6h: mentionsWithin(6),
    mentionsWindow: sources.length
  };
}

function buildMomentumLine({ tokens, mentions1h, mentions6h, mentionsWindow }) {
  const tokenLabel = tokens.length ? tokens.join(", ") : "all tokens";
  return `TOKENS: ${tokenLabel}\nMENTIONS: 1h=${mentions1h} • 6h=${mentions6h} • window=${mentionsWindow}`;
}

function getBriefQueryText() {
  // During tracking the input value may not represent the active saved queries.
  const qVal = document.getElementById("search")?.value?.trim();
  const queries = getActiveQueries();
  return (queries.length ? queries.join(", ") : qVal) || "twitter";
}

async function generateBrief() {
  if (briefBusy) return;
  if (!lastSources.length) {
    briefStatusEl.textContent = "NO SOURCES";
    briefTextEl.textContent = "No sources available yet. Run a scan first.";
    return;
  }

  const windowHours = +document.getElementById("timeFilter").value;
  const tokens = tokenizeInput(tokenRadarEl?.value);
  const queryText = getBriefQueryText();

  const briefKey = [
    "twitter",
    queryText,
    windowHours,
    tokens.join(","),
    lastSources[0]?.url || ""
  ].join("|");
  if (briefKey === lastBriefKey && briefTextEl.textContent !== "No briefing yet.") return;

  lastBriefKey = briefKey;
  briefBusy = true;
  briefStatusEl.textContent = "GENERATING...";

  try {
    const res = await fetch("/intel/brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "twitter",
        query: queryText,
        windowHours,
        tokens,
        sources: lastSources
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `Brief failed (${res.status})`);

    const text = [
      `SUMMARY:\n${data.summary}`,
      "",
      `MOMENTUM:\n${data.momentum?.trend || "unknown"} • mentions=${data.momentum?.mentions ?? "?"}`,
      ...(Array.isArray(data.momentum?.signals) ? data.momentum.signals.map(s => `- ${s}`) : []),
      "",
      "NARRATIVES:",
      ...(Array.isArray(data.narratives)
        ? data.narratives.map((n, i) => {
            const ev = Array.isArray(n.evidenceUrls) ? n.evidenceUrls : [];
            return [
              `${i + 1}. ${n.title} (conf=${n.confidence ?? "?"})`,
              `   WHY NOW: ${n.whyNow}`,
              ev.length ? `   EVIDENCE:\n${ev.map(u => `     - ${u}`).join("\n")}` : "   EVIDENCE: none"
            ].join("\n");
          })
        : []),
      "",
      `RISK: ${data.risk?.riskLevel || "unknown"} (score=${data.risk?.overallScore ?? "?"})`,
      ...(Array.isArray(data.risk?.redFlags)
        ? data.risk.redFlags.map((r, i) => {
            const ev = Array.isArray(r.evidenceUrls) ? r.evidenceUrls : [];
            return [
              `${i + 1}. ${r.label}`,
              `   WHY: ${r.why}`,
              ev.length ? `   EVIDENCE:\n${ev.map(u => `     - ${u}`).join("\n")}` : "   EVIDENCE: none"
            ].join("\n");
          })
        : []),
      "",
      "NEXT STEPS:",
      ...(Array.isArray(data.nextSteps) ? data.nextSteps.map(s => `- ${s}`) : []),
      "",
      `DISCALIMER:\n${data.disclaimer || ""}`
    ].join("\n");

    briefTextEl.textContent = text;
    briefStatusEl.textContent = "DONE";
  } catch (e) {
    briefStatusEl.textContent = "ERROR";
    briefTextEl.textContent = `Brief error: ${e.message}`;
  } finally {
    briefBusy = false;
  }
}

briefBtn?.addEventListener("click", generateBrief);
autoBriefEl?.addEventListener("change", () => {
  if (autoBriefEl.checked) generateBrief();
});

window.removeTracker = function (q) {
  trackers = trackers.filter(t => t.query !== q);
  localStorage.setItem("tw_trackers", JSON.stringify(trackers));
  renderTrackers();
};

window.setQuery = function (q) {
  document.getElementById("search").value = q;
};

/* =========================
   TRACKING
========================= */

function getActiveQueries() {
  const inputVal = document.getElementById("search").value.trim();
  const saved = Array.isArray(trackers)
    ? trackers.map(t => String(t.query || "").trim()).filter(Boolean)
    : [];

  // If user has no saved trackers yet, fall back to the current input.
  const queries = saved.length ? saved : inputVal ? [inputVal] : ["crypto"];

  // De-dupe while preserving order.
  const seen = new Set();
  return queries.filter(q => {
    if (seen.has(q)) return false;
    seen.add(q);
    return true;
  });
}

window.toggleTracking = function () {
  tracking = !tracking;

  const state = document.getElementById("trackingState");
  const statusText = document.getElementById("statusText");
  const activeQuery = document.getElementById("activeQuery");

  if (tracking) {
    state.innerText = "● TRACKING ON";
    state.className = "text-green-400 text-xs";

    statusText.innerText = "RUNNING";
    const queries = getActiveQueries();
    activeQuery.innerText = queries.length > 1 ? `${queries.length} TRACKERS` : queries[0];

    fetchTweetsForQueries(queries); // immediate first fetch
    interval = setInterval(() => fetchTweetsForQueries(queries), 15000);
  } else {
    state.innerText = "● TRACKING OFF";
    state.className = "text-red-400 text-xs";
    statusText.innerText = "IDLE";
    activeQuery.innerText = "NONE";
    clearInterval(interval);
  }
};

/* =========================
   NOTIFY
========================= */

function notifyNewTweets(newTweets) {
  if (!newTweets.length) return;

  // In-app toast
  showToast(`${newTweets.length} new tweet${newTweets.length > 1 ? "s" : ""} arrived`);

  // Browser notification
  if (notifPermission && document.visibilityState === "hidden") {
    const first = newTweets[0];
    new Notification("X Intel — New Signal", {
      body: `@${first.username}: ${first.text.slice(0, 80)}${first.text.length > 80 ? "…" : ""}`,
      icon: "/favicon.ico"
    });
  }
}

function showToast(msg) {
  const el = document.createElement("div");
  el.className =
    "fixed top-4 right-4 z-50 bg-blue-900 border border-blue-400 text-blue-200 text-xs px-4 py-2 rounded shadow-lg transition-opacity duration-500";
  el.innerText = "🔔 " + msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 500);
  }, 3500);
}

/* =========================
   FETCH + FILTER
========================= */

async function fetchTweetsForQuery(q, { updateSeenAndNotify }) {
  const minLikes = Number(document.getElementById("likes").value);
  const hours = Number(document.getElementById("timeFilter").value);
  const minFollowers = Number(document.getElementById("followers").value);

  const verifiedOnly = document.getElementById("verifiedOnly").checked;
  const quoteOnly = document.getElementById("quoteOnly").checked;
  const includeReplies = document.getElementById("replies").checked; // default OFF

  const res = await fetch(
    `/twitter/search?q=${encodeURIComponent(q)}&limit=100`
  );
  if (!res.ok) throw new Error(`Twitter HTTP ${res.status}`);

  const data = await res.json();

  let tweets = (data.tweets || [])
    .map(normalize)
    .filter(t => !isNaN(t.created_at));

  tweets = tweets.filter(t => {
    const ageH = (Date.now() - t.created_at.getTime()) / 3600000;

    // Time filter
    if (ageH > hours) return false;

    // Likes filter
    if (t.likes < minLikes) return false;

    // Followers filter
    if (t.followers < minFollowers) return false;

    // Verified filter
    if (verifiedOnly && !t.verified) return false;

    // Quote filter
    if (quoteOnly && !t.is_quote) return false;

    // Replies — excluded by default unless checkbox enabled
    if (!includeReplies && t.is_reply) return false;

    return true;
  });

  tweets.sort((a, b) => b.likes - a.likes);
  tweets = tweets.slice(0, 10);

  if (updateSeenAndNotify) {
    seenIdsByQuery[q] = seenIdsByQuery[q] || new Set();
    const seen = seenIdsByQuery[q];

    const newTweets = tweets.filter(t => !seen.has(t.id));
    if (seen.size > 0) {
      // Don't notify on the very first fetch for this query.
      notifyNewTweets(newTweets);
    }
    tweets.forEach(t => seen.add(t.id));
  }

  return tweets;
}

async function fetchTweetsForQueries(queries) {
  feedEl.innerHTML =
    `<div class="text-blue-500/50 text-sm">Scanning ${queries.length} tracker${queries.length > 1 ? "s" : ""}...</div>`;

  const all = [];
  for (const q of queries) {
    const tweets = await fetchTweetsForQuery(q, { updateSeenAndNotify: true });
    all.push(...tweets);
  }

  // De-dupe across trackers to avoid showing the same tweet multiple times.
  const byId = new Map();
  for (const t of all) {
    const prev = byId.get(t.id);
    if (!prev || t.likes > prev.likes) byId.set(t.id, t);
  }

  const merged = Array.from(byId.values())
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 10);

  // Cache evidence sources for Intel Brief generation.
  lastSources = merged.map(t => ({
    url: t.url,
    title: `${t.display_name || t.username} @${t.username}`,
    text: t.text || "",
    engagement: {
      likes: t.likes,
      retweets: t.retweets,
      replies: t.replies,
      followers: t.followers,
      verified: t.verified,
      views: t.views,
      impressions: t.impressions
    },
    ageHours: (Date.now() - t.created_at.getTime()) / 3600000,
    createdAtMs: t.created_at.getTime()
  }));

  const tokens = tokenizeInput(tokenRadarEl?.value);
  const mentionCounts = computeMentionCounts(lastSources, tokens);
  briefMomentumEl.textContent = buildMomentumLine({
    tokens,
    mentions1h: mentionCounts.mentions1h,
    mentions6h: mentionCounts.mentions6h,
    mentionsWindow: mentionCounts.mentionsWindow
  });
  briefStatusEl.textContent = lastSources.length ? `BRIEF READY (${lastSources.length})` : "IDLE";
  if (autoBriefEl?.checked) generateBrief();

  feedEl.innerHTML = merged.length
    ? merged.map(renderTweet).join("")
    : `<div class="text-blue-500/50 text-sm">No results match your filters.</div>`;
}

window.fetchTweets = async function () {
  const q = document.getElementById("search").value || "crypto";
  try {
    const tweets = await fetchTweetsForQuery(q, {
      updateSeenAndNotify: tracking
    });

    feedEl.innerHTML = tweets.length
      ? tweets.map(renderTweet).join("")
      : `<div class="text-blue-500/50 text-sm">No results match your filters.</div>`;
  } catch (e) {
    feedEl.innerHTML = `<div class="text-red-400 text-sm">Error: ${e.message}</div>`;
  }
};

/* =========================
   RENDER TWEET
========================= */

function renderMedia(mediaItems) {
  if (!mediaItems || !mediaItems.length) return "";

  return mediaItems
    .map(m => {
      if (m.type === "photo" && m.url) {
        return `<img src="${m.url}" alt="tweet media"
          class="mt-2 rounded border border-blue-500/20 max-h-64 w-full object-cover"/>`;
      }

      if ((m.type === "video" || m.type === "animated_gif") && m.preview_image_url) {
        // Twitter API v2 doesn't serve video URLs directly on basic tier,
        // so we show the preview thumbnail with a play indicator
        return `
          <div class="relative mt-2">
            <img src="${m.preview_image_url}" alt="video thumbnail"
              class="rounded border border-blue-500/20 max-h-64 w-full object-cover"/>
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="bg-black/60 rounded-full w-12 h-12 flex items-center justify-center text-2xl">
                ▶
              </div>
            </div>
          </div>`;
      }

      return "";
    })
    .join("");
}

function renderTweet(t) {
  const verifiedBadge = t.verified
    ? `<span class="text-blue-400 ml-1" title="Verified">✓</span>`
    : "";

  const replyBadge = t.is_reply
    ? `<span class="text-yellow-500/60 text-xs ml-1">↩ reply</span>`
    : "";

  const quoteBadge = t.is_quote
    ? `<span class="text-purple-400/60 text-xs ml-1">❝ quote</span>`
    : "";

  return `
    <a href="${t.url}" target="_blank"
      class="block border border-blue-500/20 p-3 hover:bg-blue-500/10 transition-colors">

      <div class="flex justify-between items-start">
        <div>
          <div class="flex items-center gap-1">
            <span class="text-blue-100 font-semibold text-sm">${t.display_name || t.username}</span>
            ${verifiedBadge}
            ${replyBadge}
            ${quoteBadge}
          </div>
          <div class="text-blue-400 text-xs">@${t.username}</div>
          <div class="text-blue-600 text-xs">${timeAgo(t.created_at)}</div>
        </div>

        <div class="text-xs text-right text-blue-400 space-y-0.5">
          <div>❤ ${fmt(t.likes)}</div>
          <div>👥 ${fmt(t.followers)}</div>
        </div>
      </div>

      <div class="mt-2 text-blue-200 text-sm leading-relaxed">
        ${t.text}
      </div>

      ${renderMedia(t.media)}

    </a>
  `;
}

/* =========================
   INIT
========================= */

renderTrackers();