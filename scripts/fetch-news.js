import fs from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'ai-databricks-daily-bot/1.0 (+https://github.com)'
  }
});

const FEEDS = [
  {
    name: 'Databricks Engineering',
    category: 'Databricks',
    url: 'https://www.databricks.com/blog/category/engineering/feed.xml'
  },
  {
    name: 'Databricks Release Notes',
    category: 'Databricks',
    url: 'https://docs.databricks.com/aws/en/feed.xml'
  },
  {
    name: 'Hugging Face',
    category: 'AI',
    url: 'https://huggingface.co/blog/feed.xml'
  },
  {
    name: 'TechCrunch AI',
    category: 'AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/'
  },
  {
    name: 'Google News AI',
    category: 'AI',
    url: 'https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en'
  }
];

const MODEL_NEWS_FEED = {
  name: 'LLM Releases',
  category: 'LLM',
  url: 'https://news.google.com/rss/search?q=%22new+model%22+OR+%22LLM%22+release+OR+OpenAI+OR+Anthropic+OR+Gemini+OR+Llama&hl=en-US&gl=US&ceid=US:en'
};

const AI_TOPICS = [
  'Models & Research',
  'Agents & Coding',
  'Enterprise & Strategy',
  'Infrastructure & MLOps',
  'Policy & Safety'
];

const DAYS_BACK = 7;
const MAX_PER_SOURCE = 25;
const MAX_TOTAL_ITEMS = 120;
const MAX_AI_PER_RUN = 15;
const AI_DELAY_MS = 1500;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) return text || '';
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

function summarizeToTwoParagraphs(text, title) {
  if (!text) {
    return `${title}.\n\nOpen the original article below for the full coverage.`;
  }

  const sentences = (text.match(/[^.!?]+[.!?]+/g) || [text])
    .map((s) => s.trim())
    .filter((s) => s.length > 20)
    .slice(0, 6);

  if (sentences.length <= 2) {
    return truncate(sentences.join(' '), 550);
  }

  const mid = Math.ceil(sentences.length / 2);
  const p1 = sentences.slice(0, mid).join(' ');
  const p2 = sentences.slice(mid).join(' ');
  return `${truncate(p1, 320)}\n\n${truncate(p2, 320)}`;
}

function deriveInsights(title, text, source, category) {
  const combined = `${title} ${text}`.toLowerCase();

  if (source === 'Databricks Release Notes' || /release|runtime|delta|unity catalog|photon|sql/.test(combined)) {
    return {
      topic: null,
      importance: 7,
      whyItMatters:
        'Platform updates and release notes often introduce performance improvements, new SQL/Spark capabilities, or deprecations that impact production pipelines.',
      whoIsAffected:
        'Databricks Data Engineers, Lakehouse Architects, and Workspace Admins managing clusters, jobs, and governance.'
    };
  }

  if (category === 'Databricks') {
    return {
      topic: null,
      importance: 6,
      whyItMatters:
        'Highlights architectural patterns, benchmarks, and engineering practices for scaling data and AI workloads on the Lakehouse.',
      whoIsAffected:
        'Data Platform Teams, Analytics Engineers, and ML Engineers building on Databricks.'
    };
  }

  if (/agent|coding|copilot|mcp|tool[- ]use|developer|ide/.test(combined)) {
    return {
      topic: 'Agents & Coding',
      importance: 6,
      whyItMatters:
        'Advances in AI agents and coding tools directly accelerate software delivery and automate multi-step workflows.',
      whoIsAffected:
        'Software Engineers, AI App Developers, and Engineering Managers.'
    };
  }

  if (/gpu|inference|mlops|kubernetes|safetensors|quantiz|latency|cluster|vram/.test(combined)) {
    return {
      topic: 'Infrastructure & MLOps',
      importance: 5,
      whyItMatters:
        'Infrastructure and serving improvements lower compute costs and improve reliability for production AI workloads.',
      whoIsAffected:
        'MLOps Engineers, Cloud Architects, and Platform Teams.'
    };
  }

  if (/regulat|law|policy|copyright|antitrust|senate|eu ai act|safety/.test(combined)) {
    return {
      topic: 'Policy & Safety',
      importance: 6,
      whyItMatters:
        'Regulatory and policy shifts can create new compliance requirements, data-usage rules, and vendor risk considerations.',
      whoIsAffected:
        'Legal & Compliance Teams, CISOs, and Enterprise AI Governance Leaders.'
    };
  }

  if (/fund|raise|acqui|valuation|billion|million|partnership|enterprise|pricing/.test(combined)) {
    return {
      topic: 'Enterprise & Strategy',
      importance: 6,
      whyItMatters:
        'Major funding, M&A, and enterprise partnerships signal where capital and ecosystem momentum are consolidating.',
      whoIsAffected:
        'Technology Executives, Product Leaders, Vendors, and Investors tracking the AI market.'
    };
  }

  return {
    topic: 'Models & Research',
    importance: 5,
    whyItMatters:
      'Tracks fast-moving model capabilities, releases, and research shaping how AI is built and deployed.',
    whoIsAffected:
      'AI Builders, ML Engineers, and Product Teams evaluating new models and workflows.'
  };
}

