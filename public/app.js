import { mount, nextTick, ref } from "../src/vendor/li3-web.js";
import DOMPurify from "dompurify";
import { marked } from "marked";

const view = {
  sessions: ref([]),
  selectedId: ref(null),
  sessionSelectionOpen: ref(false),
  sessionTitle: ref("Loading sessions…"),
  sessionMeta: ref(""),
  authUser: ref(""),
  goalCount: ref("(none yet)"),
  goalNotice: ref(""),
  goals: ref([]),
  goalTitle: ref(""),
  goalDescription: ref(""),
  messages: ref([]),
  chatMode: ref(false),
  statusText: ref("Microphone off"),
  voiceState: ref("off"),
  transcriptPreview: ref(""),
  transcriptActive: ref(false),
  draftVisible: ref(false),
  draftText: ref(""),
  draftHint: ref("Microphone off · Nothing is sent until you choose Send."),
  voiceMode: ref(false),
  voiceLabel: ref("Start hands-free"),
  prompt: ref(""),
  sendDisabled: ref(false),
  sendDraftDisabled: ref(true),
  resumeDisabled: ref(false),
  discardDisabled: ref(false),
};

let sessions = [];
let goals = [];
let messages = [];
let selected = null;
let historySession = null;
let recognition;
let voiceMode = false;
let listening = false;
let sending = false;
let speaking = false;
let waitingForReply = false;
let utterance = "";
let interimTranscript = "";
let draftSession = null;
let recognitionStarting = false;
let sessionsRequest = false;
let sessionSignature = "";
let messageSignature = "";
let sendTimer;
let restartTimer;
let replyTimer;
let replyStartedAt = 0;
let messageRequest = 0;
let sendRequest = 0;
let reviewPending = false;
let reviewTimer;
let microphoneTimer;
let voiceGeneration = 0;
let activePlaybackCancel;
let seenMessages = new Set();
let userSub = null;
let conversation;
let player;

const app = mount(document.querySelector("#app-root"), {
  template: document.querySelector("#app-template"),
  setup: () => ({
    ...view,
    openSessionSelection,
    closeSessionSelection,
    toggleChat,
    refreshSessions,
    startNewSession,
    selectSession,
    setGoalTitle,
    setGoalDescription,
    addGoal,
    applyPlan,
    updateGoal,
    deleteGoal,
    sendDraft,
    resumeDictation,
    discardDraft,
    toggleVoice,
    updateDraft,
    updatePrompt,
    sendTypedPrompt,
  }),
});

async function prepareApp() {
  await app.ready;
  conversation = document.querySelector("#conversation");
  player = document.querySelector("#player");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  await init();
}

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return { response, data };
}

