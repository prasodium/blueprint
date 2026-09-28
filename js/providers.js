/* Blueprint — LLM provider abstraction.
   Each provider turns prompts into a typed diagram spec.
   Keys stay in this browser's localStorage; calls go straight to the provider. */

export const PROVIDERS = [
  {
    id: "gemini",
    label: "Gemini",
    kind: "gemini",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    keyName: "Gemini API key",
    keyPlaceholder: "AIza…",
    defaultModel: "gemini-3.8-flash",
    models: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
             "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
    hint: "Free tier at Google AI Studio.",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    base: "https://api.groq.com/openai/v1",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    keyName: "Groq API key",
    keyPlaceholder: "gsk_…",
    defaultModel: "llama-3.3-70b-versatile",
    jsonMode: true,
    hint: "Free tier at console.groq.com.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    base: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    keyName: "OpenRouter API key",
    keyPlaceholder: "sk-or-…",
    defaultModel: "deepseek/deepseek-chat-v3-0324:free",
    jsonMode: true,
    extraHeaders: { "HTTP-Referer": "https://prasodium.github.io/blueprint/", "X-Title": "Blueprint" },
    hint: "Free models available at openrouter.ai.",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    base: "https://api.openai.com/v1",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    keyName: "OpenAI API key",
    keyPlaceholder: "sk-…",
    defaultModel: "gpt-4o-mini",
    jsonMode: true,
    hint: "Paid — pay-as-you-go at platform.openai.com.",
  },
  {
    id: "pollinations",
    label: "Pollinations",
    kind: "openai",
    base: "https://text.pollinations.ai/openai",
    needsKey: false,
    keyUrl: "",
    keyName: "API key",
    keyPlaceholder: "",
    defaultModel: "openai",
    jsonMode: false,
    hint: "No key needed — free community API.",
  },
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/* ---------- per-browser settings (localStorage) ---------- */
const LS_PROVIDER = "blueprint_provider";
const LS_KEYS = "blueprint_keys";
const LS_MODELS = "blueprint_models";
const LS_LEGACY_KEY = "blueprint_gemini_key";

function readJson(k) {
  try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; }
}
function writeJson(k, v) {
  localStorage.setItem(k, JSON.stringify(v));
}

export function currentProviderId() {
  return localStorage.getItem(LS_PROVIDER) || "gemini";
}
export function setProviderId(id) {
  localStorage.setItem(LS_PROVIDER, id);
}
/** Stored key for a provider (falls back to the legacy single-key slot for Gemini). */
export function providerKey(id) {
  const keys = readJson(LS_KEYS);
  if (keys[id]) return String(keys[id]).trim();
  if (id === "gemini") return (localStorage.getItem(LS_LEGACY_KEY) || "").trim();
  return "";
}
export function setProviderKey(id, v) {
  const keys = readJson(LS_KEYS);
  if (v && v.trim()) keys[id] = v.trim();
  else delete keys[id];
  writeJson(LS_KEYS, keys);
}
/** Effective model: user override, else the provider default. */
export function providerModel(id) {
  const m = readJson(LS_MODELS)[id];
  return (m && String(m).trim()) || getProvider(id).defaultModel;
}
export function setProviderModel(id, v) {
  const models = readJson(LS_MODELS);
  if (v && v.trim()) models[id] = v.trim();
  else delete models[id];
  writeJson(LS_MODELS, models);
}
/** True when the current provider is ready to generate (has key if it needs one). */
export function providerReady() {
  const p = getProvider(currentProviderId());
  return !p.needsKey || !!providerKey(p.id);
}

/* ---------- response plumbing ---------- */
function extractJson(text) {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("The model did not return JSON. Try again.");
  return JSON.parse(t.slice(start, end + 1));
}

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

function geminiFriendly(status, body) {
  const msg = body?.error?.message || "";
  if (status === 400 && /key/i.test(msg)) return "Gemini rejected the API key. Check it in Settings — get a free one at https://aistudio.google.com/apikey";
  if (status === 400) return "Gemini rejected the request: " + (msg || "bad request");
  if (status === 403) return "Gemini denied the request (403). The key may lack access or the API isn't enabled for it.";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "Gemini rate limit hit (free tier). Wait a minute and try again.";
  return `Gemini error (HTTP ${status}): ${msg || "unknown"}`;
}

async function geminiGenerate({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const p = getProvider("gemini");
  const chain = model && model !== p.defaultModel
    ? [model, ...p.models.filter((m) => m !== model)]
    : p.models;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 16384 },
  };
  let lastErr = null;
  const failures = [];
  for (const m of chain) {
    const res = await fetch(`${GEMINI_API}/${m}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const friendly = geminiFriendly(res.status, data);
      // 404 = model retired for this key; 503 = model overloaded right now.
      // Either way, try the next model instead of failing the whole run.
      if (friendly === "MODEL_NOT_FOUND" || res.status === 503) {
        failures.push(`${m} (${res.status === 503 ? "overloaded" : "not available for this key"})`);
        lastErr = new Error(`Model ${m} ${res.status === 503 ? "is overloaded" : "isn't available for this key"}, trying next…`);
        continue;
      }
      throw new Error(friendly);
    }
    const cands = data?.candidates || [];
    const text = (cands[0]?.content?.parts || []).map((x) => x.text || "").join("");
    if (!text.trim()) throw new Error("Gemini returned an empty response. Try again.");
    try {
      return { spec: extractJson(text), model: m };
    } catch {
      throw new Error("Gemini returned text that wasn't valid JSON. Try again — it usually works on retry.");
    }
  }
  throw new Error(
    lastErr
      ? `Gemini couldn't generate right now (${failures.join("; ")}). The free tier may be busy — wait a minute and try again.`
      : "No Gemini model responded. Try again later."
  );
}

async function openaiGenerate({ provider: p, apiKey, model, systemPrompt, userPrompt, signal }) {
  const mdl = model || p.defaultModel;
  const headers = { "Content-Type": "application/json", ...(p.extraHeaders || {}) };
  if (p.needsKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const body = {
    model: mdl,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 16384,
  };
  if (p.jsonMode) body.response_format = { type: "json_object" };
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST", headers, signal, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || "";
    if (res.status === 401 || res.status === 403) throw new Error(`${p.label} rejected the API key (${res.status}). Check it in Settings.`);
    if (res.status === 429) throw new Error(`${p.label} rate limit hit. Wait a minute and try again.`);
    throw new Error(`${p.label} error (HTTP ${res.status}): ${msg || "unknown"}`);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error(`${p.label} returned an empty response. Try again.`);
  try {
    return { spec: extractJson(text), model: mdl };
  } catch {
    throw new Error(`${p.label} returned text that wasn't valid JSON. Try again.`);
  }
}

/** Generate a diagram spec via the chosen provider. Throws a human-readable Error on failure. */
export async function generateSpec({ providerId, apiKey, model, systemPrompt, userPrompt, signal }) {
  const p = getProvider(providerId);
  if (p.needsKey && !(apiKey || "").trim()) {
    throw new Error(`No ${p.label} API key set. Open Settings and paste your key${p.keyUrl ? ` — get one at ${p.keyUrl}` : ""}.`);
  }
  if (p.kind === "gemini") return geminiGenerate({ apiKey, model, systemPrompt, userPrompt, signal });
  return openaiGenerate({ provider: p, apiKey, model, systemPrompt, userPrompt, signal });
}
