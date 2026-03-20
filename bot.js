/**
 * Discord AI Support Bot
 * Automatically answers member inquiries using your docs & website content
 *
 * Setup:
 * 1. npm install discord.js @anthropic-ai/sdk node-fetch cheerio dotenv
 * 2. Create a .env file (see .env.example)
 * 3. node bot.js
 */

require("dotenv").config();
const { Client, GatewayIntentBits, Events } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
// Load Twitter scraper only if the file exists (optional feature)
let scrapeAllThreads = async () => {};
try {
  ({ scrapeAllThreads } = require("./twitter-scraper"));
} catch {
  // twitter-scraper.js not present — Twitter thread scraping disabled
}

// ─── Configuration ────────────────────────────────────────────────────────────

// Roles that the bot will never respond to (case-insensitive)
const IGNORED_ROLES = process.env.IGNORED_ROLES
  ? process.env.IGNORED_ROLES.split(",").map((r) => r.trim().toLowerCase())
  : [];

// Channels where IGNORED_ROLES are bypassed — bot responds to everyone here
const BYPASS_ROLES_CHANNELS = process.env.BYPASS_ROLES_CHANNELS
  ? process.env.BYPASS_ROLES_CHANNELS.split(",").map((c) => c.trim())
  : [];

const CONFIG = {
  // Channels where the bot will auto-respond (leave empty [] to respond everywhere)
  activeChannels: process.env.ACTIVE_CHANNELS
    ? process.env.ACTIVE_CHANNELS.split(",")
    : [],

  // Only respond to messages that contain these keywords (leave empty to respond to all)
  triggerKeywords: process.env.TRIGGER_KEYWORDS
    ? process.env.TRIGGER_KEYWORDS.split(",")
    : [],

  // Bot won't respond to messages shorter than this (avoids reacting to "lol", "ok", etc.)
  minMessageLength: parseInt(process.env.MIN_MESSAGE_LENGTH || "15"),

  // Add a typing indicator before responding
  showTyping: true,

  // Prefix the bot uses to reply (set to "" for no prefix)
  replyPrefix: "",

  // Max tokens for the AI response
  maxTokens: 800,
};

// ─── Knowledge Base ───────────────────────────────────────────────────────────

class KnowledgeBase {
  constructor() {
    this.docs = [];
    this.websiteCache = new Map();
    this.lastRefreshed = null;
  }

  // Load plain text / markdown files from a folder
  loadDocsFolder(folderPath) {
    if (!fs.existsSync(folderPath)) {
      console.log(`[KB] Docs folder not found: ${folderPath}`);
      return;
    }
    const files = fs
      .readdirSync(folderPath)
      .filter((f) => /\.(txt|md|mdx|json)$/.test(f));
    for (const file of files) {
      const content = fs.readFileSync(path.join(folderPath, file), "utf8");
      this.docs.push({ source: file, content: content.slice(0, 8000) });
      console.log(`[KB] Loaded doc: ${file}`);
    }
  }

  // Extract clean text from HTML, stripping nav/sidebar noise
  extractText(html, url) {
    const $ = cheerio.load(html);
    $("script, style, nav, footer, header, aside, noscript, iframe, [role=navigation], [role=banner], [role=complementary], .sidebar, .nav, .navbar, .menu, .toc, .breadcrumb").remove();
    let text = "";
    const semantic = $("main, article, [role=main], .content, .docs-content, .markdown, #content, #main, .nextra-content").text();
    text = semantic.trim().length > 200 ? semantic : $("body").text();
    return text.replace(/\s+/g, " ").trim();
  }

