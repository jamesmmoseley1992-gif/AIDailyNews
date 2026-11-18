// Builds data/llm-timeline.json: the major LLM releases from the leading AI providers over the
// last 12 months, each linked to its direct previous version with the measurable jump.
//
//   node scripts/build-timeline.js
//
// Facts (release date, context window, price) come from the OpenRouter catalog; the full model
// description comes from the model page (JSON-LD). Written comparisons ("jump") are kept once
// written; only entries without one are sent to Gemini (when GEMINI_API_KEY is set).
import fs from 'node:fs/promises';
import path from 'node:path';

const MONTHS_BACK = 12;
const OUT = path.resolve('data/llm-timeline.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const UA = { 'User-Agent': 'ai-databricks-daily-bot/1.0' };

// Each provider lists the model lines worth plotting. `line` decides which earlier model counts as
// the "previous version"; `fallback` is the line to look in when a line has no earlier model yet.
// Returning null skips a model (image/audio/code-variant/size-variant models are not milestones).
const PROVIDERS = [
  { key: 'openai', label: 'OpenAI', color: '#10a37f', prefix: 'openai/', classify(slug) {
    if (/codex|audio|image|chat-latest|-pro$/.test(slug)) return null;
    const m = /^gpt-([\d.]+)(?:-(astra|sol|terra|luna|mini|nano))?$/.exec(slug);
    if (!m) return null;
    const tier = m[2] || 'core';
    return { line: tier === 'astra' ? 'core' : tier, fallback: ['core'] };
  } },
  { key: 'anthropic', label: 'Anthropic', color: '#d97757', prefix: 'anthropic/', classify(slug) {
    const m = /^claude-(opus|sonnet|haiku|fable)-[\d.]+$/.exec(slug);
    return m ? { line: m[1], fallback: m[1] === 'fable' ? ['opus'] : [] } : null;
  } },
  { key: 'google', label: 'Google', color: '#4285f4', prefix: 'google/', classify(slug) {
    if (/image|lyria|customtools|nano-banana/.test(slug)) return null;
    if (/^gemma-4-31b/.test(slug)) return { line: 'gemma', fallback: [] };
    if (/^gemma/.test(slug)) return null;
    if (/^gemini-omni/.test(slug)) return { line: 'omni', fallback: [] };
    if (/^gemini-4-/.test(slug)) return { line: 'gemini4', fallback: ['pro', 'flash'] };
    if (/flash-lite/.test(slug)) return { line: 'flash-lite', fallback: [] };
    if (/flash/.test(slug)) return { line: 'flash', fallback: [] };
    if (/pro/.test(slug)) return { line: 'pro', fallback: [] };
    return null;
  } },
  { key: 'x-ai', label: 'xAI', color: '#2b2b2b', prefix: 'x-ai/', classify(slug) {
    return /^grok-4[\d.]*$/.test(slug) ? { line: 'grok', fallback: [] } : null;
  } },
  { key: 'deepseek', label: 'DeepSeek', color: '#4d6bfe', prefix: 'deepseek/', classify(slug) {
    if (/vision|exp/.test(slug)) return null;
    if (/flash/.test(slug)) return { line: 'flash', fallback: ['chat'] };
    if (/pro/.test(slug)) return { line: 'pro', fallback: ['chat'] };
    return /^deepseek-v3\.2$/.test(slug) ? { line: 'chat', fallback: [] } : null;
  } },
  { key: 'qwen', label: 'Alibaba Qwen', color: '#615cef', prefix: 'qwen/', classify(slug) {
    if (/^qwen3\.5-397b|max|^qwen3\.8-2\.4t/.test(slug)) return { line: 'flagship', fallback: [] };
    if (/^qwen3\.5-plus-02-15$|^qwen3\.[67]-plus$/.test(slug)) return { line: 'plus', fallback: [] };
    if (/^qwen3\.\d-flash/.test(slug)) return { line: 'flash', fallback: [] };
    return null;
  } },
  { key: 'mistralai', label: 'Mistral', color: '#fa520f', prefix: 'mistralai/', classify(slug) {
    const m = /^(mistral-large|mistral-medium|mistral-small|devstral)/.exec(slug);
    return m ? { line: m[1], fallback: [] } : null;
  } },
  { key: 'nvidia', label: 'NVIDIA', color: '#76b900', prefix: 'nvidia/', classify(slug) {
    const m = /^nemotron-3(?:\.5)?-(nano|super|ultra|lightning)/.exec(slug);
    return m ? { line: m[1], fallback: [] } : null;
  } },
  { key: 'amazon', label: 'Amazon', color: '#ff9900', prefix: 'amazon/', classify(slug) {
    return /^nova-2/.test(slug) ? { line: 'nova', fallback: [] } : null;
  } }
];

const fmtTokens = (n) => (!n ? null : n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
const perM = (v) => { const n = Number(v) * 1e6; return Number.isFinite(n) && n > 0 ? +n.toFixed(3) : null; };
const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const cleanName = (n) => String(n || '').replace(/^[^:]+:\s*/, '').replace(/\s+\(?\d{4}-\d{2}-\d{2}\)?$/, '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fullDescription(id, fallback) {
  try {
    const res = await fetch(`https://openrouter.ai/${id}`, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) {
      try {
        const j = JSON.parse(m[1]);
        if (j['@type'] === 'SoftwareApplication' && j.description && j.description.length > fallback.length) return j.description.trim();
      } catch { /* next block */ }
    }
  } catch (err) {
    console.warn(`  full description unavailable for ${id}: ${err.message}`);
  }
  return fallback;
}

function deltasOf(m, p) {
  if (!p) return null;
  return {
    daysSince: Math.round((Date.parse(m.releaseDate) - Date.parse(p.releaseDate)) / 864e5),
    context: { from: p.contextLength, to: m.contextLength },
    input: { from: p.inputPerM, to: m.inputPerM },
    output: { from: p.outputPerM, to: m.outputPerM }
  };
}

function specSentence(m, p) {
  const bits = [];
  const c = fmtTokens(m.contextLength), pc = fmtTokens(p.contextLength);
  if (c && pc) bits.push(c === pc ? `context unchanged at ${c}` : `context ${pc} to ${c}`);
  if (m.inputPerM && p.inputPerM) bits.push(m.inputPerM === p.inputPerM ? `input price unchanged at $${m.inputPerM}/M` : `input $${p.inputPerM} to $${m.inputPerM}/M`);
  if (m.outputPerM && p.outputPerM) bits.push(m.outputPerM === p.outputPerM ? `output price unchanged at $${m.outputPerM}/M` : `output $${p.outputPerM} to $${m.outputPerM}/M`);
  return bits.length ? bits.join('; ') + '.' : '';
}

async function geminiJump(m, p) {
  const prompt = `Compare a new AI model with its DIRECT previous version using ONLY the facts below. Do not invent numbers or benchmarks. In 2 sentences, state concretely what improved or changed (capabilities, speed, context, price, positioning). Return ONLY a JSON object: {"jump": "..."}.

NEW: ${m.name} (${m.releaseDate}). ${m.description}
PREVIOUS: ${p.name} (${p.releaseDate}). ${p.description}
Specs new: context ${m.contextLength}, $${m.inputPerM}/$${m.outputPerM} per 1M tokens. Specs previous: context ${p.contextLength}, $${p.inputPerM}/$${p.outputPerM}.`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = await res.json();
  return String(JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').jump || '').trim();
}

async function main() {
  let existing = { models: [] };
  try { existing = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* first run */ }
  const cache = new Map((existing.models || []).map((m) => [m.id, m]));

  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: UA });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const catalog = (await res.json()).data.filter((m) => typeof m.created === 'number' && !m.id.includes(':'));

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
  const cutoffSec = Math.floor(cutoff.getTime() / 1000);

  // Every classified model (including ones older than the window, so a model can still point at its predecessor).
  const all = [];
  for (const prov of PROVIDERS) {
    for (const m of catalog) {
      if (!m.id.startsWith(prov.prefix)) continue;
      const c = prov.classify(m.id.slice(prov.prefix.length));
      if (!c) continue;
      all.push({
        id: m.id, provider: prov.key, line: c.line, fallback: c.fallback, created: m.created,
        name: cleanName(m.name), releaseDate: iso(m.created), shortDescription: String(m.description || '').replace(/<[^>]+>/g, '').trim(),
        contextLength: m.context_length || null, inputPerM: perM(m.pricing?.prompt), outputPerM: perM(m.pricing?.completion)
      });
    }
  }
  all.sort((a, b) => a.created - b.created);

  const picked = all.filter((m) => m.created >= cutoffSec);
  console.log(`${picked.length} timeline models across ${new Set(picked.map((m) => m.provider)).size} providers`);

  const models = [];
  for (const m of picked) {
    const before = all.filter((x) => x.provider === m.provider && x.created < m.created);
    const prev = [...before].reverse().find((x) => x.line === m.line)
      || m.fallback.map((l) => [...before].reverse().find((x) => x.line === l)).find(Boolean) || null;

    const old = cache.get(m.id) || {};
    const description = old.description && old.descriptionFull ? old.description : await fullDescription(m.id, m.shortDescription);
    const entry = {
      id: m.id, provider: m.provider, line: m.line, name: m.name, releaseDate: m.releaseDate, description,
      descriptionFull: description.length > m.shortDescription.length || !!old.descriptionFull,
      contextLength: m.contextLength, inputPerM: m.inputPerM, outputPerM: m.outputPerM,
      previous: prev ? { id: prev.id, name: prev.name, releaseDate: prev.releaseDate } : null,
      jump: old.jump || '', summary: old.summary || ''
    };
    entry.deltas = deltasOf(entry, prev);
    models.push({ entry, prev });
    if (!old.description) await sleep(150);
  }

  // Write missing comparisons with Gemini when a key is available; otherwise keep the specs-only fallback in the UI.
  const byId = new Map(models.map(({ entry }) => [entry.id, entry]));
  for (const { entry, prev } of models) {
    if (entry.jump || !prev || !GEMINI_API_KEY) continue;
    const p = byId.get(prev.id) || { ...prev, description: '' };
    try {
      entry.jump = await geminiJump(entry, { ...p, description: p.description || all.find((x) => x.id === prev.id)?.shortDescription || '', contextLength: p.contextLength ?? prev.contextLength, inputPerM: p.inputPerM ?? prev.inputPerM, outputPerM: p.outputPerM ?? prev.outputPerM });
      await sleep(1500);
    } catch (err) {
      console.warn(`  comparison skipped for ${entry.id}: ${err.message}`);
    }
  }
  for (const { entry, prev } of models) {
    if (!entry.summary) entry.summary = (entry.description.match(/^.*?[.!?](?=\s|$)/) || [entry.description])[0].slice(0, 220);
    if (!entry.jump && prev) entry.jumpIsSpecsOnly = true; else delete entry.jumpIsSpecsOnly;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    windowMonths: MONTHS_BACK,
    providers: PROVIDERS.map(({ key, label, color }) => ({ key, label, color })).filter((p) => models.some(({ entry }) => entry.provider === p.key)),
    models: models.map(({ entry }) => entry).sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.id.localeCompare(b.id))
  };
  await fs.writeFile(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${out.models.length} models to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
