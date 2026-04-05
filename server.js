require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();

app.use(express.static("frontend"));
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function isSafeSubredditName(s) {
  // Reddit "subreddit" path segment; avoid slashes and obvious injection.
  return typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function extractJsonObject(text) {
  // Best-effort extraction in case the model returns surrounding text.
  if (typeof text !== "string") return null;
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const candidate = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(candidate);
}

/* =====================
   REDDIT
===================== */
app.get("/reddit/:sub/:sort", async (req, res) => {
  const { sub, sort } = req.params;

  try {
    if (!isSafeSubredditName(sub)) {
      return res.status(400).json({ error: "Invalid subreddit name" });
    }

    const allowedSort = new Set(["hot", "top", "new"]);
    if (!allowedSort.has(sort)) {
      return res.status(400).json({ error: "Invalid sort (use hot|top|new)" });
    }

    const r = await fetchWithTimeout(
      `https://www.reddit.com/r/${sub}/${sort}.json?limit=100&raw_json=1`,
      { headers: { "User-Agent": "intel-terminal/1.0", "Accept-Language": "en-US,en;q=0.9" } },
      10000
    );

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res.status(r.status).json({
        error: "Reddit request failed",
        details: body.slice(0, 200) || undefined
      });
    }

    const data = await r.json();

    const posts = (data.data?.children || []).map(c => {
      const p = c.data || {};

      return {
        id: p.id,
        title: p.title,
        subreddit: p.subreddit,
        upvotes: p.ups,
        numComments: p.num_comments,
        selftext: typeof p.selftext === "string" ? p.selftext.slice(0, 900) : "",
        createdUtc: p.created_utc,
        url: "https://reddit.com" + p.permalink,
        preview: p.preview,
        thumbnail: p.thumbnail
      };
    });

    res.json({ posts });

  } catch (e) {
    if (e?.name === "AbortError") {
      return res.status(504).json({ error: "Reddit request timed out" });
    }
    res.status(500).json({ error: e.message || "Unknown error" });
  }
});

/* =====================
   TWITTER / X
===================== */
app.get("/twitter/search", async (req, res) => {
  const { q } = req.query;

  const pageSize = clampInt(req.query.limit, 10, 100, 100);
  const pages = clampInt(req.query.pages, 1, 5, 3);
  // Match UI time window: narrow at the API so results aren’t mostly outside the window.
  const windowHours = clampInt(req.query.window_hours, 1, 168, 24);
  const startTimeIso = new Date(Date.now() - windowHours * 3600000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  try {
    // Allow empty keyword scans by falling back to a broad, valid query.
    // Twitter requires at least one non-operator term in the query.
    const rawQuery = String(q || "").trim();
    const query = rawQuery || "the -is:retweet lang:en";

    const users = {};
    const media = {};
    const collected = [];
    const seenIds = new Set();
    let nextToken = null;

    for (let page = 0; page < pages; page++) {
      const url = new URL("https://api.twitter.com/2/tweets/search/recent");
      url.searchParams.set("query", query);
      url.searchParams.set("start_time", startTimeIso);
      url.searchParams.set("max_results", String(pageSize));
      url.searchParams.set(
        "tweet.fields",
        "public_metrics,created_at,referenced_tweets,attachments,in_reply_to_user_id"
      );
      url.searchParams.set(
        "expansions",
        "author_id,attachments.media_keys"
      );
      url.searchParams.set(
        "user.fields",
        "public_metrics,verified,username,name"
      );
      url.searchParams.set(
        "media.fields",
        "type,url,preview_image_url,public_metrics"
      );
      if (nextToken) url.searchParams.set("next_token", nextToken);

      const r = await fetchWithTimeout(
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
          }
        },
        15000
      );

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return res.status(r.status).json({
          error: "Twitter request failed",
          details: body.slice(0, 200) || undefined
        });
      }

      const data = await r.json();

      (data.includes?.users || []).forEach(u => {
        users[u.id] = u;
      });
      (data.includes?.media || []).forEach(m => {
        media[m.media_key] = m;
      });

      for (const t of data.data || []) {
        if (seenIds.has(t.id)) continue;
        seenIds.add(t.id);
        collected.push(t);
      }

      nextToken = data.meta?.next_token;
      if (!nextToken) break;
    }

    const tweets = collected.map(t => {
      const user = users[t.author_id] || {};

      const mediaRows = (t.attachments?.media_keys || [])
        .map(key => media[key])
        .filter(Boolean);

      const mediaViewSum = mediaRows.reduce(
        (acc, m) => acc + (Number(m.public_metrics?.view_count) || 0),
        0
      );

      const mediaItems = mediaRows.map(m => ({
        type: m.type,
        url: m.url || m.preview_image_url || null,
        preview_image_url: m.preview_image_url || null
      }));

      const pm = t.public_metrics || {};
      const imp = pm.impression_count;
      const twVc = pm.view_count;
      const fromTweet =
        imp != null && Number(imp) > 0
          ? Number(imp)
          : twVc != null && Number(twVc) > 0
            ? Number(twVc)
            : 0;

      let views = fromTweet;
      let views_estimated = false;

      if (!views && mediaViewSum > 0) {
        views = mediaViewSum;
      }

      if (!views) {
        const likes = Number(pm.like_count) || 0;
        const rts = Number(pm.retweet_count) || 0;
        const reps = Number(pm.reply_count) || 0;
        const quotes = Number(pm.quote_count) || 0;
        const eng = likes + rts * 3 + reps * 2 + quotes * 2;
        if (eng > 0) {
          // X usually omits real view counts on search; this maps engagement → a reach score
          // on the same order as the UI thresholds (1K, 5K, …). Old factor (×120) was far
          // too small, so MIN 1K filtered out almost every tweet.
          views = Math.round(eng * 1000);
          views_estimated = true;
        }
      }

      return {
        id: t.id,
        text: t.text,
        created_at: t.created_at,
        retweets: pm.retweet_count || 0,
        replies: pm.reply_count || 0,
        url: `https://twitter.com/${user.username || "i"}/status/${t.id}`,

        username: user.username || "unknown",
        display_name: user.name || "",
        followers: user.public_metrics?.followers_count || 0,
        verified: user.verified || false,
        impressions: pm.impression_count,
        views,
        views_estimated,

        is_quote: (t.referenced_tweets || []).some(r => r.type === "quoted"),
        is_reply: !!t.in_reply_to_user_id,

        media: mediaItems
      };
    });

    res.json({ tweets });

  } catch (e) {
    if (e?.name === "AbortError") {
      return res.status(504).json({ error: "Twitter request timed out" });
    }
    res.status(500).json({ error: e.message || "Unknown error" });
  }
});

