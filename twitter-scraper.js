/**
 * Twitter/X Scraper — uses free Nitter RSS feeds (no API key needed)
 * Nitter is an open-source Twitter front-end that exposes RSS feeds publicly.
 * Fetches latest tweets from configured accounts and saves them as .md in ./docs/
 */

require("dotenv").config();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

const DOCS_FOLDER = path.join(__dirname, "docs");

// ─── Config ───────────────────────────────────────────────────────────────────

const TWITTER_ACCOUNTS = process.env.TWITTER_ACCOUNTS
  ? process.env.TWITTER_ACCOUNTS.split(",").map((u) => u.trim().replace(/^@/, ""))
  : [];

const THREAD_URLS = process.env.TWITTER_THREAD_URLS
  ? process.env.TWITTER_THREAD_URLS.split(",").map((u) => u.trim())
  : [];

// Public Nitter instances — tried in order until one works
// List kept large since instances go offline frequently
const NITTER_INSTANCES = [
  "https://nitter.net",
  "https://nitter.privacydev.net",
  "https://nitter.poast.org",
  "https://nitter.1d4.us",
  "https://nitter.tiekoetter.com",
  "https://nitter.fdn.fr",
  "https://nitter.it",
  "https://nitter.nl",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeFilename(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function parseRSS(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m) => {
    const titleMatch = m[1].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/);
    const dateMatch = m[1].match(/<pubDate>(.*?)<\/pubDate>/);
    const text = titleMatch
      ? titleMatch[1].trim()
      : m[1].match(/<title>(.*?)<\/title>/)?.[1]?.trim() || "";
    const date = dateMatch ? new Date(dateMatch[1]).toISOString().split("T")[0] : "";
    return { date, text };
  }).filter((t) => t.text.length > 0);
}

async function fetchNitterRSS(username) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/${username}/rss`;
      console.log(`[Scraper] Trying ${url}`);
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)" },
        timeout: 10000,
      });
      if (!res.ok) {
        console.log(`[Scraper] ${instance} returned HTTP ${res.status} — trying next`);
        continue;
      }
      const xml = await res.text();
      if (!xml.includes("<rss") && !xml.includes("<feed")) {
        console.log(`[Scraper] ${instance} returned non-RSS content — trying next`);
        continue;
      }
      const tweets = parseRSS(xml);
      if (tweets.length > 0) {
        console.log(`[Scraper] @${username} — got ${tweets.length} tweets via ${instance}`);
        return tweets;
      }
      console.log(`[Scraper] ${instance} returned RSS but 0 tweets — trying next`);
    } catch (err) {
      console.log(`[Scraper] ${instance} error: ${err.message} — trying next`);
    }
  }
  console.warn(`[Scraper] All Nitter instances failed for @${username}.`);
  console.warn(`[Scraper] Tip: Add tweet content manually to docs/twitter-${username}.md`);
  return [];
}

async function saveAccountTimeline(username) {
  console.log(`[Scraper] Fetching timeline: @${username}`);
  const tweets = await fetchNitterRSS(username);
  if (!tweets.length) return null;

  const filename = `twitter-account-${sanitizeFilename(username)}.md`;
  const date = new Date().toISOString().split("T")[0];
  const header = `# @${username} — Recent Tweets\n**Last updated:** ${date}\n**Tweets fetched:** ${tweets.length}\n\n---\n\n`;
  const body = tweets.map((t) => `**[${t.date}]** ${t.text}`).join("\n\n");

  fs.mkdirSync(DOCS_FOLDER, { recursive: true });
  fs.writeFileSync(path.join(DOCS_FOLDER, filename), header + body + "\n", "utf8");
  console.log(`[Scraper] Saved ${tweets.length} tweets -> docs/${filename}`);
  return filename;
}

async function saveThread(threadUrl) {
  const tweetPath = threadUrl.replace(/https?:\/\/(x|twitter)\.com/, "");
  let tweets = [];

  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetch(`${instance}${tweetPath}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RSSBot/1.0)" },
        timeout: 10000,
      });
      if (!res.ok) continue;
      const html = await res.text();
      const matches = [...html.matchAll(/class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)];
      tweets = matches
        .map((m, i) => ({
          date: new Date().toISOString().split("T")[0],
          text: m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
        }))
        .filter((t) => t.text.length > 10);
      if (tweets.length > 0) break;
    } catch (_) {
      // Try next instance
    }
  }

  if (!tweets.length) {
    console.warn(`[Scraper] Could not fetch thread: ${threadUrl}`);
    return null;
  }

  const idMatch = threadUrl.match(/status\/(\d+)/);
  const filename = `${sanitizeFilename(`twitter-thread-${idMatch?.[1] || Date.now()}`)}.md`;
  const header = `# Twitter Thread\n**Source:** ${threadUrl}\n\n---\n\n`;
  const body = tweets.map((t, i) => `**[${i + 1}/${tweets.length}]** ${t.text}`).join("\n\n");

  fs.mkdirSync(DOCS_FOLDER, { recursive: true });
  fs.writeFileSync(path.join(DOCS_FOLDER, filename), header + body + "\n", "utf8");
  console.log(`[Scraper] Saved thread -> docs/${filename}`);
  return filename;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function scrapeAllThreads() {
  const results = [];

  for (const username of TWITTER_ACCOUNTS) {
    try {
      const f = await saveAccountTimeline(username);
      if (f) results.push(f);
    } catch (err) {
      console.error(`[Scraper] Failed for @${username}:`, err.message);
    }
  }

  for (const url of THREAD_URLS) {
    try {
      const f = await saveThread(url);
      if (f) results.push(f);
    } catch (err) {
      console.error(`[Scraper] Failed for thread ${url}:`, err.message);
    }
  }

  if (!TWITTER_ACCOUNTS.length && !THREAD_URLS.length) {
    console.log("[Scraper] No TWITTER_ACCOUNTS or TWITTER_THREAD_URLS configured — skipping.");
  } else {
    console.log(`[Scraper] Done. ${results.length} files saved.`);
  }

  return results;
}

if (require.main === module) {
  scrapeAllThreads().catch(console.error);
}

module.exports = { scrapeAllThreads };
