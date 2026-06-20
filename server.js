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
const admin = require("firebase-admin");

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
const recentIncidents = []; // non-consuming feed for the monitor dashboard (capped)

// Per-user safe word. In-memory + a single "demo" key here; in production store
// per authenticated user (and treat it as sensitive — knowing it defeats it).
const safeWords = new Map(); // userId -> safeWord
const DEFAULT_USER = "demo";

// Firebase Admin — for writing incident docs the emergency contact's device
// listens to (onSnapshot / FCM). Optional: with no credentials the server still
// runs the in-memory demo path. Provide a service-account key one of two ways:
//   FIREBASE_SERVICE_ACCOUNT=/path/to/serviceAccount.json
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json  (ADC)
let db = null;
try {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  const opts = {};
  if (saPath) opts.credential = admin.credential.cert(require(path.resolve(saPath)));
  if (process.env.FIREBASE_STORAGE_BUCKET) opts.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (saPath || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp(opts); // ADC when no explicit credential
    db = admin.firestore();
  }
} catch (err) {
  console.error("Firebase init failed:", err.message);
  db = null;
}

// Write the incident the contact's app/dashboard listens to. Returns the doc id.
async function writeIncident(incident) {
  if (!db) return null;
  const ref = await db.collection("incidents").add({
    ...incident,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return ref.id;
}

// Reach the emergency contact from the SERVER (works even if her phone is taken).
// The Firestore doc above already pushes to the contact's app via onSnapshot/FCM.
// Add outbound SMS / call here (Twilio, or a Vapi outbound call) — env-gated so
// it stays a no-op until you wire credentials.
async function notifyEmergencyContact(incident) {
  // TODO: if (process.env.TWILIO_ACCOUNT_SID) { ...send SMS / place call... }
  console.log("📣 notifyEmergencyContact (Firestore doc is the contact channel):", incident.incidentId || "(no-db)");
}

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
async function handleVapiTool(req, res, body) {
  if (VAPI_SECRET && req.headers["x-vapi-secret"] !== VAPI_SECRET) {
    return sendJson(res, 401, { error: "bad_secret" });
  }

  const msg = body.message || {};
  // Vapi has shipped a couple of shapes; accept both.
  const calls = msg.toolCallList || msg.toolCalls || [];
  const callId = (msg.call && msg.call.id) || null;
  // The app should set assistantOverrides.metadata = { userId } when starting the call.
  const callMeta = (msg.call && msg.call.metadata) || {};

  const results = [];
  for (const call of calls) {
    const name = call.name || (call.function && call.function.name);
    if (name !== "trigger_safety_flag") continue;

    let args = call.arguments || (call.function && call.function.arguments) || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }

    const userId = callMeta.userId || args.userId || DEFAULT_USER;
    const event = {
      flag: 1,
      userId,
      safeWordHeard: args.safeWordHeard || null,
      callId,
      source: "vapi",
      at: new Date().toISOString()
    };

    // Girl's-app instant path (in-memory poll / her own device).
    latestSafetyEvent = event;
    if (callId) safetyEventsByCall.set(callId, event);
    recentIncidents.unshift(event); // viewer feed (non-consuming)
    if (recentIncidents.length > 20) recentIncidents.length = 20;
    console.log("🚨 safe word flag raised", event);

    // Contact-side path: durable incident in Firestore + outbound notify.
    try {
      const incidentId = await writeIncident(event);
      if (incidentId) event.incidentId = incidentId;
      await notifyEmergencyContact({ ...event, incidentId });
    } catch (err) {
      console.error("incident write/notify failed:", err.message);
      // Still ack the tool so Vapi doesn't retry-storm; the in-memory flag stands.
    }

    results.push({ toolCallId: call.id, result: { ok: true } });
  }

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

// Save the user's chosen safe word.
function handleSafeWordSet(req, res, body) {
  const userId = (body.userId || DEFAULT_USER).toString();
  const safeWord = (body.safeWord || "").toString().trim();
  if (!safeWord) return sendJson(res, 400, { error: "missing_safe_word" });
  if (safeWord.length > 40) return sendJson(res, 400, { error: "too_long" });
  safeWords.set(userId, safeWord);
  sendJson(res, 200, { ok: true, userId, safeWord });
}

// Transcribe a recording of the user saying their safe word, using Deepgram —
// the same engine Vapi uses live, so the stored text matches what Vapi will hear.
// Returns the transcript for the app to CONFIRM, then it POSTs /api/safe-word.
async function handleSafeWordAudio(req, res, audioBuffer) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return sendJson(res, 501, { error: "deepgram_not_configured" });
  if (!audioBuffer || !audioBuffer.length) return sendJson(res, 400, { error: "no_audio" });

  const url = new URL(req.url, "http://localhost");
  const userId = url.searchParams.get("userId") || DEFAULT_USER;
  const contentType = req.headers["content-type"] || "audio/webm";
  const model = process.env.DEEPGRAM_MODEL || "nova-3"; // match this in Vapi's transcriber

  let transcript = "";
  try {
    const dg = await fetch(
      `https://api.deepgram.com/v1/listen?model=${model}&punctuate=false&smart_format=false`,
      { method: "POST", headers: { Authorization: `Token ${apiKey}`, "Content-Type": contentType }, body: audioBuffer }
    );
    if (!dg.ok) {
      console.error("Deepgram error:", dg.status, await dg.text());
      return sendJson(res, 502, { error: "transcription_failed" });
    }
    const data = await dg.json();
    transcript = (data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  } catch (err) {
    console.error("Deepgram request failed:", err.message);
    return sendJson(res, 502, { error: "transcription_failed" });
  }

  // Optionally archive the clip for reference (audit / re-listen).
  let audioPath = null;
  if (db && process.env.FIREBASE_STORAGE_BUCKET) {
    try {
      audioPath = `safe-word-audio/${userId}-${Date.now()}.webm`;
      await admin.storage().bucket().file(audioPath).save(audioBuffer, { contentType });
    } catch (err) {
      console.error("audio archive failed:", err.message);
      audioPath = null;
    }
  }

  sendJson(res, 200, { userId, transcript, audioPath });
}

// Read it back — call this at call start to inject into Vapi variableValues.
function handleSafeWordGet(req, res) {
  const url = new URL(req.url, "http://localhost");
  const userId = url.searchParams.get("userId") || DEFAULT_USER;
  sendJson(res, 200, { userId, safeWord: safeWords.get(userId) || null });
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

function readRawBody(req, res, onBody) {
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 5e6) return req.destroy(); // cap audio at ~5MB
    chunks.push(chunk);
  });
  req.on("end", () => onBody(Buffer.concat(chunks)));
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];

  if (req.method === "POST" && pathname === "/api/mum-call") {
    return readJsonBody(req, res, (body) => handleMumCall(req, res, body));
  }

  if (req.method === "POST" && pathname === "/vapi/tools") {
    return readJsonBody(req, res, (body) =>
      handleVapiTool(req, res, body).catch((err) => {
        console.error("vapi tool handler error:", err.message);
        if (!res.headersSent) sendJson(res, 500, { error: "tool_failed" });
      })
    );
  }

  if (req.method === "GET" && pathname === "/api/safety-flag") {
    return handleSafetyFlagPoll(req, res);
  }

  if (req.method === "GET" && pathname === "/api/incidents") {
    return sendJson(res, 200, { incidents: recentIncidents });
  }

  if (req.method === "POST" && pathname === "/api/safe-word/audio") {
    return readRawBody(req, res, (buf) =>
      handleSafeWordAudio(req, res, buf).catch((err) => {
        console.error("safe-word audio error:", err.message);
        if (!res.headersSent) sendJson(res, 500, { error: "audio_failed" });
      })
    );
  }

  if (req.method === "POST" && pathname === "/api/safe-word") {
    return readJsonBody(req, res, (body) => handleSafeWordSet(req, res, body));
  }

  if (req.method === "GET" && pathname === "/api/safe-word") {
    return handleSafeWordGet(req, res);
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
