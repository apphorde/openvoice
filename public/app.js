const list = document.querySelector("#list");
const conversation = document.querySelector("#conversation");
const voiceButton = document.querySelector("#voice");
const voiceLabel = document.querySelector("#voiceLabel");
const voiceStatus = document.querySelector("#voiceStatus");
const transcriptPreview = document.querySelector("#transcriptPreview");
const player = document.querySelector("#player");
const draftPanel = document.querySelector("#draftPanel");
const voiceDraft = document.querySelector("#voiceDraft");

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
  voiceStatus.textContent = text;
  state ||= speaking
    ? "speaking"
    : sending || waitingForReply
      ? "waiting"
      : listening
        ? "listening"
        : recognitionStarting
          ? "starting"
          : !draftPanel.hidden
            ? "review"
            : "off";
  voiceStatus.dataset.state = state;
  voiceButton.dataset.state = state;
  voiceButton.classList.toggle("active", state === "listening");
  voiceButton.classList.toggle("speaking", state === "speaking");
  voiceButton.classList.toggle("listening", state === "listening");
  voiceButton.classList.toggle("voice-on", voiceMode);
  voiceButton.setAttribute("aria-pressed", String(voiceMode));
  voiceLabel.textContent = voiceMode ? "Stop voice" : "Start hands-free";
  document.querySelector("#sendDraft").disabled = sending || waitingForReply || speaking || !voiceDraft.value.trim();
  document.querySelector("#resumeVoice").disabled = sending || waitingForReply || speaking;
  document.querySelector("#discardDraft").disabled = sending;
  document.querySelector("#send").disabled = sending || waitingForReply || speaking;
}

function updateTranscript() {
  transcriptPreview.textContent = [utterance, interimTranscript].filter(Boolean).join(" ");
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
  if (draftPanel.hidden || draftSession !== selected) {
    draftSession = selected;
    voiceDraft.value = utterance.trim();
  }
  draftPanel.hidden = false;
  stopCapture();
  listening = false;
  transcriptPreview.textContent = "";
  showStatus("Review your draft — microphone off");
}

function resumeDictation() {
  if (draftSession !== selected || sending || waitingForReply || speaking) {
    return;
  }
  voiceMode = true;
  utterance = voiceDraft.value.trim();
  interimTranscript = "";
  draftPanel.hidden = true;
  updateTranscript();
  startRecognition();
}

function clearDraft() {
  clearTimeout(sendTimer);
  clearTimeout(reviewTimer);
  sendTimer = undefined;
  reviewPending = false;
  draftSession = null;
  draftPanel.hidden = true;
  voiceDraft.value = "";
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
  if (!voiceMode || !draftPanel.hidden || sending || waitingForReply || speaking) {
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

function renderSessions() {
  const signature = JSON.stringify(
    sessions.map(({ id, title, directory, status }) => ({ id, title, directory, status, selected: id === selected })),
  );
  if (signature === sessionSignature) {
    return;
  }
  sessionSignature = signature;
  list.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    const name = document.createElement("span");
    const state = document.createElement("small");
    button.type = "button";
    button.className = `session-option${session.id === selected ? " selected" : ""}`;
    name.textContent = session.title;
    state.textContent = session.status === "running" ? "Working" : session.directory || "";
    button.append(name, state);
    button.addEventListener("click", () => selectSession(session.id));
    list.append(button);
  }
}

function renderMessages() {
  const signature = JSON.stringify([selected, messages]);
  if (signature === messageSignature) {
    return;
  }
  messageSignature = signature;
  const previousScroll = conversation.scrollTop;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  conversation.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = selected ? "No messages in this session yet." : "Choose a session to begin.";
    conversation.append(empty);
    return;
  }
  for (const message of messages) {
    const article = document.createElement("article");
    const role = document.createElement("span");
    const text = document.createElement("p");
    const time = document.createElement("time");
    article.className = `message ${message.role}`;
    role.className = "message-role";
    role.textContent = message.role === "assistant" ? "Assistant" : "You";
    text.textContent = message.text;
    time.textContent = messageDate(message.time);
    article.append(role, text, time);
    conversation.append(article);
  }
  if (nearBottom) {
    conversation.scrollTop = conversation.scrollHeight;
  } else {
    conversation.scrollTop = previousScroll;
  }
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
        stopVoice(previous ? "Session changed. Tap to continue." : "Microphone off — tap to start", {
          preserveDraft: false,
        });
        sendRequest++;
        sending = false;
        selected = next;
        showStatus(voiceStatus.textContent);
      }
    }
    renderSessions();
    const session = sessions.find((item) => item.id === selected);
    document.querySelector("#sessionTitle").textContent = session?.title || "No sessions found";
    document.querySelector("#sessionMeta").textContent = session
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
    document.querySelector("#sessionMeta").textContent = "Connection unavailable";
  } finally {
    sessionsRequest = false;
  }
}

