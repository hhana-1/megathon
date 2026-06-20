const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  screen: "home",
  protection: false,
  checkInTotal: 300,
  checkInRemaining: 0,
  responseWindow: 12,
  callIncoming: false,
  callActive: false,
  callRemaining: 0,
  callSeconds: 0,
  alertActive: false,
  alertRemaining: 0,
  emergency: false,
  recording: false,
  simulatedRecording: false,
  evidenceMode: "idle",
  localBufferBytes: 0,
  uploadCount: 0,
  locationText: "Location ready",
  disguise: false,
  settings: {
    autoRecord: true,
    fakeCall: true,
    contactAlarm: true,
    liveLocation: true
  },
  contacts: [
    { id: 1, name: "Mom", relation: "Primary", app: true, notified: false },
    { id: 2, name: "Sarah", relation: "Friend", app: true, notified: false },
    { id: 3, name: "Maya", relation: "Roommate", app: false, notified: false }
  ],
  history: [],
  uploads: []
};

let ticker = null;
let holdTimer = null;
let holdProgress = null;
let mediaRecorder = null;
let mediaStream = null;
let evidenceRequestTimer = null;
let simulatedEvidenceTimer = null;
let evidenceBuffer = [];
let recordingStopPolicy = null;
let audioContext = null;
let toneTimer = null;
let promptTimer = null;
let callConversation = [];
let safetyPollTimer = null;

const flow = [
  "Protection mode starts",
  "Timed fake call appears",
  "No response starts safety check",
  "Trusted contacts receive alert",
  "Buffered audio uploads only on SOS"
];

const prompts = [
  "I am here with you. Keep walking toward the bright area.",
  "Tell me the street name if you can see one.",
  "Stay on the line. I can hear you.",
  "Move toward people or an open shop if possible.",
  "I will keep talking until you feel safe."
];

function init() {
  bindEvents();
  hydrateSettings();
  loadSafeWord();
  addHistory("Demo ready", "Set up Glim prototype");
  render();
  ticker = window.setInterval(tick, 1000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => setScreen(button.dataset.tab));
  });

  $("#protectionToggle").addEventListener("click", handleProtectionToggle);
  $("#confirmWalkingMode").addEventListener("click", confirmWalkingMode);
  $("#cancelWalkingMode").addEventListener("click", hideWalkingModeDialog);
  $("#fakeCallNow").addEventListener("click", () => startIncomingCall("manual"));
  $("#mummyCall").addEventListener("click", handleMummyCall);
  $("#safeButton").addEventListener("click", markSafe);
  $("#confirmSafe").addEventListener("click", markSafe);
  $("#shareLocation").addEventListener("click", captureLocation);
  $("#recordToggle").addEventListener("click", toggleRecording);
  $("#recordSafeWord").addEventListener("click", recordSafeWord);
  $("#answerCall").addEventListener("click", answerCall);
  $("#declineCall").addEventListener("click", () => beginSafetyCheck("call_declined"));
  $("#endCall").addEventListener("click", endCall);
  $("#addContact").addEventListener("click", addDemoContact);
  $("#disguiseButton").addEventListener("click", () => setDisguise(!state.disguise));

  $("#timerRange").addEventListener("input", (event) => {
    state.checkInTotal = Number(event.target.value);
    if (!state.protection) state.checkInRemaining = 0;
    render();
  });

  $("#responseRange").addEventListener("input", (event) => {
    state.responseWindow = Number(event.target.value);
    render();
  });

  $("#autoRecordToggle").addEventListener("change", (event) => {
    state.settings.autoRecord = event.target.checked;
    render();
  });

  $("#fakeCallToggle").addEventListener("change", (event) => {
    state.settings.fakeCall = event.target.checked;
    render();
  });

  $("#contactAlarmToggle").addEventListener("change", (event) => {
    state.settings.contactAlarm = event.target.checked;
    render();
  });

  $("#locationToggle").addEventListener("change", (event) => {
    state.settings.liveLocation = event.target.checked;
    render();
  });

  $("#disguiseToggle").addEventListener("change", (event) => {
    setDisguise(event.target.checked);
  });

  const sos = $("#sosButton");
  sos.addEventListener("pointerdown", startSosHold);
  sos.addEventListener("pointerup", cancelSosHold);
  sos.addEventListener("pointerleave", cancelSosHold);
  sos.addEventListener("pointercancel", cancelSosHold);
}

