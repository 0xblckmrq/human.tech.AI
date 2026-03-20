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

// ─── Configuration ────────────────────────────────────────────────────────────

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

  // Scrape text content from a URL
  async scrapeWebsite(url) {
    if (this.websiteCache.has(url)) return this.websiteCache.get(url);
    try {
      console.log(`[KB] Scraping: ${url}`);
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SupportBot/1.0)" },
        timeout: 10000,
      });
      const html = await res.text();
      const $ = cheerio.load(html);
      // Remove noise
      $("script, style, nav, footer, header, aside, .nav, .footer").remove();
      const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 8000);
      this.websiteCache.set(url, { source: url, content: text });
      return { source: url, content: text };
    } catch (err) {
      console.error(`[KB] Failed to scrape ${url}:`, err.message);
      return null;
    }
  }

  // Load multiple URLs from config
  async loadWebsites(urls) {
    const results = await Promise.all(urls.map((u) => this.scrapeWebsite(u)));
    for (const r of results) {
      if (r) this.docs.push(r);
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
  buildContext(maxLength = 12000) {
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

    const systemPrompt = `You are a friendly and knowledgeable support assistant for this Discord community.
Use ONLY the knowledge base below to answer questions. If the answer isn't there, say so honestly and suggest the user contact a human moderator or admin.
Keep responses concise (2–4 sentences ideally). Use bullet points for steps. Never make up information.
Do NOT mention that you're looking at documents or a knowledge base — just answer naturally.

KNOWLEDGE BASE:
${context || "No knowledge base loaded yet. Ask an admin to configure sources."}`;

    try {
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: CONFIG.maxTokens,
        system: systemPrompt,
        messages: history,
      });

      const answer = response.content[0].text;
      history.push({ role: "assistant", content: answer });
      return answer;
    } catch (err) {
      console.error("[AI] Error:", err.message);
      return "Sorry, I ran into an issue answering that. Please try again or ask a moderator!";
    }
  }
}

// ─── Bot Setup ────────────────────────────────────────────────────────────────

async function main() {
  // 1. Init knowledge base
  const kb = new KnowledgeBase();

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
    if (!member || !member.permissions.has("ManageGuild")) return;

    await message.reply("Refreshing knowledge base...");
    await kb.refresh(websiteUrls);
    await message.reply(
      `Done! Loaded ${kb.docs.length} sources: ${kb.docs.map((d) => d.source).join(", ")}`
    );
  });

  await discord.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch(console.error);
