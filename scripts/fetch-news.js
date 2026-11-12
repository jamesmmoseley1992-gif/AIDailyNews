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

const DAYS_BACK = 7;        // Keep articles from the last 7 days
const MAX_PER_SOURCE = 10;  // Prevent one noisy feed (like Google News) from drowning others
const MAX_TOTAL_ITEMS = 40;

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

function truncate(text, maxLength = 220) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1).trimEnd() + '…';
}

async function fetchFeed(feed) {
  const parsed = await parser.parseURL(feed.url);
  const cutoffMs = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

  return (parsed.items || [])
    .map((item) => {
      const dateStr = item.isoDate || item.pubDate;
      const publishedMs = dateStr ? Date.parse(dateStr) : Date.now();
      const rawSummary = item.contentSnippet || item.content || item.summary || '';

      return {
        title: (item.title || 'Untitled').trim(),
        url: item.link || '',
        source: feed.name,
        category: feed.category,
        publishedAt: new Date(Number.isNaN(publishedMs) ? Date.now() : publishedMs).toISOString(),
        summary: truncate(stripHtml(rawSummary))
      };
    })
    .filter((item) => item.url && Date.parse(item.publishedAt) >= cutoffMs)
    .slice(0, MAX_PER_SOURCE);
}

async function main() {
  const results = await Promise.allSettled(FEEDS.map(fetchFeed));

  const seenUrls = new Set();
  const items = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
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

  // Sort newest first
  items.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const output = {
    lastUpdated: new Date().toISOString(),
    items: items.slice(0, MAX_TOTAL_ITEMS)
  };

  const outPath = path.resolve('data/news.json');
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  console.log(`Saved ${output.items.length} articles to data/news.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
