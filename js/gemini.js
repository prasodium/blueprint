/* Blueprint — Gemini REST client. Browser -> Google directly, key via header only. */

export const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function extractText(data) {
  const cands = data?.candidates || [];
  const parts = cands[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

function extractJson(text) {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("The model did not return JSON. Try again.");
  return JSON.parse(t.slice(start, end + 1));
}

function friendlyError(status, body) {
  const msg = body?.error?.message || "";
  if (status === 400 && /key/i.test(msg)) return "Gemini rejected the API key. Check it in Settings — get a free one at https://aistudio.google.com/apikey";
  if (status === 400) return "Gemini rejected the request: " + (msg || "bad request");
  if (status === 403) return "Gemini denied the request (403). The key may lack access or the API isn't enabled for it.";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "Gemini rate limit hit (free tier). Wait a minute and try again.";
  return `Gemini error (HTTP ${status}): ${msg || "unknown"}`;
}

/** Call Gemini with JSON-mode output. Throws on failure. */
export async function generateSpec({ apiKey, systemPrompt, userPrompt, signal }) {
  if (!apiKey) throw new Error("No API key set. Open Settings and paste your free Gemini key.");
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 16384 },
  };
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const friendly = friendlyError(res.status, data);
      if (friendly === "MODEL_NOT_FOUND") { lastErr = new Error(`Model ${model} not available, trying fallback…`); continue; }
      throw new Error(friendly);
    }
    const text = extractText(data);
    if (!text.trim()) throw new Error("Gemini returned an empty response. Try again.");
    try {
      return { spec: extractJson(text), model };
    } catch {
      throw new Error("Gemini returned text that wasn't valid JSON. Try again — it usually works on retry.");
    }
  }
  throw lastErr || new Error("No Gemini model responded. Try again later.");
}
