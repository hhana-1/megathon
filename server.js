// Glim demo backend.
//
// Serves the static PWA AND the "mum's mockup call" agent endpoint.
// The Anthropic API key lives here, on the server — never ship it to app.js.
//
//   export ANTHROPIC_API_KEY=sk-ant-...
//   npm install
//   npm start            # http://localhost:4173
//
// Endpoint: POST /api/mum-call
//   body: { caller?: string, event?: "answered" | "checkin", spoken?: string[] }
//   resp: { reply: string }

const http = require("http");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// Optional shared secret. If set, Vapi must send the same value in the
// `x-vapi-secret` header (configure it on the tool's server settings in Vapi).
const VAPI_SECRET = process.env.VAPI_SERVER_SECRET || "";

// Safety flags raised by the "safe word" tool during a Vapi call.
// In-memory + consume-once: fine for a demo. For production, persist per-user
// (Firestore/Supabase/etc.) and push to the device instead of polling.
let latestSafetyEvent = null; // { flag, safeWordHeard, callId, at }
const safetyEventsByCall = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const SYSTEM = `You are playing the role of a caring mother on a phone call with your adult
child, who is walking somewhere alone and may feel unsafe. This is a personal-safety app:
the call exists so they look and feel accompanied, and so a real human-sounding voice keeps
them company until they reach safety.

Voice and behaviour:
- Speak as a warm, calm, slightly chatty mum. First person. Never mention being an AI, a model,
  or an app.
- Each turn, say ONE short spoken line — at most 1–2 sentences, the way someone actually talks
  on the phone. No stage directions, no quotation marks, no emoji.
- Keep them company and subtly reassure: stay on the line, head toward light/people/open shops,
  notice street names or landmarks. Don't interrogate; weave check-ins into normal chatter.
- Vary what you say each turn. Don't repeat earlier lines.
- Do NOT give emergency instructions or claim to be calling authorities — a separate part of the
  app handles real escalation. Your job is presence and calm.`;

function buildUserPrompt(body) {
  const caller = body.caller || "Mom";
  const spoken = Array.isArray(body.spoken) ? body.spoken.filter(Boolean) : [];
  const opening = body.event === "answered" || spoken.length === 0;

  let prompt = `You are "${caller}". `;
  if (opening) {
    prompt += `They just picked up. Open the call naturally and warmly — greet them and let them know you're staying on the line.`;
  } else {
    prompt += `The call is ongoing. Say your next natural line to keep them company.`;
  }
  if (spoken.length) {
    prompt += `\n\nLines you have already said this call (do not repeat them):\n- ${spoken.slice(-6).join("\n- ")}`;
  }
  prompt += `\n\nReply with only the spoken line.`;
  return prompt;
}

async function handleMumCall(req, res, body) {
  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 150,
      system: SYSTEM,
      messages: [{ role: "user", content: buildUserPrompt(body) }]
    });

    const reply = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ")
      .trim();

    sendJson(res, 200, { reply });
  } catch (err) {
    const status = err instanceof Anthropic.APIError ? err.status || 502 : 500;
    console.error("mum-call error:", err.message);
    sendJson(res, status, { error: "mum_call_failed" });
  }
}

// Vapi calls this when the assistant detects the safe word and invokes the
// `trigger_safety_flag` tool. Vapi expects: { results: [{ toolCallId, result }] }.
function handleVapiTool(req, res, body) {
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
    return sendJson(res, 401, { error: "bad_secret" });
  }

  const msg = body.message || {};
  // Vapi has shipped a couple of shapes; accept both.
  const calls = msg.toolCallList || msg.toolCalls || [];
  const callId = (msg.call && msg.call.id) || null;

  const results = [];
  for (const call of calls) {
    const name = call.name || (call.function && call.function.name);
    if (name !== "trigger_safety_flag") continue;

    let args = call.arguments || (call.function && call.function.arguments) || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }

    const event = {
      flag: 1,
      safeWordHeard: args.safeWordHeard || null,
      callId,
      at: new Date().toISOString()
    };
    latestSafetyEvent = event;
    if (callId) safetyEventsByCall.set(callId, event);
    console.log("🚨 safe word flag raised", event);

    results.push({ toolCallId: call.id, result: { ok: true } });
  }

  if (!results.length) return sendJson(res, 200, { results: [] });
  sendJson(res, 200, { results });
}

// The app polls this; returns the pending flag once, then clears it.
function handleSafetyFlagPoll(req, res) {
  const url = new URL(req.url, "http://localhost");
  const callId = url.searchParams.get("callId");

  let event = null;
  if (callId && safetyEventsByCall.has(callId)) {
    event = safetyEventsByCall.get(callId);
    safetyEventsByCall.delete(callId);
    if (latestSafetyEvent && latestSafetyEvent.callId === callId) latestSafetyEvent = null;
  } else if (!callId && latestSafetyEvent) {
    event = latestSafetyEvent;
    latestSafetyEvent = null;
  }

  sendJson(res, 200, event ? event : { flag: 0 });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, rel);

  // Block path traversal outside the project root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

function readJsonBody(req, res, onBody) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1e5) req.destroy(); // cap body size
  });
  req.on("end", () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return sendJson(res, 400, { error: "invalid_json" });
    }
    onBody(body);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];

  if (req.method === "POST" && pathname === "/api/mum-call") {
    return readJsonBody(req, res, (body) => handleMumCall(req, res, body));
  }

  if (req.method === "POST" && pathname === "/vapi/tools") {
    return readJsonBody(req, res, (body) => handleVapiTool(req, res, body));
  }

  if (req.method === "GET" && pathname === "/api/safety-flag") {
    return handleSafetyFlagPoll(req, res);
  }

  if (req.method === "GET") return serveStatic(req, res);

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  console.log(`Glim demo on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("⚠  ANTHROPIC_API_KEY is not set — /api/mum-call will fail until you export it.");
  }
});