async function selectSession(id) {
  stopVoice(voiceMode ? "Session changed. Tap to continue." : "Microphone off", { preserveDraft: false });
  sendRequest++;
  sending = false;
  selected = id;
  showStatus("Microphone off");
  historySession = null;
  messages = [];
  renderMessages();
  localStorage.setItem("openvoice.session", id);
  document.querySelector("#sessionPicker").open = false;
  renderSessions();
  const session = sessions.find((item) => item.id === selected);
  document.querySelector("#sessionTitle").textContent = session?.title || "Session";
  document.querySelector("#sessionMeta").textContent = session?.directory || "";
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
  if (draftPanel.hidden === false && draftSession !== sessionID) {
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
    document.querySelector("#prompt").value = "";
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
      voiceDraft.value = message;
      utterance = message;
      interimTranscript = "";
      draftSession = sessionID;
      draftPanel.hidden = false;
      stopVoice(`Message not sent: ${error.message}. Draft preserved.`, { error: true });
    } else if (requestID === sendRequest && selected === sessionID) {
      showStatus(`Message not sent: ${error.message}. Check your draft.`, "error");
    }
  } finally {
    if (requestID === sendRequest && selected === sessionID) {
      sending = false;
      showStatus(voiceStatus.textContent, voiceStatus.dataset.state === "error" ? "error" : undefined);
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
    !draftPanel.hidden ||
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
  const base = utterance;
  const isCurrent = () =>
    voiceMode &&
    generation === voiceGeneration &&
    selected === recognitionSession &&
    recognition === currentRecognition;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    if (!isCurrent() || !draftPanel.hidden || sending || waitingForReply || speaking) {
      return;
    }
    const final = [];
    const interim = [];
    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0]?.transcript?.trim();
      if (!text) {
        continue;
      }
      if (result.isFinal) {
        final.push(text);
      } else {
        interim.push(text);
      }
    }
    utterance = [base, ...final].filter(Boolean).join(" ");
    interimTranscript = interim.join(" ");
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
    } else if (voiceMode && !sending && !speaking && !waitingForReply && draftPanel.hidden) {
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
    if (!isCurrent() || reviewPending || !draftPanel.hidden) {
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
  voiceButton.classList.remove("active", "speaking");
  voiceButton.setAttribute("aria-pressed", "false");
  voiceLabel.textContent = "Start hands-free";
  recognitionStarting = false;
  if (!preserveDraft) {
    clearDraft();
  } else if (draftPanel.hidden && (utterance || interimTranscript)) {
    showDraft();
  }
  showStatus(message, error ? "error" : undefined);
}

voiceButton.addEventListener("click", () => {
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
    document.querySelector("#sessionPicker").open = true;
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
  if (!draftPanel.hidden) {
    resumeDictation();
  } else {
    startRecognition();
  }
});

document.querySelector("#sendDraft").addEventListener("click", () => {
  if (draftSession === selected) {
    sendMessage(voiceDraft.value);
  }
});
voiceDraft.addEventListener("input", () => {
  showStatus(voiceStatus.textContent, voiceStatus.dataset.state);
});
document.querySelector("#resumeVoice").addEventListener("click", resumeDictation);
document.querySelector("#discardDraft").addEventListener("click", () => {
  if (sending) {
    return;
  }
  clearDraft();
  if (voiceMode) {
    startRecognition();
  } else {
    showStatus("Draft discarded — microphone off");
  }
});

document.querySelector("#refresh").addEventListener("click", refreshSessions);
document.querySelector("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage(document.querySelector("#prompt").value);
});

async function loadGoals() {
  try {
    const { data } = await request("/api/goals");
    goals = data;
    document.querySelector("#goalCount").textContent = goals.length ? `(${goals.length})` : "(none yet)";
    const target = document.querySelector("#goals");
    target.replaceChildren();
    for (const goal of goals) {
      const row = document.createElement("div");
      const text = document.createElement("span");
      const status = document.createElement("select");
      const remove = document.createElement("button");
      row.className = "goal-row";
      text.textContent = goal.description ? `${goal.title} — ${goal.description}` : goal.title;
      for (const value of ["open", "in-progress", "done"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = goal.status === value;
        status.append(option);
      }
      status.addEventListener("change", () => updateGoal(goal.id, { status: status.value }));
      remove.type = "button";
      remove.className = "icon-button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete ${goal.title}`);
      remove.addEventListener("click", () => deleteGoal(goal.id));
      row.append(text, status, remove);
      target.append(row);
    }
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
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
    document.querySelector("#goalNotice").textContent = error.message;
  }
}

async function deleteGoal(id) {
  try {
    await request(`/api/goals/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadGoals();
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
}

document.querySelector("#goalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await request("/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: document.querySelector("#goalTitle").value,
        description: document.querySelector("#goalDescription").value,
      }),
    });
    document.querySelector("#goalForm").reset();
    await loadGoals();
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
});

document.querySelector("#applyPlan").addEventListener("click", async () => {
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
    document.querySelector("#goalNotice").textContent = `Sent to ${data.sent}; ${data.failed} failed.`;
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
});

async function init() {
  try {
    const { data } = await request("/api/auth/status");
    document.querySelector("#user").textContent = data.user || "";
  } catch {
    document.querySelector("#user").textContent = "";
  }
  await Promise.all([refreshSessions(), loadGoals()]);
  setInterval(refreshSessions, 2500);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
init();