function hydrateSettings() {
  $("#timerRange").value = state.checkInTotal;
  $("#responseRange").value = state.responseWindow;
  $("#autoRecordToggle").checked = state.settings.autoRecord;
  $("#fakeCallToggle").checked = state.settings.fakeCall;
  $("#contactAlarmToggle").checked = state.settings.contactAlarm;
  $("#locationToggle").checked = state.settings.liveLocation;
  $("#disguiseToggle").checked = state.disguise;
}

function tick() {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (state.protection && !state.callIncoming && !state.callActive && !state.alertActive && !state.emergency) {
    state.checkInRemaining -= 1;
    if (state.checkInRemaining <= 0) {
      if (state.settings.fakeCall) startIncomingCall("timer");
      else beginSafetyCheck("timer");
    }
  }

  if (state.callIncoming) {
    state.callRemaining -= 1;
    if (state.callRemaining <= 0) beginSafetyCheck("call_timeout");
  }

  if (state.callActive) {
    state.callSeconds += 1;
    if (state.callSeconds >= 36) endCall();
  }

  if (state.alertActive) {
    state.alertRemaining -= 1;
    if (state.alertRemaining <= 0) escalateEmergency();
  }

  render();
}

function setScreen(screen) {
  state.screen = screen;
  render();
}

function handleProtectionToggle() {
  if (state.protection) {
    toggleProtection();
    return;
  }

  showWalkingModeDialog();
}

function showWalkingModeDialog() {
  $("#walkingModeDialog").classList.add("is-visible");
}

function hideWalkingModeDialog() {
  $("#walkingModeDialog").classList.remove("is-visible");
}

function confirmWalkingMode() {
  hideWalkingModeDialog();
  toggleProtection();
}

function toggleProtection() {
  unlockAudio();
  state.protection = !state.protection;
  state.checkInRemaining = state.protection ? state.checkInTotal : 0;

  if (state.protection) {
    addHistory("Walking mode on", "Check-in timer started");
    if (state.settings.autoRecord) startRecording("buffer");
    startSafetyPoll();
  } else {
    addHistory("Walking mode off", "Protection paused");
    stopRecording({ discard: true });
    stopSafetyPoll();
    clearAlertState();
  }

  render();
}

// Watch the backend for a safe-word flag raised by the Vapi "Mummy" call.
// When the agent calls trigger_safety_flag, escalate to trusted contacts.
function startSafetyPoll() {
  stopSafetyPoll();
  safetyPollTimer = window.setInterval(checkSafetyFlag, 2500);
}

function stopSafetyPoll() {
  window.clearInterval(safetyPollTimer);
  safetyPollTimer = null;
}

async function checkSafetyFlag() {
  if (state.emergency) return; // already escalated
  try {
    const response = await fetch("/api/safety-flag");
    if (!response.ok) return;
    const data = await response.json();
    if (data.flag === 1) {
      addHistory("Safe word detected", "Mummy call flagged danger");
      escalateEmergency();
    }
  } catch {
    // backend unreachable — ignore, demo continues without Vapi
  }
}

function markSafe() {
  if (typeof window.stopMummyCall === "function") window.stopMummyCall();
  stopTone();
  stopPromptTimer();
  stopRecording({ discard: true });
  state.alertActive = false;
  state.callIncoming = false;
  state.callActive = false;
  state.emergency = false;
  state.contacts.forEach((contact) => {
    contact.notified = false;
  });

  if (state.protection) {
    state.checkInRemaining = state.checkInTotal;
    if (state.settings.autoRecord) startRecording("buffer");
    startSafetyPoll();
  }

  $("#incomingCall").classList.remove("is-visible");
  $("#activeCall").classList.remove("is-visible");
  $("#alertOverlay").classList.remove("is-visible");
  document.body.classList.remove("is-emergency");
  addHistory("Safety confirmed", "Check-in reset");
  render();
}

function startIncomingCall(source) {
  if (state.callIncoming || state.callActive || state.alertActive) return;
  unlockAudio();
  state.callIncoming = true;
  state.callRemaining = state.responseWindow;
  $("#callerName").textContent = chooseCaller().name;
  $("#incomingCall").classList.add("is-visible");
  startTone("ring");
  addHistory("Fake call", source === "timer" ? "Scheduled check-in call" : "Manual demo call");
  render();
}