  // Scrape a single URL and return { source, content }
  async scrapeWebsite(url) {
    if (this.websiteCache.has(url)) return this.websiteCache.get(url);
    try {
      console.log(`[KB] Scraping: ${url}`);
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout: 15000,
      });
      const html = await res.text();
      let text = this.extractText(html, url).slice(0, 8000);
      const wordCount = text.split(" ").length;
      if (wordCount < 80) {
        console.warn(`[KB] WARNING: Only ${wordCount} words from ${url} — likely JS-rendered or nav-only`);
      } else {
        console.log(`[KB] Scraped ${wordCount} words from ${url}`);
      }
      this.websiteCache.set(url, { source: url, content: text });
      return { source: url, content: text };
    } catch (err) {
      console.error(`[KB] Failed to scrape ${url}:`, err.message);
      return null;
    }
  }

  // Skip URLs that are unlikely to have useful content
  shouldSkipUrl(url) {
    return /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|css|js|woff|woff2|ttf)$/i.test(url) ||
      /\/api\/|\/auth\/|\/login|\/logout|\/signup|\/oauth|\/cdn-cgi\//.test(url) ||
      /#/.test(url);
  }

  // Extract all internal links from an HTML page
  extractLinks(html, rootUrl) {
    const $ = cheerio.load(html);
    const base = new URL(rootUrl);
    const links = [];
    $("a[href]").each((_, el) => {
      try {
        const href = new URL($(el).attr("href"), rootUrl);
        href.hash = "";
        href.search = "";
        if (href.hostname === base.hostname && !this.shouldSkipUrl(href.href)) {
          links.push(href.href);
        }
      } catch {}
    });
    return [...new Set(links)];
  }

  // Full site crawl — follows links recursively up to maxPages
  async crawlWebsite(rootUrl, maxPages) {
    const queue = [rootUrl];
    const seen = new Set([rootUrl]);
    const results = [];

    console.log(`[KB] Starting full crawl of ${rootUrl} (max ${maxPages} pages)`);

    while (queue.length > 0 && results.length < maxPages) {
      const url = queue.shift();
      const result = await this.scrapeWebsite(url);

      if (result) {
        const words = result.content.split(" ").length;
        if (words >= 50) results.push(result); // skip near-empty pages
      }

      // Discover new links from this page
      try {
        const res = await fetch(url, { timeout: 10000 });
        const html = await res.text();
        const links = this.extractLinks(html, rootUrl);
        for (const link of links) {
          if (!seen.has(link)) {
            seen.add(link);
            queue.push(link);
          }
        }
      } catch {}
    }

    console.log(`[KB] Crawl complete: ${results.length} pages scraped from ${rootUrl} (${seen.size} total discovered)`);
    return results;
  }

  // Load multiple URLs from config — full crawl of each site
  async loadWebsites(urls) {
    const maxPages = parseInt(process.env.MAX_PAGES_PER_SITE || "50");
    for (const url of urls) {
      const results = await this.crawlWebsite(url, maxPages);
      for (const r of results) {
        if (!this.docs.find((d) => d.source === r.source)) {
          this.docs.push(r);
        }
      }
    }
    this.lastRefreshed = new Date();
  }

  // Refresh website cache (call this periodically)
  async refresh(urls) {
    this.websiteCache.clear();
    this.docs = this.docs.filter((d) => !d.source.startsWith("http"));
    await this.loadWebsites(urls);
    console.log(`[KB] Refreshed at ${new Date().toLocaleTimeString()}`);
  }

  // Build context string for the AI prompt
  buildContext(maxLength = 40000) {
    let context = "";
    for (const doc of this.docs) {
      const block = `\n\n--- Source: ${doc.source} ---\n${doc.content}`;
      if (context.length + block.length > maxLength) break;
      context += block;
    }
    return context;
  }
}

// ─── AI Responder ─────────────────────────────────────────────────────────────

class AIResponder {
  constructor(knowledgeBase) {
    this.kb = knowledgeBase;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.conversationHistory = new Map(); // userId → message array
  }

  async answer(userId, question) {
    const context = this.kb.buildContext();

    // Build or retrieve per-user conversation history (last 6 exchanges)
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    const history = this.conversationHistory.get(userId);
    history.push({ role: "user", content: question });
    if (history.length > 12) history.splice(0, 2); // trim to last 6 exchanges

    const systemPrompt = `You are a helpful assistant in this Discord community. Answer questions in a natural, friendly, and conversational way — like a knowledgeable community member, not a formal support agent.

TONE RULES:
- Keep replies short and to the point. 1–3 sentences is ideal. Only go longer if the answer genuinely needs it.
- Sound natural and human. Avoid robotic phrasing, bullet points for simple answers, or corporate-sounding language.
- Use bullet points ONLY for multi-step instructions where order matters. Never for simple factual answers.
- No filler phrases like "Great question!", "Certainly!", or "I hope this helps!"
- Match the casual tone of Discord — it's okay to be a little informal.

ACCURACY RULES:
- Answer ONLY from the knowledge base below. Do not guess or use outside knowledge.
- If the answer is not in the knowledge base, reply with exactly: NO_ANSWER
- Do NOT mention the knowledge base, documents, or sources — just answer directly.
- Do NOT suggest contacting a moderator — just reply NO_ANSWER if you don't know.

KNOWLEDGE BASE:
${context || "NO_ANSWER"}`;

    try {
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: CONFIG.maxTokens,
        system: systemPrompt,
        messages: history,
      });

