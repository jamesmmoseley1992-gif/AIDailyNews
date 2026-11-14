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
const MAX_AI_PER_RUN = 40;
const SUMMARY_VERSION = 2; // bump to force re-analysis of cached summaries
const ARTICLE_CHARS = 12000;
const AI_DELAY_MS = 1500;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Set GEMINI_MODEL in the workflow to switch models without editing code.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash'; // used only if the primary model ID is rejected (404)
let activeModel = GEMINI_MODEL;

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

const TOPIC_DEFS = {
  'Business & Adoption':
    'How companies, governments, and industries are actually USING AI: deployments, case studies, rollouts, ROI, workforce and job impact, customer adoption.',
  'AI Governance & Regulation':
    'Laws, regulation, government policy, export controls, lawsuits, copyright, privacy, AI safety rules, standards, and responsible-AI oversight.',
  'Models, Research & Advancement':
    'New models, benchmarks, scientific research papers, capability breakthroughs, and technical advances in how AI works.',
  'Agents & Developer Tools':
    'AI agents, coding assistants, MCP/tool use, SDKs, APIs, and tools for building AI applications.',
  'Infrastructure & Compute':
    'Chips, GPUs, data centers, cloud capacity, energy, inference serving, MLOps, and the hardware/software stack AI runs on.',
  'Environment & Sustainability':
    'The environmental footprint and impact of AI: energy and water use, carbon emissions, data-center power demand, climate applications of AI, and sustainability efforts.',
  'Funding & Markets':
    'Funding rounds, valuations, acquisitions, IPOs, partnerships between vendors, pricing, and competitive market moves.'
};

const AI_TOPICS = Object.keys(TOPIC_DEFS);

// Older runs used different topic names; map them so cached/existing data stays valid.
const LEGACY_TOPICS = {
  'Models & Research': 'Models, Research & Advancement',
  'Agents & Coding': 'Agents & Developer Tools',
  'Enterprise & Strategy': 'Business & Adoption',
  'Infrastructure & MLOps': 'Infrastructure & Compute',
  'Policy & Safety': 'AI Governance & Regulation'
};

const TOPIC_INSIGHTS = {
  'Business & Adoption': {
    importance: 6,
    whyItMatters:
      'Shows where AI is delivering real results in organizations, and what it means for jobs, operations, and competitive position.',
    whoIsAffected: 'Business Leaders, Operations and Transformation Teams, and Workers in affected roles.'
  },
  'AI Governance & Regulation': {
    importance: 6,
    whyItMatters:
      'Regulatory and policy shifts can create new compliance requirements, data-usage rules, and vendor risk considerations.',
    whoIsAffected: 'Legal & Compliance Teams, CISOs, Policy Makers, and Enterprise AI Governance Leaders.'
  },
  'Models, Research & Advancement': {
    importance: 5,
    whyItMatters:
      'Tracks fast-moving model capabilities, releases, and research shaping how AI is built and deployed.',
    whoIsAffected: 'AI Builders, ML Engineers, Researchers, and Product Teams evaluating new models.'
  },
  'Agents & Developer Tools': {
    importance: 6,
    whyItMatters:
      'Advances in AI agents and coding tools directly accelerate software delivery and automate multi-step workflows.',
    whoIsAffected: 'Software Engineers, AI App Developers, and Engineering Managers.'
  },
  'Infrastructure & Compute': {
    importance: 5,
    whyItMatters:
      'Chip, data-center, and serving improvements shape the cost, availability, and reliability of AI workloads.',
    whoIsAffected: 'MLOps Engineers, Cloud Architects, Platform Teams, and Infrastructure Buyers.'
  },
  'Environment & Sustainability': {
    importance: 6,
    whyItMatters:
      'AI growth is driving large increases in electricity, water, and carbon demand, affecting sustainability targets, costs, and community and regulatory scrutiny.',
    whoIsAffected: 'Sustainability and ESG Leaders, Data Center and Facilities Teams, Executives, and Policy Makers.'
  },
  'Funding & Markets': {
    importance: 6,
    whyItMatters:
      'Funding, M&A, and partnerships signal where capital and ecosystem momentum are consolidating.',
    whoIsAffected: 'Technology Executives, Product Leaders, Vendors, and Investors tracking the AI market.'
  }
};