function messageDate(value) {
  return value
    ? new Date(value < 1e12 ? value * 1000 : value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

function showStatus(text, state) {
  view.statusText.value = text;
  state ||= speaking
    ? "speaking"
    : sending || waitingForReply
      ? "waiting"
      : listening
        ? "listening"
        : recognitionStarting
          ? "starting"
          : view.draftVisible.value
            ? "review"
            : "off";
  view.voiceState.value = state;
  view.voiceMode.value = voiceMode;
  view.voiceLabel.value = voiceMode ? "Stop voice" : "Start hands-free";
  view.sendDraftDisabled.value = sending || waitingForReply || speaking || !view.draftText.value.trim();
  view.resumeDisabled.value = sending || waitingForReply || speaking;
  view.discardDisabled.value = sending;
  view.sendDisabled.value = sending || waitingForReply || speaking;
}

async function checkAuthAndProperties() {
  try {
    const { data } = await request("/api/auth/status");
    userSub = data.user || null;
    view.authUser.value = userSub || "";
  } catch {
    userSub = null;
    view.authUser.value = "";
  }
}

function updateTranscript() {
  const transcript = [utterance, interimTranscript].filter(Boolean).join(" ");
  view.transcriptActive.value = Boolean(transcript);
  view.transcriptPreview.value = transcript;
}

function transcriptAfterExistingText(transcript, existingText) {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const existingWords = existingText.trim().split(/\s+/).filter(Boolean);
  if (existingWords.length === 0) {
    return words.join(" ");
  }
  if (
    existingWords.length <= words.length &&
    existingWords.every((word, index) => normalizeTranscriptWord(word) === normalizeTranscriptWord(words[index]))
  ) {
    return words.slice(existingWords.length).join(" ");
  }
  return null;
}

function showDraft() {
  clearTimeout(sendTimer);
  clearTimeout(reviewTimer);
  sendTimer = undefined;
  reviewPending = false;
  if (interimTranscript) {
    utterance = `${utterance} ${interimTranscript}`.trim();
    interimTranscript = "";
  }
  updateTranscript();
  if (!utterance.trim()) {
    return;
  }
  if (!view.draftVisible.value || draftSession !== selected) {
    draftSession = selected;
    view.draftText.value = utterance.trim();
  }
  view.draftVisible.value = true;
  stopCapture();
  listening = false;
  showStatus("Review your draft — microphone off");
}

function resumeDictation() {
  if (draftSession !== selected || sending || waitingForReply || speaking) {
    return;
  }
  voiceMode = true;
  utterance = view.draftText.value.trim();
  interimTranscript = "";
  view.draftVisible.value = false;
  updateTranscript();
  startRecognition();
}

function clearDraft() {
  clearTimeout(sendTimer);
  clearTimeout(reviewTimer);
  sendTimer = undefined;
  reviewPending = false;
  draftSession = null;
  view.draftVisible.value = false;
  view.draftText.value = "";
  utterance = "";
  interimTranscript = "";
  updateTranscript();
}

function stopCapture() {
  const current = recognition;
  recognition = null;
  recognitionStarting = false;
  listening = false;
  clearTimeout(microphoneTimer);
  try {
    current?.stop();
  } catch {
    // Chrome may already have closed the capture device.
  }
}

function requestReview() {
  sendTimer = undefined;
  if (!voiceMode || view.draftVisible.value || sending || waitingForReply || speaking) {
    return;
  }
  reviewPending = true;
  listening = false;
  showStatus("Finishing your draft — microphone off", "review");
  reviewTimer = setTimeout(showDraft, 750);
  recognition?.stop();
}

function messageKey(message) {
  return message.id || `${message.role}:${message.time || ""}:${message.text}`;
}

function normalizeTranscriptWord(word) {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function renderSessions() {
  const signature = JSON.stringify(
    sessions.map(({ id, title, directory, status }) => ({ id, title, directory, status, selected: id === selected })),
  );
  if (signature === sessionSignature) {
    return;
  }
  sessionSignature = signature;
  view.sessions.value = sessions;
  view.selectedId.value = selected;
}

function toggleChat() {
  view.chatMode.value = !view.chatMode.value;
}

function openSessionSelection() {
  view.sessionSelectionOpen.value = true;
}

function closeSessionSelection() {
  view.sessionSelectionOpen.value = false;
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(typeof text === "string" ? text : ""), { USE_PROFILES: { html: true } });
}

function renderMessages() {
  const signature = JSON.stringify([selected, messages]);
  if (signature === messageSignature) {
    return;
  }
  messageSignature = signature;
  const previousScroll = conversation.scrollTop;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  view.selectedId.value = selected;
  view.messages.value = messages.map((message) => ({
    ...message,
    html: renderMarkdown(message.text),
    timeLabel: messageDate(message.time),
  }));
  void nextTick().then(() => {
    if (nearBottom) {
      conversation.scrollTop = conversation.scrollHeight;
    } else {
      conversation.scrollTop = previousScroll;
    }
  });
}

async function loadMessages() {
  if (!selected) {
    messages = [];
    renderMessages();
    return;
  }
  const requestID = ++messageRequest;
  try {
    const sessionID = selected;
    const { data } = await request(`/api/sessions/${encodeURIComponent(sessionID)}/messages?limit=40`);
    if (requestID !== messageRequest || sessionID !== selected) {
      return;
    }
    messages = data.messages || [];
    historySession = sessionID;
    renderMessages();
    await maybeReadReply();
  } catch (error) {
    if (requestID === messageRequest) {
      showStatus(error.message);
    }
  }
}

async function refreshSessions() {
  if (sessionsRequest) {
    return;
  }
  sessionsRequest = true;
  try {
    const { data } = await request("/api/sessions");
    sessions = data.sessions || [];
    const previous = selected;
    if (!selected || !sessions.some((session) => session.id === selected)) {
      const saved = localStorage.getItem("openvoice.session");
      const next = sessions.some((session) => session.id === saved) ? saved : sessions[0]?.id || null;
      if (previous !== next) {
        stopVoice(previous ? "Session changed. Tap to continue." : "Microphone off", {
          preserveDraft: false,
        });
        sendRequest++;
        sending = false;
        selected = next;
        view.selectedId.value = selected;
        showStatus(view.statusText.value);
      }
    }
    renderSessions();
    const session = sessions.find((item) => item.id === selected);
    view.sessionTitle.value = session?.title || "No sessions found";
    view.sessionMeta.value = session
      ? `${session.status === "running" ? "Working" : "Ready"} · ${sessions.length} sessions`
      : data.error || "OpenCode is unavailable";
    if (previous !== selected) {
      localStorage.setItem("openvoice.session", selected || "");
      historySession = null;
      messages = [];
      renderMessages();
      await loadMessages();
    } else if (selected) {
      await loadMessages();
    }
    await maybeReadReply();
  } catch {
    view.sessionMeta.value = "Connection unavailable";
  } finally {
    sessionsRequest = false;
  }
}

async function selectSession(id) {
  stopVoice(voiceMode ? "Session changed. Tap to continue." : "Microphone off", { preserveDraft: false });
  sendRequest++;
  sending = false;
  selected = id;
  view.selectedId.value = selected;
  showStatus("Microphone off");
  historySession = null;
  messages = [];
  renderMessages();
  localStorage.setItem("openvoice.session", id);
  closeSessionSelection();
  renderSessions();
  const session = sessions.find((item) => item.id === selected);
  view.sessionTitle.value = session?.title || "Session";
  view.sessionMeta.value = session?.directory || "";
  waitingForReply = false;
  clearTimeout(replyTimer);
  await loadMessages();
}

function splitForSpeech(text, maxLength = 900) {
  const chunks = [];
  let remaining = text.replace(/```[\s\S]*?```/g, "Code omitted from spoken reply.").trim();
  while (remaining.length > maxLength) {
    let end = remaining.lastIndexOf(". ", maxLength);
    if (end < maxLength * 0.55) {
      end = remaining.lastIndexOf(" ", maxLength);
    }
    if (end < 1) {
      end = maxLength;
    }
    chunks.push(remaining.slice(0, end + 1).trim());
    remaining = remaining.slice(end + 1).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

async function speak(text) {
  const generation = voiceGeneration;
  const chunks = splitForSpeech(text);
  if (chunks.length === 0) {
    return;
  }
  speaking = true;
  stopCapture();
  showStatus("Speaking…");
  try {
    for (const chunk of chunks) {
      if (!voiceMode || generation !== voiceGeneration) {
        break;
      }
      const { response } = await request("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk }),
      });
      if (!voiceMode || generation !== voiceGeneration) {
        return;
      }
      const source = URL.createObjectURL(await response.blob());
      if (!voiceMode || generation !== voiceGeneration) {
        URL.revokeObjectURL(source);
        return;
      }
      player.src = source;
      try {
        await new Promise((resolve, reject) => {
          let finished = false;
          const finish = (callback) => {
            if (finished) {
              return;
            }
            finished = true;
            player.onended = null;
            player.onerror = null;
            activePlaybackCancel = null;
            callback();
          };
          player.onended = () => finish(resolve);
          player.onerror = () => finish(() => reject(new Error("Audio playback failed")));
          activePlaybackCancel = () => finish(resolve);
          player.play().catch((error) => finish(() => reject(error)));
        });
      } finally {
        URL.revokeObjectURL(source);
      }
      if (!voiceMode || generation !== voiceGeneration) {
        return;
      }
    }
  } catch (error) {
    if (generation === voiceGeneration) {
      stopVoice(`Could not play reply: ${error.message}`, { error: true });
    }
  } finally {
    if (generation === voiceGeneration) {
      speaking = false;
      if (voiceMode) {
        showStatus("Your turn — speak when ready");
        startRecognition();
      }
    }
  }
}

async function maybeReadReply() {
  if (!waitingForReply || !selected || speaking) {
    return;
  }
  const session = sessions.find((item) => item.id === selected);
  if (session?.status === "running") {
    showStatus("Working on it…");
    return;
  }
  const failedReply = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.completed === true &&
        message.finish === "error" &&
        !seenMessages.has(messageKey(message)),
    );
  if (failedReply) {
    seenMessages.add(messageKey(failedReply));
    waitingForReply = false;
    clearTimeout(replyTimer);
    if (voiceMode) {
      stopVoice("The assistant could not complete that reply.", { error: true });
    } else {
      showStatus("The assistant could not complete that reply.");
    }
    return;
  }
  const latest = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        message.completed === true &&
        message.finish !== "tool-calls" &&
        message.finish !== "error" &&
        !seenMessages.has(messageKey(message)),
    );
  if (latest) {
    seenMessages.add(messageKey(latest));
    waitingForReply = false;
    clearTimeout(replyTimer);
    void speak(latest.text);
    return;
  }
  if (Date.now() - replyStartedAt > 5 * 60_000) {
    stopVoice("No reply yet. Check the conversation before sending again.", { error: true });
    return;
  }
  showStatus("Waiting for the session…");
}

async function sendMessage(text) {
  const message = text.trim();
  if (!selected || historySession !== selected || !message || sending || waitingForReply || speaking) {
    return;
  }
  const generation = voiceGeneration;
  const sessionID = selected;
  const requestID = ++sendRequest;
  if (view.draftVisible.value && draftSession !== sessionID) {
    return;
  }
  sending = true;
  clearTimeout(sendTimer);
  sendTimer = undefined;
  stopCapture();
  waitingForReply = true;
  replyStartedAt = Date.now();
  seenMessages = new Set(messages.map(messageKey));
  showStatus("Sending…");
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (requestID !== sendRequest || selected !== sessionID) {
      return;
    }
    sending = false;
    clearDraft();
    view.prompt.value = "";
    await loadMessages();
    if (generation !== voiceGeneration || selected !== sessionID) {
      return;
    }
    if (!waitingForReply) {
      if (!voiceMode) {
        showStatus("Reply received");
      }
      return;
    }
    showStatus("Waiting for the reply…");
    clearTimeout(replyTimer);
    replyTimer = setTimeout(() => {
      if (waitingForReply) {
        stopVoice("No reply yet. Check the conversation before sending again.", { error: true });
      }
    }, 5 * 60_000);
  } catch (error) {
    if (generation === voiceGeneration && selected === sessionID) {
      sending = false;
      waitingForReply = false;
      view.draftText.value = message;
      utterance = message;
      interimTranscript = "";
      draftSession = sessionID;
      view.draftVisible.value = true;
      stopVoice(`Message not sent: ${error.message}. Draft preserved.`, { error: true });
    } else if (requestID === sendRequest && selected === sessionID) {
      showStatus(`Message not sent: ${error.message}. Check your draft.`, "error");
    }
  } finally {
    if (requestID === sendRequest && selected === sessionID) {
      sending = false;
      showStatus(view.statusText.value, view.voiceState.value === "error" ? "error" : undefined);
    }
    if (generation === voiceGeneration && voiceMode && !waitingForReply) {
      startRecognition();
    }
  }
}

