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

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxLength = 200) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

async function fetchFeed(feed, maxItems = MAX_PER_SOURCE) {
  const parsed = await parser.parseURL(feed.url);
  const cutoffMs = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

  return (parsed.items || [])
    .map((item) => {
      const dateStr = item.isoDate || item.pubDate;
      const parsedMs = dateStr ? Date.parse(dateStr) : NaN;
      const publishedMs = Number.isNaN(parsedMs) ? Date.now() : parsedMs;
      const rawSummary = item.contentSnippet || item.content || item.summary || '';

      return {
        title: (item.title || 'Untitled').trim(),
        url: item.link || '',
        source: feed.name,
        category: feed.category,
        publishedAt: new Date(publishedMs).toISOString(),
        summary: truncate(stripHtml(rawSummary))
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
      .slice(0, 10);
  } catch (err) {
    console.warn(`Warning: Failed to fetch Hugging Face trending models: ${err.message}`);
    return [];
  }
}

async function main() {
  const [feedResults, trendingModels, modelNewsResult] = await Promise.all([
    Promise.allSettled(FEEDS.map((f) => fetchFeed(f, MAX_PER_SOURCE))),
    fetchTrendingModels(),
    fetchFeed(MODEL_NEWS_FEED, 8).catch((err) => {
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

  // Strictly sort newest first across all sources
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const output = {
    lastUpdated: new Date().toISOString(),
    items: items.slice(0, MAX_TOTAL_ITEMS),
    llmTracker: {
      trendingModels,
      modelNews: modelNewsResult
    }
  };

  const outPath = path.resolve('data/news.json');
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