/* =====================
   AI COIN
===================== */
app.post("/ai/coin", async (req, res) => {
  try {
    const { title, subreddit, flair } = req.body || {};

    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Missing required field: `title`" });
    }
    if (!isSafeSubredditName(subreddit)) {
      return res.status(400).json({ error: "Invalid subreddit name" });
    }

    const safeTitle = title.trim().slice(0, 240);
    const safeFlair = typeof flair === "string" ? flair.trim().slice(0, 80) : "";

    const prompt = `
Return STRICT JSON ONLY:

{
  "name": "...",
  "ticker": "...",
  "summary": "...",
  "meme_angle": "...",
  "why_it_might_go_viral": "..."
}

Post:
${safeTitle}
${subreddit}
${safeFlair ? `
Flair:
${safeFlair}` : ""}
`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      response_format: { type: "json_object" }
    });

    const content = response?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);

    if (!parsed) {
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    res.json(parsed);

  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
});

/* =====================
   INTEL BRIEF
===================== */
app.post("/intel/brief", async (req, res) => {
  try {
    const body = req.body || {};
    const platform = body.platform;
    const query = body.query;
    const windowHours = clampInt(body.windowHours, 1, 168, 24);
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const sources = Array.isArray(body.sources) ? body.sources : [];

    if (!["reddit", "twitter", "mixed"].includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }
    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "Missing required field: `query`" });
    }
    if (sources.length < 1) {
      return res.status(400).json({ error: "Missing required field: `sources`" });
    }

    const topSources = sources.slice(0, 10).map(s => {
      const url = typeof s.url === "string" ? s.url : "";
      const title = typeof s.title === "string" ? s.title.slice(0, 220) : "";
      const text = typeof s.text === "string" ? s.text.slice(0, 900) : "";
      const engagement =
        typeof s.engagement === "object" && s.engagement !== null ? s.engagement : {};
      const ageHours = clampInt(s.ageHours, 0, 999, 0);
      return { url, title, text, engagement, ageHours };
    });

    const safeQuery = query.trim().slice(0, 120);
    const safeTokens = tokens.map(t => String(t).trim()).filter(Boolean).slice(0, 8);

    const prompt = `
You are an "intel desk" assistant for memecoin traders.
Produce: narratives happening now, evidence-based risk signals, and watch-oriented next steps.
Constraints:
- Use ONLY the provided sources. If evidence is missing, say "unknown".
- Do NOT provide financial advice.
- Output MUST be valid JSON matching the schema.

Platform: ${platform}
Query: ${safeQuery}
Time window (hours): ${windowHours}
Tokens: ${safeTokens.join(", ") || "none"}

Sources (evidence):
${topSources
  .map((s, i) => {
    const evidenceText = [s.title ? `TITLE: ${s.title}` : "", s.text ? `TEXT: ${s.text}` : ""].filter(Boolean).join("\n");
    return `#${i + 1}\nURL: ${s.url}\nAGE_HOURS: ${s.ageHours}\nENGAGEMENT: ${JSON.stringify(s.engagement)}\nEVIDENCE:\n${evidenceText}`;
  })
  .join("\n\n")}

Return JSON:
{
  "summary": "string",
  "momentum": {
    "windowHours": number,
    "mentions": number,
    "trend": "up|flat|down|unknown",
    "signals": ["string"]
  },
  "narratives": [
    { "title": "string", "whyNow": "string", "confidence": number, "evidenceUrls": ["string"] }
  ],
  "risk": {
    "riskLevel": "low|medium|high",
    "overallScore": number,
    "redFlags": [
      { "label": "string", "why": "string", "evidenceUrls": ["string"] }
    ]
  },
  "nextSteps": ["string"],
  "disclaimer": "string"
}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      response_format: { type: "json_object" }
    });

    const content = response?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    if (!parsed) return res.status(500).json({ error: "AI returned invalid JSON" });

    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
});

app.listen(3001, () => {
  console.log("Server running on http://localhost:3001");
});