// Ordered: first match wins. Specific/high-signal topics go before broad ones.
const TOPIC_RULES = [
  ['AI Governance & Regulation', /\b(regulat\w*|legislat\w*|lawmakers?|senate|congress|eu ai act|export controls?|lawsuit|sues?|sued|copyright|antitrust|privacy|ai safety|safety|policy|policies|ban|banned|compliance|governance|executive order)\b/],
  ['Environment & Sustainability', /\b(environment\w*|sustainab\w*|climate|carbon (footprint|neutral|capture|credits|dioxide|emissions?|removal)|emissions?|net[- ]zero|renewables?|water use|energy (use|consumption|demand)|power (demand|consumption|grid)|electricity|nuclear|esg|green|greenhouse|e-waste)\b/],
  ['Funding & Markets', /\b(raises?|raised|funding|series [a-e]|valuation|acqui\w*|merger|ipo|invest\w*|backed|billion|million|partnership)\b/],
  ['Infrastructure & Compute', /\b(gpus?|chips?|data cent\w+|datacenters?|inference|mlops|kubernetes|safetensors|quantiz\w*|latency|clusters?|vram|compute|semiconductors?|tpus?)\b/],
  ['Agents & Developer Tools', /\b(agents?|agentic|coding|copilot|mcp|tool[- ]use|developers?|sdk|api|ide|cursor|codex)\b/],
  ['Business & Adoption', /\b(enterprise|adopt\w*|deploy\w*|rollout|customers?|workforce|jobs?|layoffs?|roi|productivity|bank|banks|healthcare|retail|insurers?|companies|businesses|employees|survey|pilot|purchases?|shopping|e-?commerce|marketing|advertisw*|hospitals?|clinical|clinics?|education|educators?|students?|schools?|legal|law firms?|financial|industry|industries|workers?|hiring|interviews?)\b/]
];

const DB_TOPIC_DEFS = {
  'Genie & AI/BI':
    'Databricks Genie products (Genie Agents, Genie One, Genie Code, Genie spaces), AI/BI dashboards, and conversational analytics.',
  'Unity Catalog & Governance':
    'Unity Catalog, data and AI governance, lineage, access control, permissions, audit, sharing, and metadata management.',
  'Agent Bricks & Mosaic AI':
    'Agent Bricks, Mosaic AI, agent frameworks, Model Serving, Vector Search, Foundation Model APIs, MLflow, and building or evaluating AI/ML on Databricks.',
  'Data Engineering & Lakeflow':
    'Lakeflow, Delta Live Tables / declarative pipelines, Jobs, Auto Loader, Delta Lake, ingestion, streaming, and ETL.',
  'SQL & Warehousing':
    'Databricks SQL, SQL warehouses, serverless SQL, Photon, query performance, and BI connectivity.',
  'Apps & Lakebase':
    'Databricks Apps, Lakebase (managed Postgres), and building applications on the platform.',
  'Platform & Administration':
    'Runtime releases, compute and clusters, security, networking, workspace administration, cost, and general platform updates.'
};

const DB_TOPICS = Object.keys(DB_TOPIC_DEFS);

// Ordered: first match wins.
const DB_TOPIC_RULES = [
  ['Genie & AI/BI', /\b(genie|ai\/bi|dashboards?|conversational analytics)\b/],
  ['Unity Catalog & Governance', /\b(unity catalog|governance|governed|lineage|access control|permissions?|delta sharing|metastore|audit|abac|row filters?|column masks?)\b/],
  ['Agent Bricks & Mosaic AI', /\b(agent bricks|mosaic|agents?|agentic|model serving|vector search|foundation model|mlflow|llms?|genai|rag|fine-tun\w*|ai gateway|unity gateway|gateway|gemini|gpt|claude|llama|machine learning)\b/],
  ['Data Engineering & Lakeflow', /\b(lakeflow|delta live tables|dlt|pipelines?|jobs?|auto loader|delta lake|delta|streaming|ingest\w*|etl|spark|workflows?|connectors?)\b/],
  ['Apps & Lakebase', /\b(lakebase|postgres\w*|databricks apps?|apps)\b/],
  ['SQL & Warehousing', /\b(sql|warehouses?|photon|serverless|query|queries)\b/]
];

const DB_FALLBACK_TOPIC = 'Platform & Administration';

