/**
 * Twitter/X Thread Scraper
 * Fetches threads from Twitter/X API and saves them as .md files in ./docs/
 * Run standalone: node twitter-scraper.js
 * Or imported by bot.js for scheduled auto-reload
 */

require("dotenv").config();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const DOCS_FOLDER = path.join(__dirname, "docs");
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

// ─── Thread URLs to track ─────────────────────────────────────────────────────
// Add Twitter/X thread URLs here or in .env as TWITTER_THREAD_URLS=url1,url2
const THREAD_URLS = process.env.TWITTER_THREAD_URLS
  ? process.env.TWITTER_THREAD_URLS.split(",").map((u) => u.trim())
  : [];

// ─── Account timelines to track ───────────────────────────────────────────────
// Add X/Twitter usernames in .env as TWITTER_ACCOUNTS=humntech,humnpassport,waapxyz
const TWITTER_ACCOUNTS = process.env.TWITTER_ACCOUNTS
  ? process.env.TWITTER_ACCOUNTS.split(",").map((u) => u.trim().replace(/^@/, ""))
  : [];

// How many recent tweets to fetch per account (max 100 on free tier)
const TWEETS_PER_ACCOUNT = parseInt(process.env.TWEETS_PER_ACCOUNT || "50");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Extract tweet ID from a Twitter/X URL
function extractTweetId(url) {
  const match = url.match(/status\/(\d+)/);
  return match ? match[1] : null;
}