function startRecognition() {
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (
    !voiceMode ||
    listening ||
    recognitionStarting ||
    view.draftVisible.value ||
    sending ||
    speaking ||
    waitingForReply ||
    !SpeechApi
  ) {
    return;
  }
  recognition = new SpeechApi();
  const currentRecognition = recognition;
  const generation = voiceGeneration;
  const recognitionSession = selected;
  const base = utterance.trim();
  let previousEventTranscript = "";
  const isCurrent = () =>
    voiceMode &&
    generation === voiceGeneration &&
    selected === recognitionSession &&
    recognition === currentRecognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (!isCurrent() || view.draftVisible.value || sending || waitingForReply || speaking) {
      return;
    }
    const fullTranscript = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) {
        continue;
      }
      fullTranscript.push(text);
    }
    // Results are a complete snapshot. Compare it with the current transcript
    // and append only its new suffix. Some recognition restarts report text
    // relative to that recognizer rather than the existing editable draft, so
    // also diff against this recognizer's previous snapshot in that case.
    const eventTranscript = fullTranscript.join(" ").trim();
    const existingText = [utterance, interimTranscript].filter(Boolean).join(" ").trim();
    let newlyRecognized = transcriptAfterExistingText(eventTranscript, existingText);
    if (newlyRecognized === null) {
      newlyRecognized = transcriptAfterExistingText(eventTranscript, previousEventTranscript);
    }
    if (newlyRecognized !== null) {
      utterance = [existingText, newlyRecognized].filter(Boolean).join(" ").trim();
    } else {
      // A changed prefix is a corrected snapshot, not another phrase to append.
      const eventAfterBase = transcriptAfterExistingText(eventTranscript, base);
      utterance = [base, eventAfterBase === null ? eventTranscript : eventAfterBase].filter(Boolean).join(" ").trim();
    }
    interimTranscript = "";
    previousEventTranscript = eventTranscript;
    updateTranscript();
    if ((utterance || interimTranscript) && !reviewPending) {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(requestReview, 2800);
      showStatus(listening ? "Listening — pause to review your draft" : "Starting microphone…");
    }
  };
  recognition.onerror = (event) => {
    if (!isCurrent()) {
      return;
    }
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      stopVoice("Microphone permission is needed for hands-free voice.", { error: true });
      return;
    }
    if (event.error !== "no-speech" && event.error !== "aborted") {
      stopVoice(`Voice recognition failed: ${event.error}. Tap to retry.`, { error: true });
    }
  };
  recognition.onend = () => {
    if (!isCurrent()) {
      return;
    }
    listening = false;
    recognitionStarting = false;
    recognition = null;
    clearTimeout(microphoneTimer);
    if (utterance || interimTranscript) {
      showDraft();
    } else if (voiceMode && !sending && !speaking && !waitingForReply && !view.draftVisible.value) {
      clearTimeout(sendTimer);
      sendTimer = undefined;
      clearTimeout(restartTimer);
      showStatus("Microphone stopped — reconnecting…", "starting");
      restartTimer = setTimeout(startRecognition, 300);
    } else {
      showStatus("Microphone off");
    }
  };
  currentRecognition.onstart = () => {
    if (!isCurrent() || reviewPending || view.draftVisible.value) {
      return;
    }
    clearTimeout(microphoneTimer);
    recognitionStarting = false;
    listening = true;
    showStatus("Listening — speak naturally");
  };
  try {
    recognitionStarting = true;
    showStatus("Starting microphone…");
    microphoneTimer = setTimeout(() => {
      if (isCurrent() && recognitionStarting) {
        stopVoice("Microphone did not start. Check Chrome’s microphone permission and input device.", { error: true });
      }
    }, 10000);
    recognition.start();
  } catch {
    stopVoice("Could not start the microphone. Tap to retry.", { error: true });
  }
}