function deriveInsights(title, text, source, category) {
  const combined = `${title} ${text}`.toLowerCase();

  if (category === 'Databricks') {
    const dbTopic = (DB_TOPIC_RULES.find(([, re]) => re.test(combined)) || [])[0] || DB_FALLBACK_TOPIC;
    if (source === 'Databricks Release Notes' || /release|runtime|delta|unity catalog|photon|sql/.test(combined)) {
      return {
        topic: dbTopic,
        importance: 7,
        whyItMatters:
          'Platform updates and release notes often introduce performance improvements, new SQL/Spark capabilities, or deprecations that impact production pipelines.',
        whoIsAffected:
          'Databricks Data Engineers, Lakehouse Architects, and Workspace Admins managing clusters, jobs, and governance.'
      };
    }
    return {
      topic: dbTopic,
      importance: 6,
      whyItMatters:
        'Highlights architectural patterns, benchmarks, and engineering practices for scaling data and AI workloads on the Lakehouse.',
      whoIsAffected: 'Data Platform Teams, Analytics Engineers, and ML Engineers building on Databricks.'
    };
  }

  const topic = (TOPIC_RULES.find(([, re]) => re.test(combined)) || [])[0] || 'Models, Research & Advancement';
  return { topic, ...TOPIC_INSIGHTS[topic] };
}

async function loadExistingCache(outPath) {
  const cache = new Map();
  const isBroken = (it) =>
    /incomplete news item|insufficient|no excerpt/i.test(it.fullStory || '');

  try {
    const raw = await fs.readFile(outPath, 'utf8');
    const existing = JSON.parse(raw);
    const usable = (it) =>
      it.url && it.aiAnalyzed && it.summaryVersion === SUMMARY_VERSION && !isBroken(it);
    for (const item of existing.items || []) {
      if (usable(item)) cache.set(item.url, item);
    }
    for (const item of existing.llmTracker?.modelNews || []) {
      if (usable(item)) cache.set(item.url, item);
    }
  } catch {
    // No existing cache yet
  }
  return cache;
}

async function fetchArticleText(url) {
  // Google News links are redirect stubs; fetching them never returns the article body.
  if (new URL(url).hostname === 'news.google.com') return '';
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
    return truncate(stripHtml(cleaned), ARTICLE_CHARS);
  } catch {
    return '';
  }
}

async function callGemini(model, prompt) {
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
  });
}

async function callGeminiJson(prompt) {
  let res = await callGemini(activeModel, prompt);

  // A 404 means the model ID is unknown to the API; fall back once so summaries keep working.
  if (res.status === 404 && activeModel !== GEMINI_FALLBACK_MODEL) {
    console.warn(`Model "${activeModel}" not found; falling back to ${GEMINI_FALLBACK_MODEL}.`);
    activeModel = GEMINI_FALLBACK_MODEL;
    res = await callGemini(activeModel, prompt);
  }

  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status} (${activeModel})`);
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
      ? `- "topic": Exactly one of the following (pick the single best fit for the MAIN point of the story):\n${DB_TOPICS.map((t) => `    "${t}": ${DB_TOPIC_DEFS[t]}`).join('\n')}`
      : `- "topic": Exactly one of the following (pick the single best fit for the MAIN point of the story):\n${AI_TOPICS.map((t) => `    "${t}": ${TOPIC_DEFS[t]}`).join('\n')}`;

  const prompt = `Analyze this tech/AI news item and return ONLY valid JSON with five keys:
