// Vapi Web SDK integration — runs the companion calls in-app (WebRTC).
// Loaded as an ES module (no build step) from the esm.sh CDN.
//
// The public key lives server-side in .env (VAPI_PUBLIC_KEY) and is fetched
// from /api/config below — never hardcoded here, so it doesn't end up
// committed to source control.

import Vapi from "https://esm.sh/@vapi-ai/web@2.5.2";

// Each companion is its own Vapi assistant (same trigger_safety_flag tool,
// same call mechanics below — only the persona/voice configured on the
// assistant in the Vapi dashboard differs).
const ASSISTANTS = {
  mummy: "9788099c-ce08-4e1c-961f-4bd1b4cb1c65",
  habibi: "60f0cc74-827b-48ea-a1e9-f3600664aca3"
};
const USER_ID = "demo"; // swap for your real authenticated user id

let vapiPublicKey = null;
let vapi = null;

// Kick off immediately so the key is loaded well before the user taps a button.
const configLoaded = (async () => {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    vapiPublicKey = data.vapiPublicKey || null;
  } catch {
    vapiPublicKey = null; // no backend — fake call stays the only option
  }
})();

function getVapi() {
  if (!vapi) {
    vapi = new Vapi(vapiPublicKey);
    vapi.on("call-start", () => console.log("📞 companion call connected"));
    vapi.on("call-end", () => console.log("📞 companion call ended"));
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

async function startCall(assistantId) {
  await configLoaded;
  if (!vapiPublicKey) {
    console.warn("VAPI_PUBLIC_KEY not set in .env — falling back to simulated call.");
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
  getVapi().start(assistantId, {
    metadata: { userId: USER_ID },
    variableValues: { SAFE_WORD: safeWord }
    // voice override goes here too, e.g.:
    // voice: { provider: "vapi", voiceId: "Elliot", speed: 1.1 }
  });
  return true;
}

function stopCall() {
  if (vapi) vapi.stop();
}

// Exposed for app.js (classic script) to call.
window.vapiConfigured = () => Boolean(vapiPublicKey);

window.startMummyCall = () => startCall(ASSISTANTS.mummy);
window.stopMummyCall = stopCall;

window.startHabibiCall = () => startCall(ASSISTANTS.habibi);
window.stopHabibiCall = stopCall;