function stopVoice(message = "Microphone off — voice paused", { preserveDraft = true, error = false } = {}) {
  voiceGeneration++;
  activePlaybackCancel?.();
  activePlaybackCancel = null;
  voiceMode = false;
  listening = false;
  speaking = false;
  waitingForReply = false;
  clearTimeout(sendTimer);
  clearTimeout(restartTimer);
  clearTimeout(replyTimer);
  clearTimeout(reviewTimer);
  sendTimer = undefined;
  restartTimer = undefined;
  replyTimer = undefined;
  stopCapture();
  player.pause();
  player.removeAttribute("src");
  recognitionStarting = false;
  if (!preserveDraft) {
    clearDraft();
  } else if (!view.draftVisible.value && (utterance || interimTranscript)) {
    showDraft();
  }
  showStatus(message, error ? "error" : undefined);
}

function toggleVoice() {
  if (voiceMode) {
    stopVoice();
    return;
  }
  if (sending || waitingForReply || speaking) {
    showStatus("Finishing the current request — microphone off");
    return;
  }
  if (!selected) {
    showStatus("Choose a session first.");
    sessionPicker.open = true;
    return;
  }
  if (historySession !== selected) {
    showStatus("Wait for this session’s messages to load.");
    return;
  }
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    showStatus("Speech recognition is not supported in this browser.");
    return;
  }
  voiceMode = true;
  seenMessages = new Set(messages.map(messageKey));
  if (view.draftVisible.value) {
    resumeDictation();
  } else {
    startRecognition();
  }
}