// Sanitize a string for use as a filename
function toFilename(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Fetch a tweet and its full thread via Twitter API v2
async function fetchThread(tweetId) {
  if (!TWITTER_BEARER_TOKEN) {
    throw new Error(
      "TWITTER_BEARER_TOKEN is not set in .env. See README for instructions."
    );
  }

  // Fetch the root tweet
  const rootRes = await fetch(
    `https://api.twitter.com/2/tweets/${tweetId}?` +
      new URLSearchParams({
        "tweet.fields": "author_id,conversation_id,created_at,text",
        expansions: "author_id",
        "user.fields": "name,username",
      }),
    {
      headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
    }
  );

  if (!rootRes.ok) {
    const err = await rootRes.text();
    throw new Error(`Twitter API error (${rootRes.status}): ${err}`);
  }

  const rootData = await rootRes.json();
  if (rootData.errors) {
    throw new Error(`Twitter API: ${rootData.errors[0].detail}`);
  }

  const rootTweet = rootData.data;
  const author = rootData.includes?.users?.[0];
  const conversationId = rootTweet.conversation_id;

  // Fetch all tweets in the conversation by the same author (the thread)
  const threadRes = await fetch(
    `https://api.twitter.com/2/tweets/search/recent?` +
      new URLSearchParams({
        query: `conversation_id:${conversationId} from:${author.username} to:${author.username}`,
        "tweet.fields": "author_id,conversation_id,created_at,text,in_reply_to_user_id",
        max_results: "100",
      }),
    {
      headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
    }
  );

  const threadData = threadRes.ok ? await threadRes.json() : { data: [] };

  // Combine root tweet + replies, sorted by creation time
  const allTweets = [rootTweet, ...(threadData.data || [])].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  // Deduplicate by id
  const seen = new Set();
  const tweets = allTweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return { tweets, author, rootTweet };
}

// Convert a thread to markdown
function threadToMarkdown(tweets, author, sourceUrl) {
  const date = new Date(tweets[0].created_at).toISOString().split("T")[0];
  const header = `# Thread by @${author.username} (${author.name})
**Source:** ${sourceUrl}
**Date:** ${date}
**Tweets:** ${tweets.length}

---

`;
  const body = tweets
    .map((t, i) => `**[${i + 1}/${tweets.length}]** ${t.text}`)
    .join("\n\n");

  return header + body + "\n";
}

// Save a thread as a .md file in the docs folder
async function saveThread(url) {
  const tweetId = extractTweetId(url);
  if (!tweetId) {
    console.error(`[Scraper] Invalid Twitter URL: ${url}`);
    return null;
  }

  console.log(`[Scraper] Fetching thread: ${url}`);
  const { tweets, author, rootTweet } = await fetchThread(tweetId);

  const slug = toFilename(`twitter-${author.username}-${tweetId}`);
  const filename = `${slug}.md`;
  const filepath = path.join(DOCS_FOLDER, filename);

  const markdown = threadToMarkdown(tweets, author, url);
  fs.mkdirSync(DOCS_FOLDER, { recursive: true });
  fs.writeFileSync(filepath, markdown, "utf8");

  console.log(
    `[Scraper] Saved ${tweets.length} tweets → docs/${filename}`
  );
  return filename;
}

// Fetch recent tweets from a single account timeline
async function fetchAccountTimeline(username) {
  if (!TWITTER_BEARER_TOKEN) {
    throw new Error("TWITTER_BEARER_TOKEN is not set in .env.");
  }

  // First resolve username → user ID
  const userRes = await fetch(
    `https://api.twitter.com/2/users/by/username/${username}?user.fields=name,username`,
    { headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` } }
  );
  if (!userRes.ok) throw new Error(`User lookup failed (${userRes.status})`);
  const userData = await userRes.json();
  if (userData.errors) throw new Error(userData.errors[0].detail);
  const user = userData.data;

  // Fetch recent tweets (excludes replies and retweets for cleaner content)
  const tweetsRes = await fetch(
    `https://api.twitter.com/2/users/${user.id}/tweets?` +
      new URLSearchParams({
        max_results: String(Math.min(TWEETS_PER_ACCOUNT, 100)),
        "tweet.fields": "created_at,text",
        exclude: "retweets,replies",
      }),
    { headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` } }
  );
  if (!tweetsRes.ok) throw new Error(`Timeline fetch failed (${tweetsRes.status})`);
  const tweetsData = await tweetsRes.json();

  return { user, tweets: tweetsData.data || [] };
}

// Save an account timeline as a .md file in docs/
async function saveAccountTimeline(username) {
  console.log(`[Scraper] Fetching timeline: @${username}`);
  const { user, tweets } = await fetchAccountTimeline(username);

  if (!tweets.length) {
    console.log(`[Scraper] No tweets found for @${username}`);
    return null;
  }

  const filename = `twitter-account-${username.toLowerCase()}.md`;
  const filepath = path.join(DOCS_FOLDER, filename);
  const date = new Date().toISOString().split("T")[0];

  const header = `# @${user.username} (${user.name}) — Recent Tweets
**Last updated:** ${date}
**Tweets fetched:** ${tweets.length}

---

`;
  const body = tweets
    .map((t) => {
      const d = new Date(t.created_at).toISOString().split("T")[0];
      return `**[${d}]** ${t.text}`;
    })
    .join("\n\n");

  fs.mkdirSync(DOCS_FOLDER, { recursive: true });
  fs.writeFileSync(filepath, header + body + "\n", "utf8");
  console.log(`[Scraper] Saved ${tweets.length} tweets → docs/${filename}`);
  return filename;
}

// Scrape all configured account timelines
async function scrapeAllAccounts() {
  if (!TWITTER_ACCOUNTS.length) return [];
  const results = [];
  for (const username of TWITTER_ACCOUNTS) {
    try {
      const filename = await saveAccountTimeline(username);
      if (filename) results.push(filename);
    } catch (err) {
      console.error(`[Scraper] Failed for @${username}:`, err.message);
    }
  }
  console.log(`[Scraper] Accounts done. ${results.length}/${TWITTER_ACCOUNTS.length} saved.`);
  return results;
}

// Scrape all configured thread URLs
async function scrapeAllThreads() {
  if (!THREAD_URLS.length) {
    console.log("[Scraper] No TWITTER_THREAD_URLS configured — skipping.");
    return [];
  }

  const results = [];
  for (const url of THREAD_URLS) {
    try {
      const filename = await saveThread(url);
      if (filename) results.push(filename);
    } catch (err) {
      console.error(`[Scraper] Failed for ${url}:`, err.message);
    }
  }

  console.log(
    `[Scraper] Done. ${results.length}/${THREAD_URLS.length} threads saved.`
  );
  return results;
}

// Scrape everything — threads + account timelines
async function scrapeAll() {
  await scrapeAllThreads();
  await scrapeAllAccounts();
}

// ─── Run standalone ───────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeAll().catch(console.error);
}

module.exports = { scrapeAllThreads: scrapeAll };