function answerCall() {
  stopTone();
  state.callIncoming = false;
  state.callActive = true;
  state.callSeconds = 0;
  const caller = chooseCaller();
  $("#activeCaller").textContent = caller.name;
  $("#incomingCall").classList.remove("is-visible");
  $("#activeCall").classList.add("is-visible");
  addHistory("Fake call answered", "Companion voice connected");
  callConversation = [];
  speakPrompt("answered");
  promptTimer = window.setInterval(() => speakPrompt("checkin"), 9000);
  render();
}

// Start the real Vapi "Mummy" call (in-app WebRTC). Falls back to the simulated
// incoming-call flow if Vapi isn't configured yet (no public key in vapi.js).
function handleMummyCall() {
  unlockAudio();
  if (typeof window.startMummyCall === "function" && window.vapiConfigured && window.vapiConfigured()) {
    addHistory("Mum call starting", "Connecting AI companion…");
    window.startMummyCall().then((started) => {
      if (!started) startIncomingCall("manual");
    });
  } else {
    startIncomingCall("manual");
  }
}

// Called by vapi.js the instant the agent hears the safe word — escalate now.
window.glimSafeWordDetected = function () {
  if (state.emergency) return;
  addHistory("Safe word detected", "Mummy call flagged danger");
  escalateEmergency();
};

function endCall() {
  if (typeof window.stopMummyCall === "function") window.stopMummyCall();
  stopPromptTimer();
  state.callActive = false;
  $("#activeCall").classList.remove("is-visible");
  if (state.protection) {
    state.checkInRemaining = state.checkInTotal;
  }
  addHistory("Call ended", "Walking mode continues");
  render();
}

function beginSafetyCheck(reason) {
  stopTone();
  stopPromptTimer();
  state.callIncoming = false;
  state.callActive = false;
  state.alertActive = true;
  state.alertRemaining = state.responseWindow;
  $("#incomingCall").classList.remove("is-visible");
  $("#activeCall").classList.remove("is-visible");
  $("#alertOverlay").classList.add("is-visible");
  addHistory("No response", reason.replaceAll("_", " "));
  render();
}

function escalateEmergency() {
  state.alertActive = false;
  state.emergency = true;
  document.body.classList.add("is-emergency");
  $("#alertOverlay").classList.remove("is-visible");

  state.contacts.forEach((contact) => {
    contact.notified = true;
  });

  if (state.settings.liveLocation) captureLocation();
  if (state.settings.autoRecord) {
    if (state.recording) promoteEvidenceToCloud();
    else startRecording("cloud");
  }
  if (state.settings.contactAlarm) startTone("alarm");

  addHistory("Emergency alert sent", `${state.contacts.length} trusted contacts notified`);
  render();
}

function clearAlertState() {
  state.callIncoming = false;
  state.callActive = false;
  state.alertActive = false;
  state.emergency = false;
  state.contacts.forEach((contact) => {
    contact.notified = false;
  });
  $("#incomingCall").classList.remove("is-visible");
  $("#activeCall").classList.remove("is-visible");
  $("#alertOverlay").classList.remove("is-visible");
  document.body.classList.remove("is-emergency");
  stopTone();
  stopPromptTimer();
}

function startSosHold() {
  unlockAudio();
  const button = $("#sosButton");
  const start = performance.now();
  button.classList.add("is-holding");

  holdProgress = window.setInterval(() => {
    const elapsed = performance.now() - start;
    const degrees = Math.min(360, (elapsed / 2000) * 360);
    button.style.setProperty("--hold", `${degrees}deg`);
  }, 24);

  holdTimer = window.setTimeout(() => {
    cancelSosHold();
    escalateEmergency();
  }, 2000);
}

function cancelSosHold() {
  window.clearTimeout(holdTimer);
  window.clearInterval(holdProgress);
  holdTimer = null;
  holdProgress = null;
  const button = $("#sosButton");
  button.classList.remove("is-holding");
  button.style.setProperty("--hold", "0deg");
}

async function toggleRecording() {
  if (state.recording) {
    stopRecording({ discard: !state.emergency });
  } else {
    await startRecording(state.emergency ? "cloud" : "buffer");
  }
}

