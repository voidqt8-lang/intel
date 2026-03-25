require("dotenv").config();
console.log("Token loaded:", process.env.TWITTER_BEARER_TOKEN ? "YES - " + process.env.TWITTER_BEARER_TOKEN.slice(0, 10) + "..." : "NO - token is undefined");

const BEARER = process.env.TWITTER_BEARER_TOKEN;

async function test() {
  const res = await fetch(
    "https://api.twitter.com/2/tweets/search/recent?query=python&max_results=10&tweet.fields=public_metrics,created_at,author_id",
    { headers: { Authorization: `Bearer ${BEARER}` } }
  );

  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

test();