async function loadExistingCache(outPath) {
  const cache = new Map();
  const isBroken = (it) =>
    /incomplete news item|insufficient|no excerpt/i.test(it.fullStory || '');

  try {
    const raw = await fs.readFile(outPath, 'utf8');
    const existing = JSON.parse(raw);
    for (const item of existing.items || []) {
      if (item.url && item.aiAnalyzed && !isBroken(item)) cache.set(item.url, item);
    }
    for (const item of existing.llmTracker?.modelNews || []) {
      if (item.url && item.aiAnalyzed && !isBroken(item)) cache.set(item.url, item);
    }
  } catch {
    // No existing cache yet
  }
  return cache;
}

async function fetchArticleText(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ai-databricks-daily-bot/1.0)' }
    });
    if (!res.ok) return '';
    const html = await res.text();
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
    return truncate(stripHtml(cleaned), 3000);
  } catch {
    return '';
  }
}

async function callGeminiJson(prompt) {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2
        }
      })
    }
  );

  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return JSON.parse(text);
}

async function analyzeWithGemini(item) {
  let contextText = item.rawText || '';
  if (contextText.length < 250 && item.url) {
    const pageText = await fetchArticleText(item.url);
    if (pageText.length > contextText.length) contextText = pageText;
  }

  if (contextText.length < 120) {
    throw new Error('Not enough article text to summarize');
  }

  const topicInstruction =
    item.category === 'Databricks'
      ? '- "topic": null'
      : `- "topic": Exactly one of: ${AI_TOPICS.map((t) => `"${t}"`).join(', ')}`;

  const prompt = `Analyze this tech/AI news item and return ONLY valid JSON with five keys:
- "fullStory": A clear 2-paragraph summary of what happened, separated by "\\n\\n". Never complain about missing text.
- "whyItMatters": 1-2 concise sentences explaining why this specific news matters.
- "whoIsAffected": 1 concise sentence naming the specific roles, teams, or users affected.
- "importance": Integer 1-10 (10 = major model release, Databricks LTS/platform launch, or industry-wide shift; 1-4 = minor blog post or niche benchmark).
${topicInstruction}

Source: ${item.source}
Category: ${item.category}
Title: ${item.title}
Article Text: ${contextText}`;

  const parsed = await callGeminiJson(prompt);
  if (!parsed.fullStory || !parsed.whyItMatters || !parsed.whoIsAffected) {
    throw new Error('Incomplete JSON from Gemini');
  }

  const validTopic =
    item.category === 'Databricks'
      ? null
      : AI_TOPICS.includes(parsed.topic)
        ? parsed.topic
        : item.topic;

  return {
    fullStory: parsed.fullStory.trim(),
    whyItMatters: parsed.whyItMatters.trim(),
    whoIsAffected: parsed.whoIsAffected.trim(),
    importance: Number(parsed.importance) || 5,
    topic: validTopic,
    summary: truncate(parsed.fullStory.replace(/\s+/g, ' '), 180)
  };
}

