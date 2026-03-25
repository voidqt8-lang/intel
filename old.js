require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// =====================
// REDDIT PROXY
// =====================
app.get("/reddit/:sub/:sort", async (req, res) => {
  const { sub, sort } = req.params;

  const url = `https://www.reddit.com/r/${sub}/${sort}.json?limit=100&raw_json=1`;

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "intel-terminal/1.0" }
    });

    if (!r.ok) return res.status(r.status).json({ error: "Reddit error" });

    const data = await r.json();

    const posts = (data.data?.children || []).map(c => {
      const p = c.data;

      return {
        id: p.id,
        title: p.title,
        author: "u/" + p.author,
        subreddit: "r/" + p.subreddit,
        flair: p.link_flair_text || "",
        upvotes: p.ups,
        ratio: p.upvote_ratio,
        comments: p.num_comments,
        createdUtc: p.created_utc,
        url: "https://reddit.com" + p.permalink,

        thumbnail: p.thumbnail,
        preview: p.preview
      };
    });

    res.json({ posts });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// AI COIN GENERATOR
// =====================
app.post("/ai/coin", async (req, res) => {
  try {
    const { title, subreddit, flair } = req.body;

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
${title}
${subreddit}
${flair}
`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9
    });

    res.json(JSON.parse(response.choices[0].message.content));

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3001, () =>
  console.log("Running on http://localhost:3001")
);