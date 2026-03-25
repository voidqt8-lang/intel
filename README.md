# Intel (Reddit + X) Bot

Intel console dashboard that fetches signals from **Reddit** and **X (Twitter)** and generates an **AI Intel Brief** for memecoin trading narratives (watch/monitor, not financial advice).

## Prerequisites
- Node.js (tested with Node 24+)
- A GitHub token for your own use (optional)
- An OpenAI API key (for Intel Brief)
- A Twitter/X API Bearer token (for X search)

## Setup
1. Install dependencies:
   - `npm install`
2. Create a `.env` file in this folder:
   - `OPENAI_API_KEY=your_openai_key`
   - `TWITTER_BEARER_TOKEN=your_twitter_bearer_token`

## Run
Start the server:
- `node server.js`

Open in browser:
- `http://localhost:3001/`

## Pages
- `http://localhost:3001/` : Main menu
- `http://localhost:3001/reddit.html` : Reddit intel feed + Intel Brief
- `http://localhost:3001/twitter.html` : X intel feed (tracking) + Intel Brief
- `http://localhost:3001/ai-coin.html` : AI Coin generator

## Notes
- `.env` and `node_modules/` are ignored by git (via `.gitignore`), so you can safely commit code.
- The AI features require `OPENAI_API_KEY`.