async function enrichItems(items, cache) {
  if (!GEMINI_API_KEY) {
    console.log('No GEMINI_API_KEY set; using built-in summaries.');
    return items.map(({ rawText, ...rest }) => rest);
  }

  let aiCalls = 0;
  let rateLimited = false;
  const enriched = [];

  for (const item of items) {
    const cached = cache.get(item.url);
    if (cached) {
      const { rawText, ...rest } = item;
      enriched.push({
        ...rest,
        summary: cached.summary || rest.summary,
        fullStory: cached.fullStory,
        whyItMatters: cached.whyItMatters,
        whoIsAffected: cached.whoIsAffected,
        importance: cached.importance ?? rest.importance ?? 5,
        topic: cached.topic ?? rest.topic,
        aiAnalyzed: true
      });
      continue;
    }

    if (!rateLimited && aiCalls < MAX_AI_PER_RUN) {
      try {
        const analysis = await analyzeWithGemini(item);
        aiCalls++;
        const { rawText, ...rest } = item;
        enriched.push({ ...rest, ...analysis, aiAnalyzed: true });
        await sleep(AI_DELAY_MS);
        continue;
      } catch (err) {
        console.warn(`Gemini skipped for "${item.title}": ${err.message}`);
        if (err.status === 429) rateLimited = true;
      }
    }

    const { rawText, ...rest } = item;
    enriched.push(rest);
  }

  console.log(`AI analyzed ${aiCalls} new articles (reused ${cache.size} cached).`);
  return enriched;
}

async function fetchFeed(feed, maxItems = MAX_PER_SOURCE) {
  const parsed = await parser.parseURL(feed.url);
  const cutoffMs = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

  return (parsed.items || [])
    .map((item) => {
      const dateStr = item.isoDate || item.pubDate;
      const parsedMs = dateStr ? Date.parse(dateStr) : NaN;
      const publishedMs = Number.isNaN(parsedMs) ? Date.now() : parsedMs;

      const cleanTitle = (item.title || 'Untitled').trim();
      const rawLong = item['content:encoded'] || item.content || item.contentSnippet || item.summary || '';
      const cleanLong = stripHtml(rawLong);
      const insights = deriveInsights(cleanTitle, cleanLong, feed.name, feed.category);

      return {
        title: cleanTitle,
        url: item.link || '',
        source: feed.name,
        category: feed.category,
        topic: insights.topic,
        importance: insights.importance,
        publishedAt: new Date(publishedMs).toISOString(),
        summary: truncate(cleanLong, 180),
        rawText: truncate(cleanLong, 1800),
        fullStory: summarizeToTwoParagraphs(cleanLong, cleanTitle),
        whyItMatters: insights.whyItMatters,
        whoIsAffected: insights.whoIsAffected,
        aiAnalyzed: false
      };
    })
    .filter((item) => item.url && Date.parse(item.publishedAt) >= cutoffMs)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, maxItems);
}