async function startRecording(mode = "buffer") {
  if (state.recording) {
    if (mode === "cloud") promoteEvidenceToCloud();
    return;
  }

  state.recording = true;
  state.simulatedRecording = false;
  state.evidenceMode = mode;
  recordingStopPolicy = null;
  addHistory(mode === "cloud" ? "Recording upload started" : "Private buffer started", mode === "cloud" ? "Evidence stream open" : "Deletes when safe is confirmed");
  render();

  try {
    if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error("Recorder unavailable");
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) handleEvidenceChunk(event.data, event.data.size, mediaRecorder.mimeType || "audio/webm");
    };
    mediaRecorder.onstop = () => {
      recordingStopPolicy = null;
    };
    mediaRecorder.start();
    evidenceRequestTimer = window.setInterval(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.requestData();
    }, 5000);
  } catch (error) {
    state.simulatedRecording = true;
    simulatedEvidenceTimer = window.setInterval(() => {
      handleEvidenceChunk(null, 48000 + Math.round(Math.random() * 24000), "simulated/audio");
    }, 5000);
  }
}

function stopRecording({ discard = false } = {}) {
  if (!state.recording && evidenceBuffer.length === 0) return;

  const modeOnStop = state.evidenceMode;
  const discardedBytes = state.localBufferBytes;
  recordingStopPolicy = { discard, mode: modeOnStop };
  state.recording = false;
  state.simulatedRecording = false;
  state.evidenceMode = "idle";

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (discard) discardEvidenceBuffer();
  window.clearInterval(evidenceRequestTimer);
  window.clearInterval(simulatedEvidenceTimer);
  mediaRecorder = null;
  mediaStream = null;
  evidenceRequestTimer = null;
  simulatedEvidenceTimer = null;
  addHistory(discard ? "Private audio deleted" : "Recording stopped", discard ? `${Math.round(discardedBytes / 1024)} KB discarded locally` : "Evidence stream closed");
  render();
}

function handleEvidenceChunk(data, size, type) {
  const effectiveMode = recordingStopPolicy?.mode || state.evidenceMode;

  if (recordingStopPolicy?.discard || effectiveMode === "idle") return;

  if (effectiveMode === "cloud" || state.emergency) {
    uploadEvidence(size, type);
    return;
  }

  evidenceBuffer.push({ data, size, type, at: Date.now() });
  state.localBufferBytes += size;
  render();
}

function promoteEvidenceToCloud() {
  if (state.evidenceMode === "cloud") return;

  const buffered = [...evidenceBuffer];
  evidenceBuffer = [];
  state.localBufferBytes = 0;
  state.evidenceMode = "cloud";

  buffered.forEach((chunk) => uploadEvidence(chunk.size, chunk.type));
  addHistory("Private buffer uploaded", `${buffered.length} saved chunks sent as evidence`);
  render();
}

function discardEvidenceBuffer() {
  evidenceBuffer = [];
  state.localBufferBytes = 0;
}

function chooseMimeType() {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

// Record the user saying their safe word, transcribe it server-side (Deepgram),
// and store the heard text. That text is what you inject into Vapi as SAFE_WORD.
async function recordSafeWord() {
  const label = $("#safeWordValue");
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    label.textContent = "Recording not supported on this browser";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = chooseMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      uploadSafeWordAudio(blob);
    };

    label.textContent = "Listening… say your safe word";
    recorder.start();
    window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, 3500);
  } catch (err) {
    label.textContent = "Microphone unavailable";
  }
}

async function uploadSafeWordAudio(blob) {
  const label = $("#safeWordValue");
  label.textContent = "Transcribing…";
  try {
    const transcribe = await fetch("/api/safe-word/audio", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      body: blob
    });
    const data = await transcribe.json();

    if (transcribe.status === 501) {
      label.textContent = "Transcription not configured on the server";
      return;
    }
    const word = (data.transcript || "").trim().toLowerCase();
    if (!transcribe.ok || !word) {
      label.textContent = "Didn't catch a word — tap Record to retry";
      return;
    }

    await fetch("/api/safe-word", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ safeWord: word })
    });
    label.textContent = `Safe word: "${word}" (tap Record to change)`;
    addHistory("Safe word set", `Heard as "${word}"`);
  } catch (err) {
    label.textContent = "Couldn't reach the server";
  }
}

async function loadSafeWord() {
  try {
    const response = await fetch("/api/safe-word");
    if (!response.ok) return;
    const data = await response.json();
    if (data.safeWord) $("#safeWordValue").textContent = `Safe word: "${data.safeWord}" (tap Record to change)`;
  } catch {
    // server not running (static-only mode) — leave "Not set"
  }
}

function uploadEvidence(size, type) {
  state.uploadCount += 1;
  state.uploads.unshift({
    id: state.uploadCount,
    title: `Chunk ${String(state.uploadCount).padStart(2, "0")} uploaded`,
    detail: `${Math.round(size / 1024)} KB · ${type}`,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  });

  if (state.uploads.length > 8) state.uploads.length = 8;
  render();
}

