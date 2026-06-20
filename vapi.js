// Vapi Web SDK integration — runs the "Mummy" companion call in-app (WebRTC).
// Loaded as an ES module (no build step) from the esm.sh CDN.
//
// ▶ ONE thing to fill in: your Vapi PUBLIC key.
//   Vapi dashboard → Account / API Keys → copy the PUBLIC key (safe in a browser).
//   Paste it below. The assistant ID is already your "Mummy Safety Call" agent.

import Vapi from "https://esm.sh/@vapi-ai/web@2.5.2";

const VAPI_PUBLIC_KEY = "ff25f71c-4646-4979-873d-f0442bcc000c";
const ASSISTANT_ID = "9788099c-ce08-4e1c-961f-4bd1b4cb1c65";
const USER_ID = "demo"; // swap for your real authenticated user id

const configured = VAPI_PUBLIC_KEY && !VAPI_PUBLIC_KEY.startsWith("PASTE");
let vapi = null;

function getVapi() {
  if (!vapi) {
    vapi = new Vapi(VAPI_PUBLIC_KEY);
    vapi.on("call-start", () => console.log("📞 Mummy call connected"));
    vapi.on("call-end", () => console.log("📞 Mummy call ended"));
    vapi.on("error", (e) => console.error("Vapi error:", e));

    // Instant in-app reaction: the agent fires trigger_safety_flag the moment it
    // hears the safe word — we get that event here over the call, no server round trip.
    vapi.on("message", (msg) => {
      const calls = msg?.toolCalls || msg?.toolCallList || [];
      const named = (c) => c?.name || c?.function?.name;
      const heard =
        (msg?.type === "tool-calls" && calls.some((c) => named(c) === "trigger_safety_flag")) ||
        (msg?.type === "function-call" && msg?.functionCall?.name === "trigger_safety_flag");
      if (heard && typeof window.glimSafeWordDetected === "function") {
        window.glimSafeWordDetected();
      }
    });
  }
  return vapi;
}

// Exposed for app.js (classic script) to call.
window.vapiConfigured = () => configured;

window.startMummyCall = async () => {
  if (!configured) {
    console.warn("Vapi public key not set in vapi.js — falling back to simulated call.");
    return false;
  }
  let safeWord = "bestie";
  try {
    const res = await fetch("/api/safe-word");
    const data = await res.json();
    if (data.safeWord) safeWord = data.safeWord;
  } catch {
    /* no backend — use default */
  }
  getVapi().start(ASSISTANT_ID, {
    metadata: { userId: USER_ID },
    variableValues: { SAFE_WORD: safeWord }
    // voice override goes here too, e.g.:
    // voice: { provider: "vapi", voiceId: "Elliot", speed: 1.1 }
  });
  return true;
};

window.stopMummyCall = () => {
  if (vapi) vapi.stop();
};