async function fetchTrendingModels() {
  try {
    const res = await fetch('https://huggingface.co/api/trending?type=model', {
      headers: { 'User-Agent': 'ai-databricks-daily-bot/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const rawList = data.recentlyTrending || data.models || [];
    return rawList
      .map((entry) => {
        const repo = entry.repoData || entry;
        const id = repo.id || repo.modelId || '';
        const tag = repo.pipeline_tag || '';
        return {
          id,
          tag,
          likes: repo.likes ?? null,
          downloads: repo.downloads ?? null
        };
      })
      .filter((m) => m.id && (!m.tag || m.tag === 'text-generation' || m.tag === 'image-text-to-text'))
      .slice(0, 10);
  } catch (err) {
    console.warn(`Warning: Failed to fetch Hugging Face trending models: ${err.message}`);
    return [];
  }
}

async function fetchOpenRouterRecentModels() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { 'User-Agent': 'ai-databricks-daily-bot/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    const cutoffSec = Math.floor((Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000) / 1000);
    return (json.data || [])
      .filter((m) => typeof m.created === 'number' && m.created >= cutoffSec)
      .sort((a, b) => b.created - a.created)
      .slice(0, 15)
      .map((m) => ({
        id: m.id || '',
        name: m.name || m.id || '',
        created: m.created,
        description: truncate(stripHtml(m.description || ''), 320)
      }));
  } catch (err) {
    console.warn(`Warning: Failed to fetch OpenRouter models: ${err.message}`);
    return [];
  }
}

async function buildRecentModelsList(modelNews, trendingModels, openRouterModels) {
  const orFallback = openRouterModels.slice(0, 8).map((m) => {
    const [company, ...rest] = (m.id || '').split('/');
    return {
      company: company ? company.toUpperCase() : 'AI Lab',
      name: m.name || rest.join('/') || m.id,
      version: new Date(m.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      description: truncate(m.description || 'Newly released LLM added in the past 7 days.', 130),
      fullDescription: m.description || 'Newly released LLM added in the past 7 days.',
      howItIsDifferent: 'Newly launched model available across major AI providers.'
    };
  });

  const hfFallback = trendingModels.slice(0, 8).map((m) => {
    const [company, ...rest] = m.id.split('/');
    return {
      company: company || 'Hugging Face',
      name: rest.join('/') || m.id,
      version: m.tag || 'Open Weights',
      description: `Trending ${m.tag || 'LLM'} repository from the past 7 days.`,
      fullDescription: `Open-weights ${m.tag || 'language'} model published by ${company || 'the community'}, trending among enterprise and developer builders.`,
      howItIsDifferent: 'Available as open weights for private VPC or self-hosted inference rather than closed API-only access.'
    };
  });

  const fallback = orFallback.length > 0 ? orFallback : hfFallback;

  if (
    !GEMINI_API_KEY ||
    (openRouterModels.length === 0 && modelNews.length === 0 && trendingModels.length === 0)
  ) {
    return fallback;
  }

  try {
    const orContext = openRouterModels
      .slice(0, 12)
      .map((m) => `- ${m.name} (${m.id}): ${m.description}`)
      .join('\n');
    const newsContext = modelNews
      .slice(0, 8)
      .map((n) => `- ${n.title}: ${n.summary}`)
      .join('\n');
    const hfContext = trendingModels
      .slice(0, 6)
      .map((m) => `- ${m.id} (${m.tag || 'LLM'})`)
      .join('\n');

    const prompt = `From these newly released models (past 7 days), AI news items, and trending Hugging Face models, select up to 8 notable LLM models (prioritize newly released proprietary and major open-weights models). Return ONLY a JSON array of objects, each with:
- "company": Organization or lab name (e.g., Google, OpenAI, Anthropic, Meta, Mistral, Qwen, DeepSeek)
- "name": Model name
- "version": Version, size, or release tag (e.g., "4 Hydrogen", "2.5 Flash", "70B", or "Latest")
- "description": 1 concise sentence describing what the model is for
- "fullDescription": 2-3 sentences explaining the model's capabilities and intended use cases
- "howItIsDifferent": 1-2 sentences explaining how this model differs from alternatives (speed, cost, size, reasoning, open-weights, etc.)

New OpenRouter models (past 7 days):
${orContext || 'None'}

News headlines:
${newsContext || 'None'}

Trending Hugging Face models:
${hfContext || 'None'}`;

    const parsed = await callGeminiJson(prompt);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, 8).map((m) => ({
        company: String(m.company || 'AI Lab'),
        name: String(m.name || 'Model'),
        version: String(m.version || 'Latest'),
        description: String(m.description || ''),
        fullDescription: String(m.fullDescription || m.description || ''),
        howItIsDifferent: String(m.howItIsDifferent || '')
      }));
    }
  } catch (err) {
    console.warn(`Could not extract recent models via Gemini: ${err.message}`);
  }

  return fallback;
}

async function main() {
  const outPath = path.resolve('data/news.json');
  const cache = await loadExistingCache(outPath);

  const [feedResults, trendingModels, openRouterModels, modelNewsRaw] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f, MAX_PER_SOURCE))),
    fetchTrendingModels(),
    fetchOpenRouterRecentModels(),
    fetchFeed(MODEL_NEWS_FEED, 10).catch((err) => {
      console.warn(`Warning: Failed to fetch LLM release news: ${err.message}`);
      return [];
    })
  ]);

  const seenUrls = new Set();
  const items = [];

  for (let i = 0; i < feedResults.length; i++) {
    const result = feedResults[i];
    const feed = FEEDS[i];

    if (result.status === 'rejected') {
      console.warn(`Warning: Failed to fetch ${feed.name}: ${result.reason?.message || result.reason}`);
      continue;
    }

    for (const item of result.value) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        items.push(item);
      }
    }
  }

  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const enrichedItems = await enrichItems(items.slice(0, MAX_TOTAL_ITEMS), cache);
  const enrichedModelNews = await enrichItems(modelNewsRaw, cache);
  const recentModels = await buildRecentModelsList(
    enrichedModelNews,
    trendingModels,
    openRouterModels
  );

  const output = {
    lastUpdated: new Date().toISOString(),
    items: enrichedItems,
    llmTracker: {
      recentModels,
      modelNews: enrichedModelNews
    }
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(
    `Saved ${output.items.length} news items and ${recentModels.length} recent LLM models to data/news.json`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