function captureLocation() {
  if (!navigator.geolocation) {
    state.locationText = "Demo location: 52.3676, 4.9041";
    addHistory("Location ready", state.locationText);
    render();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude.toFixed(5);
      const lng = position.coords.longitude.toFixed(5);
      state.locationText = `${lat}, ${lng}`;
      addHistory("Location ready", state.locationText);
      render();
    },
    () => {
      state.locationText = "Demo location: 52.3676, 4.9041";
      addHistory("Location ready", state.locationText);
      render();
    },
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 5000 }
  );
}

function addDemoContact() {
  const names = ["Lina", "Nora", "Ava", "Grace", "Emma"];
  const index = state.contacts.length % names.length;
  state.contacts.push({
    id: Date.now(),
    name: names[index],
    relation: "Trusted",
    app: index % 2 === 0,
    notified: false
  });
  addHistory("Contact added", names[index]);
  render();
}

function chooseCaller() {
  return state.contacts.find((contact) => contact.app) || state.contacts[0];
}

function addHistory(title, detail) {
  state.history.unshift({
    id: Date.now() + Math.random(),
    title,
    detail,
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  });
  if (state.history.length > 12) state.history.length = 12;
}

function setDisguise(enabled) {
  state.disguise = enabled;
  document.body.classList.toggle("disguise", enabled);
  $("#disguiseToggle").checked = enabled;
  addHistory(enabled ? "Disguise mode on" : "Disguise mode off", enabled ? "Timer view enabled" : "Glim view restored");
  render();
}

async function speakPrompt(event) {
  const text = await fetchMumLine(event);
  if (!state.callActive) return; // call ended while we were waiting
  callConversation.push(text);
  sayLine(text);
}

async function fetchMumLine(event) {
  try {
    const response = await fetch("/api/mum-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        caller: chooseCaller().name,
        event: event || "checkin",
        spoken: callConversation
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.reply) return data.reply;
    throw new Error("empty reply");
  } catch (err) {
    // Offline / no backend / API error: fall back to the static demo lines.
    return prompts[Math.floor(Math.random() * prompts.length)];
  }
}

function sayLine(text) {
  $("#voicePrompt").textContent = text;

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.92;
    utterance.pitch = 0.96;
    window.speechSynthesis.speak(utterance);
  }
}

function stopPromptTimer() {
  window.clearInterval(promptTimer);
  promptTimer = null;
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function unlockAudio() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") audioContext.resume();
}

function startTone(kind) {
  stopTone();
  unlockAudio();
  const play = () => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = kind === "alarm" ? "sawtooth" : "sine";
    oscillator.frequency.value = kind === "alarm" ? 780 : 440;
    gain.gain.setValueAtTime(0.001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(kind === "alarm" ? 0.12 : 0.06, audioContext.currentTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.42);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.46);
  };

  play();
  toneTimer = window.setInterval(play, kind === "alarm" ? 620 : 1300);
}

function stopTone() {
  window.clearInterval(toneTimer);
  toneTimer = null;
}

function formatTime(seconds) {
  if (!seconds || seconds < 0) return "--:--";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;

  if (mins > 0 && secs > 0) return `${mins} min ${secs} sec`;
  if (mins > 0) return `${mins} min`;
  return `${seconds} sec`;
}

function render() {
  $$(".screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.dataset.screen === state.screen);
  });

  $$(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.tab === state.screen);
  });

  $("#homeTitle").textContent = state.disguise
    ? "Timer"
    : state.emergency
      ? "Emergency alert sent"
      : state.protection
        ? "You are protected"
        : "Ready when you are";
  $("#modePill").classList.toggle("is-off", !state.protection);
  $("#modePill").innerHTML = `<span></span> ${state.protection ? "Walking mode on" : "Walking mode off"}`;
  $("#checkinTime").textContent = formatTime(state.checkInRemaining);
  $("#protectionToggle strong").textContent = state.protection ? "Pause walk" : "Start walk";
  $("#recordLabel").textContent = state.recording ? "Stop" : "Record";
  $("#recordDot").classList.toggle("is-on", state.recording);
  $("#timerValue").textContent = formatDuration(state.checkInTotal);
  $("#responseValue").textContent = `${state.responseWindow} sec`;
  $("#callCountdown").textContent = state.callRemaining;
  $("#callTimer").textContent = formatTime(state.callSeconds);
  $("#alertCountdown").textContent = String(Math.max(0, state.alertRemaining)).padStart(2, "0");
  $("#contactStatus").textContent = state.emergency ? "Notified" : "Ready";

  $("#incidentState").textContent = state.emergency ? "Escalated" : state.alertActive ? "Checking" : state.callIncoming ? "Calling" : state.protection ? "Active" : "Idle";
  $("#uploadState").textContent =
    state.evidenceMode === "buffer"
      ? "Private"
      : state.evidenceMode === "cloud"
        ? state.simulatedRecording
          ? "Simulated"
          : "Uploading"
        : state.uploads.length
          ? "Synced"
          : "Waiting";
  $("#alarmState").textContent = state.emergency && state.settings.contactAlarm ? "Alarming" : "Standby";

  renderContacts();
  renderHistory();
  renderUploads();
  renderFlow();
  renderCompanionAlert();
}

