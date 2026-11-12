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
      whyItMatters:
        'Platform updates and release notes often introduce performance improvements, new SQL/Spark capabilities, or deprecations that impact production pipelines.',
      whoIsAffected:
        'Databricks Data Engineers, Lakehouse Architects, and Workspace Admins managing clusters, jobs, and governance.'
    };
  }

  if (category === 'Databricks') {
    return {
      whyItMatters:
        'Highlights architectural patterns, benchmarks, and engineering practices for scaling data and AI workloads on the Lakehouse.',
      whoIsAffected:
        'Data Platform Teams, Analytics Engineers, and ML Engineers building on Databricks.'
    };
  }

  if (/open[- ]source|weights|hugging face|llama|mistral|qwen|deepseek|fine-tun|gguf/.test(combined)) {
    return {
      whyItMatters:
        'New open-weights models and tooling lower inference costs and give teams full control over privacy, customization, and self-hosting.',
      whoIsAffected:
        'ML Engineers, AI App Developers, and Infrastructure Teams evaluating self-hosted or fine-tuned models.'
    };
  }

  if (/regulat|law|policy|copyright|antitrust|senate|eu ai act|safety/.test(combined)) {
    return {
      whyItMatters:
        'Regulatory and policy shifts can create new compliance requirements, data-usage rules, and vendor risk considerations.',
      whoIsAffected:
        'Legal & Compliance Teams, CISOs, and Enterprise AI Governance Leaders.'
    };
  }

  if (/fund|raise|acqui|valuation|billion|million|partnership|enterprise/.test(combined)) {
    return {
      whyItMatters:
        'Major funding, M&A, and enterprise partnerships signal where capital and ecosystem momentum are consolidating.',
      whoIsAffected:
        'Technology Executives, Product Leaders, Vendors, and Investors tracking the AI market.'
    };
  }

  return {
    whyItMatters:
      'Tracks fast-moving capabilities, product launches, and industry shifts shaping how AI is built and deployed.',
    whoIsAffected:
      'AI Builders, Engineering Leaders, and Product Teams evaluating new tools and workflows.'
  };
}

async function loadExistingCache(outPath) {
  const cache = new Map();
  try {
    const raw = await fs.readFile(outPath, 'utf8');
    const existing = JSON.parse(raw);
    for (const item of existing.items || []) {
      if (item.url && item.aiAnalyzed) cache.set(item.url, item);
    }
    for (const item of existing.llmTracker?.modelNews || []) {
      if (item.url && item.aiAnalyzed) cache.set(item.url, item);
    }
  } catch {
    // No existing cache yet
  }
  return cache;
}

async function analyzeWithGemini(item) {
  const prompt = `Analyze this tech/AI news item and return ONLY valid JSON with three keys:
- "fullStory": A clear 2-paragraph (or 1 short paragraph if limited info) summary of what happened, separated by "\\n\\n". Do not invent facts beyond the provided text.
- "whyItMatters": 1-2 concise sentences explaining why this specific news matters.
- "whoIsAffected": 1 concise sentence naming the specific roles, teams, or users affected.

Source: ${item.source}
Category: ${item.category}
Title: ${item.title}
Excerpt: ${item.rawText || item.summary}`;

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
          temperature: 0.3
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
  const parsed = JSON.parse(text);

  if (!parsed.fullStory || !parsed.whyItMatters || !parsed.whoIsAffected) {
    throw new Error('Incomplete JSON from Gemini');
  }

  return {
    fullStory: parsed.fullStory.trim(),
    whyItMatters: parsed.whyItMatters.trim(),
    whoIsAffected: parsed.whoIsAffected.trim()
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
        fullStory: cached.fullStory,
        whyItMatters: cached.whyItMatters,
        whoIsAffected: cached.whoIsAffected,
        aiAnalyzed: true
      });
      continue;
    }

    if (!rateLimited && aiCalls < MAX_AI_PER_RUN) {
      try {
        const analysis = await analyzeWithGemini(item);
        aiCalls++;
        const { rawText, ...rest } = item;
        enriched.push({
          ...rest,
          ...analysis,
          aiAnalyzed: true
        });
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
        publishedAt: new Date(publishedMs).toISOString(),
        summary: truncate(cleanLong, 150),
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
          url: id ? `https://huggingface.co/${id}` : '',
          tag,
          likes: repo.likes ?? null,
          downloads: repo.downloads ?? null
        };
      })
      .filter((m) => m.id && (!m.tag || m.tag === 'text-generation' || m.tag === 'image-text-to-text'))
      .slice(0, 12);
  } catch (err) {
    console.warn(`Warning: Failed to fetch Hugging Face trending models: ${err.message}`);
    return [];
  }
}

async function main() {
  const outPath = path.resolve('data/news.json');
  const cache = await loadExistingCache(outPath);

  const [feedResults, trendingModels, modelNewsRaw] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f, MAX_PER_SOURCE))),
    fetchTrendingModels(),
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

  const output = {
    lastUpdated: new Date().toISOString(),
    items: enrichedItems,
    llmTracker: {
      trendingModels,
      modelNews: enrichedModelNews
    }
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(
    `Saved ${output.items.length} news items and ${trendingModels.length} trending models to data/news.json`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