function sendDraft() {
  if (draftSession === selected) {
    sendMessage(view.draftText.value);
  }
}

function updateDraft(value) {
  view.draftText.value = value;
  showStatus(view.statusText.value, view.voiceState.value);
}

function updatePrompt(value) {
  view.prompt.value = value;
}

function sendTypedPrompt() {
  sendMessage(view.prompt.value);
}

function discardDraft() {
  if (sending) {
    return;
  }
  clearDraft();
  if (voiceMode) {
    startRecognition();
  } else {
    showStatus("Draft discarded — microphone off");
  }
}

async function startNewSession() {
  try {
    const { data } = await request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "create" }),
    });
    await refreshSessions();
    const created = sessions.find((session) => session.id === data.id);
    if (created) {
      selectSession(created.id);
    }
  } catch (error) {
    showStatus(error.message, "error");
  }
}

async function loadGoals() {
  try {
    const { data } = await request("/api/goals");
    goals = data;
    view.goals.value = goals;
    view.goalCount.value = goals.length ? `(${goals.length})` : "(none yet)";
  } catch (error) {
    view.goalNotice.value = error.message;
  }
}

async function updateGoal(id, patch) {
  try {
    await request(`/api/goals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadGoals();
  } catch (error) {
    view.goalNotice.value = error.message;
  }
}

async function deleteGoal(id) {
  try {
    await request(`/api/goals/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadGoals();
  } catch (error) {
    view.goalNotice.value = error.message;
  }
}

function setGoalTitle(value) {
  view.goalTitle.value = value;
}

function setGoalDescription(value) {
  view.goalDescription.value = value;
}

async function addGoal() {
  try {
    await request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: view.goalTitle.value,
        description: view.goalDescription.value,
      }),
    });
    view.goalTitle.value = "";
    view.goalDescription.value = "";
    await loadGoals();
  } catch (error) {
    view.goalNotice.value = error.message;
  }
}

async function applyPlan() {
  const sessionIds = sessions.map((session) => session.id);
  if (!sessionIds.length || !confirm(`Send the current plan to all ${sessionIds.length} top-level sessions?`)) {
    return;
  }
  try {
    const { data } = await request("/api/plan/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds }),
    });
    view.goalNotice.value = `Sent to ${data.sent}; ${data.failed} failed.`;
  } catch (error) {
    view.goalNotice.value = error.message;
  }
}

async function init() {
  await checkAuthAndProperties();
  await Promise.all([refreshSessions(), loadGoals()]);
  setInterval(refreshSessions, 2500);
}

void prepareApp();