function renderContacts() {
  const homeContacts = state.contacts.slice(0, 3).map((contact) => contactTemplate(contact, true)).join("");
  $("#homeContacts").innerHTML = homeContacts;

  $("#contactsList").innerHTML = state.contacts
    .map((contact) => {
      const badge = contact.app ? '<span class="pill app">App</span>' : '<span class="pill">SMS</span>';
      return `
        <article class="contact-card">
          <span class="initial">${contact.name[0]}</span>
          <div>
            <strong>${contact.name}</strong>
            <small>${contact.relation}${contact.notified ? " · notified" : ""}</small>
          </div>
          ${badge}
        </article>
      `;
    })
    .join("");
}

function contactTemplate(contact) {
  return `
    <article class="mini-contact">
      <span class="initial">${contact.name[0]}</span>
      <div>
        <strong>${contact.name}</strong>
        <small>${contact.relation}${contact.notified ? " · notified" : ""}</small>
      </div>
      <span class="online-dot" title="${contact.app ? "App installed" : "SMS fallback"}"></span>
    </article>
  `;
}

function renderHistory() {
  const items = state.history.length
    ? state.history
    : [{ title: "No events yet", detail: "Start walking mode", time: "--:--" }];

  $("#historyList").innerHTML = items
    .map(
      (item) => `
        <article class="history-item">
          <span class="history-icon">S</span>
          <div>
            <strong>${item.title}</strong>
            <small>${item.detail}</small>
          </div>
          <small>${item.time}</small>
        </article>
      `
    )
    .join("");
}

function renderUploads() {
  const items = state.uploads.length
    ? state.uploads
    : state.evidenceMode === "buffer"
      ? [
          {
            title: "Private buffer active",
            detail: `${Math.round(state.localBufferBytes / 1024)} KB local only, deleted when safe`,
            time: "--:--"
          }
        ]
      : [{ title: "No evidence uploaded", detail: "Audio uploads only after SOS", time: "--:--" }];

  $("#cloudLog").innerHTML = items
    .map(
      (item) => `
        <article class="cloud-item">
          <span class="cloud-icon">C</span>
          <div>
            <strong>${item.title}</strong>
            <small>${item.detail} · ${item.time}</small>
          </div>
        </article>
      `
    )
    .join("");
}

function renderFlow() {
  const done = [
    state.protection,
    state.callIncoming || state.callActive || state.alertActive || state.emergency,
    state.alertActive || state.emergency,
    state.emergency,
    state.evidenceMode === "cloud" || state.uploads.length > 0
  ];

  $("#flowSteps").innerHTML = flow
    .map((step, index) => `<li class="${done[index] ? "is-done" : ""}">${step}</li>`)
    .join("");
}

function renderCompanionAlert() {
  const alert = $("#companionAlert");
  const appContacts = state.contacts.filter((contact) => contact.app);
  const alarming = state.emergency && state.settings.contactAlarm;
  alert.classList.toggle("is-alarming", alarming);
  alert.innerHTML = `
    <span class="alert-light"></span>
    <div>
      <strong>${alarming ? "Alarm active on contact phones" : "No active alarm"}</strong>
      <p>${alarming ? `${appContacts.length} app contacts see a loud warning screen.` : "Contacts with the app will receive a loud warning state."}</p>
    </div>
  `;
}

window.addEventListener("beforeunload", () => {
  stopTone();
  stopPromptTimer();
  if (state.recording) stopRecording({ discard: true });
});

init();