      const answer = response.content[0].text.trim();

      // If the AI signals no answer found, return null — bot stays silent
      if (answer === "NO_ANSWER" || answer.startsWith("NO_ANSWER")) {
        console.log("[BOT] No answer found in knowledge base — staying silent.");
        // Roll back the user message from history since we won't reply
        history.pop();
        return null;
      }

      history.push({ role: "assistant", content: answer });
      return answer;
    } catch (err) {
      console.error("[AI] Error:", err.message);
      return null; // Stay silent on errors too
    }
  }
}

// ─── Bot Setup ────────────────────────────────────────────────────────────────

async function main() {
  // 1. Init knowledge base
  const kb = new KnowledgeBase();

  // Scrape Twitter threads into docs/ before loading
  await scrapeAllThreads();

  // Load local docs folder (create a ./docs folder and put .txt or .md files there)
  kb.loadDocsFolder(path.join(__dirname, "docs"));

  // Load websites (add your URLs here or in .env as WEBSITE_URLS=url1,url2)
  const websiteUrls = process.env.WEBSITE_URLS
    ? process.env.WEBSITE_URLS.split(",")
    : [];

  if (websiteUrls.length > 0) {
    await kb.loadWebsites(websiteUrls);
  }

  // Refresh website content every 6 hours
  if (websiteUrls.length > 0) {
    setInterval(() => kb.refresh(websiteUrls), 6 * 60 * 60 * 1000);
  }

  // Re-scrape Twitter threads + reload all docs every hour
  setInterval(async () => {
    console.log("[Bot] Hourly reload — scraping Twitter threads and reloading docs...");
    await scrapeAllThreads();
    kb.docs = [];
    kb.loadDocsFolder(path.join(__dirname, "docs"));
    if (websiteUrls.length > 0) await kb.refresh(websiteUrls);
    console.log(`[Bot] Reload complete. ${kb.docs.length} sources loaded.`);
  }, 60 * 60 * 1000);

  console.log(
    `[KB] Total knowledge sources: ${kb.docs.length} (${kb.docs.map((d) => d.source).join(", ")})`
  );

  // 2. Init AI responder
  const ai = new AIResponder(kb);

  // 3. Init Discord client
  const discord = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  discord.once(Events.ClientReady, (c) => {
    console.log(`\n✅ Bot ready! Logged in as ${c.user.tag}`);
    console.log(`   Active channels: ${CONFIG.activeChannels.join(", ") || "all"}`);
    console.log(`   Min message length: ${CONFIG.minMessageLength} chars\n`);
  });

  discord.on(Events.MessageCreate, async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Ignore Elite Volunteers and moderators — unless in a bypass channel
    const inBypassChannel =
      BYPASS_ROLES_CHANNELS.includes(message.channel.id) ||
      BYPASS_ROLES_CHANNELS.includes(message.channel.name);
    if (!inBypassChannel && message.member) {
      const memberRoles = message.member.roles.cache.map((r) => r.name.toLowerCase());
      const isIgnoredRole = IGNORED_ROLES.some((role) => memberRoles.includes(role));
      if (isIgnoredRole) return;
    }

    // Check channel restriction
    if (
      CONFIG.activeChannels.length > 0 &&
      !CONFIG.activeChannels.includes(message.channel.id) &&
      !CONFIG.activeChannels.includes(message.channel.name)
    )
      return;

    const content = message.content.trim();

    // Ignore very short messages
    if (content.length < CONFIG.minMessageLength) return;

    // Check keyword triggers
    if (CONFIG.triggerKeywords.length > 0) {
      const lower = content.toLowerCase();
      const hasKeyword = CONFIG.triggerKeywords.some((kw) =>
        lower.includes(kw.toLowerCase().trim())
      );
      if (!hasKeyword) return;
    }

    // Show typing indicator
    if (CONFIG.showTyping) {
      await message.channel.sendTyping();
    }

    console.log(
      `[BOT] Answering for ${message.author.username}: "${content.slice(0, 60)}..."`
    );

    const answer = await ai.answer(message.author.id, content);

    // Bot stays silent if no answer was found in the knowledge base
    if (!answer) return;

    const reply = CONFIG.replyPrefix + answer;

    // Discord has a 2000 char limit — split if needed
    if (reply.length <= 2000) {
      await message.reply(reply);
    } else {
      const chunks = reply.match(/.{1,1990}/gs) || [reply];
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    }
  });

  // Admin command: !kb-reload (for admins to refresh knowledge base manually)
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.trim() !== "!kb-reload") return;
    const member = message.member;
    const isOwner = message.guild && message.guild.ownerId === message.author.id;
    if (!member || (!member.permissions.has("ManageGuild") && !isOwner)) return;

    await message.reply("Refreshing knowledge base...");
    await scrapeAllThreads();
    kb.docs = [];
    kb.loadDocsFolder(path.join(__dirname, "docs"));
    if (websiteUrls.length > 0) await kb.refresh(websiteUrls);
    await message.reply(
      `Done! Loaded ${kb.docs.length} sources: ${kb.docs.map((d) => d.source).join(", ")}`
    );
  });

  // Admin command: !kb-status (shows each source and how much content was captured)
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.trim() !== "!kb-status") return;
    const member = message.member;
    const isOwner = message.guild && message.guild.ownerId === message.author.id;
    if (!member || (!member.permissions.has("ManageGuild") && !isOwner)) return;

    if (!kb.docs.length) {
      await message.reply("No knowledge sources loaded.");
      return;
    }

    const lines = kb.docs.map((doc) => {
      const words = doc.content.trim().split(/\s+/).length;
      const preview = doc.content.trim().slice(0, 80).replace(/\n/g, " ");
      const status = words < 50 ? "⚠️ very little content" : "✅";
      return `${status} **${doc.source}** — ${words} words\n> ${preview}...`;
    });

    const header = `**Knowledge base: ${kb.docs.length} sources loaded**\n\n`;
    const body = lines.join("\n\n");
    const full = header + body;

    // Split if over Discord's 2000 char limit
    if (full.length <= 2000) {
      await message.reply(full);
    } else {
      const chunks = full.match(/.{1,1990}/gs) || [full];
      for (const chunk of chunks) await message.reply(chunk);
    }
  });

  // Admin command: !kb-threads (lists all scraped Twitter files with details)
  discord.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (message.content.trim() !== "!kb-threads") return;
    const member = message.member;
    const isOwner = message.guild && message.guild.ownerId === message.author.id;
    if (!member || (!member.permissions.has("ManageGuild") && !isOwner)) return;

    const docsFolder = path.join(__dirname, "docs");
    if (!fs.existsSync(docsFolder)) {
      await message.reply("No docs folder found — nothing has been scraped yet.");
      return;
    }

    // Find all twitter-related .md files in docs/
    const twitterFiles = fs
      .readdirSync(docsFolder)
      .filter((f) => f.startsWith("twitter-") && f.endsWith(".md"));

    if (!twitterFiles.length) {
      await message.reply(
        "No Twitter files found in docs/ yet.\nMake sure `TWITTER_ACCOUNTS` is set in your env vars and the bot has run at least once.\nYou can force a scrape now with `!kb-reload`."
      );
      return;
    }

    const lines = twitterFiles.map((filename) => {
      const filepath = path.join(docsFolder, filename);
      const raw = fs.readFileSync(filepath, "utf8");

      // Parse metadata from the file header
      const tweetCountMatch = raw.match(/\*\*Tweets fetched:\*\* (\d+)/);
      const lastUpdatedMatch = raw.match(/\*\*Last updated:\*\* ([\d-]+)/);
      const sourceMatch = raw.match(/\*\*Source:\*\* (.+)/);
      const titleMatch = raw.match(/^# (.+)/m);

      const tweetCount = tweetCountMatch ? tweetCountMatch[1] : "?";
      const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1] : "unknown";
      const source = sourceMatch ? sourceMatch[1].trim() : null;
      const title = titleMatch ? titleMatch[1].trim() : filename;

      const isAccount = filename.startsWith("twitter-account-");
      const icon = isAccount ? "🐦" : "🧵";
      const typeLabel = isAccount ? "account" : "thread";
      const sourceLine = source ? `\n> Source: ${source}` : "";

      return `${icon} **${title}** (${typeLabel})\n> ${tweetCount} tweets · last scraped ${lastUpdated}${sourceLine}`;
    });

    const header = `**Scraped Twitter content: ${twitterFiles.length} file${twitterFiles.length !== 1 ? "s" : ""}**\n\n`;
    const full = header + lines.join("\n\n");

    if (full.length <= 2000) {
      await message.reply(full);
    } else {
      const chunks = full.match(/.{1,1990}/gs) || [full];
      for (const chunk of chunks) await message.reply(chunk);
    }
  });

  await discord.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(console.error);