- "fullStory": A thorough 3-4 paragraph summary separated by "\\n\\n". Cover who did what and when, the key facts, figures, names and quotes, the context, and any stated consequences or next steps. Use ONLY facts present in the article text; do not speculate or write "likely" or "may have". Never complain about missing text.
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
    (item.category === 'Databricks' ? DB_TOPICS : AI_TOPICS).includes(parsed.topic)
        ? parsed.topic
        : item.topic;

  return {
    fullStory: parsed.fullStory.trim(),
    whyItMatters: parsed.whyItMatters.trim(),
    whoIsAffected: parsed.whoIsAffected.trim(),
    importance: Number(parsed.importance) || 5,
    topic: validTopic,
    summaryVersion: SUMMARY_VERSION,
    summary: truncate(parsed.fullStory.split(/\n\n/)[0].replace(/\s+/g, ' '), 260)
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
        topic: LEGACY_TOPICS[cached.topic] ?? cached.topic ?? rest.topic,
        summaryVersion: SUMMARY_VERSION,
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
        rawText: truncate(cleanLong, 6000),
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
    const seenBase = new Set();
    return (json.data || [])
      .filter((m) => typeof m.created === 'number' && m.created >= cutoffSec)
      // Variants like ":batch" or ":free" are the same model; keep one entry per base model.
      .sort((a, b) => b.created - a.created)
      .filter((m) => {
        const base = (m.id || '').split(':')[0];
        if (seenBase.has(base)) return false;
        seenBase.add(base);
        return true;
      })
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
  const fmtDate = (ms) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const toEntry = (m) => {
    const [company, ...rest] = (m.id || '').split('/');
    return {
      company: company ? company.toUpperCase() : 'AI Lab',
      name: m.name || rest.join('/') || m.id,
      version: 'Release',
      releaseDate: fmtDate(m.created * 1000),
      description: truncate(m.description || 'Newly released LLM added in the past 7 days.', 130),
      fullDescription: m.description || 'Newly released LLM added in the past 7 days.',
      howItIsDifferent: 'Newly launched model available across major AI providers.'
    };
  };
  const orFallback = openRouterModels.map(toEntry);

  const hfFallback = trendingModels.slice(0, 8).map((m) => {
    const [company, ...rest] = m.id.split('/');
    return {
      company: company || 'Hugging Face',
      name: rest.join('/') || m.id,
      version: m.tag || 'Open Weights',
      releaseDate: 'Past 7 days',
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
      .map((m) => `- ${m.name} (${m.id}) [Released: ${fmtDate(m.created * 1000)}]: ${m.description}`)
      .join('\n');
    const newsContext = modelNews
      .slice(0, 8)
      .map((n) => `- ${n.title} [${fmtDate(Date.parse(n.publishedAt))}]: ${n.summary}`)
      .join('\n');
    const hfContext = trendingModels
      .slice(0, 6)
      .map((m) => `- ${m.id} (${m.tag || 'LLM'})`)
      .join('\n');

    const prompt = `From these newly released models (past 7 days), AI news items, and trending Hugging Face models, include EVERY new LLM listed in the OpenRouter list (do not skip or merge any), plus any other notable newly released model mentioned in the news or Hugging Face lists that is not already covered. Return ONLY a JSON array of objects, each with:
- "company": Organization or lab name (e.g., Google, OpenAI, Anthropic, Meta, Mistral, Qwen, DeepSeek)
- "name": Model name
- "version": Version, size, or release tag (e.g., "4 Hydrogen", "2.5 Flash", "70B", or "Latest")
- "releaseDate": Release date string from the source (e.g., "Nov 12, 2026", or "Past 7 days" if unknown)
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
      const models = parsed.map((m) => ({
        company: String(m.company || 'AI Lab'),
        name: String(m.name || 'Model'),
        version: String(m.version || 'Latest'),
        releaseDate: String(m.releaseDate || 'Past 7 days'),
        description: String(m.description || ''),
        fullDescription: String(m.fullDescription || m.description || ''),
        howItIsDifferent: String(m.howItIsDifferent || '')
      }));

      // Safety net: never drop a model that Gemini overlooked; the 7-day window is the only limit.
      const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const m of openRouterModels) {
        const bare = norm((m.name || '').split(':').pop());
        if (bare && !models.some((x) => norm(x.name).includes(bare) || bare.includes(norm(x.name)))) {
          models.push(toEntry(m));
        }
      }
      return models;
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
  const sourceStats = [];

  for (let i = 0; i < feedResults.length; i++) {
    const result = feedResults[i];
    const feed = FEEDS[i];
    const host = new URL(feed.url).hostname.replace(/^www\./, '');

    if (result.status === 'rejected') {
      console.warn(`Warning: Failed to fetch ${feed.name}: ${result.reason?.message || result.reason}`);
      sourceStats.push({ name: feed.name, origin: host, type: 'RSS', count: 0, status: 'Unavailable' });
      continue;
    }

    sourceStats.push({ name: feed.name, origin: host, type: 'RSS', count: result.value.length, status: 'Live' });

    for (const item of result.value) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        items.push(item);
      }
    }
  }

  sourceStats.push(
    { name: 'LLM Releases News', origin: 'news.google.com', type: 'RSS', count: modelNewsRaw.length, status: modelNewsRaw.length ? 'Live' : 'Empty' },
    { name: 'OpenRouter Models', origin: 'openrouter.ai', type: 'API', count: openRouterModels.length, status: openRouterModels.length ? 'Live' : 'Empty' },
    { name: 'Hugging Face Trending', origin: 'huggingface.co', type: 'API', count: trendingModels.length, status: trendingModels.length ? 'Live' : 'Empty' }
  );

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
    meta: {
      schedule: 'Twice daily at 8:00 AM & 2:00 PM US Central (CST)',
      windowDays: DAYS_BACK,
      aiSummarizer: GEMINI_API_KEY ? `${activeModel} (cached)` : 'Built-in fallback',
      sources: sourceStats
    },
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
