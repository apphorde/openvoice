const list = document.querySelector("#list");
const updated = document.querySelector("#updated");
let sessions = [];
let goals = [];
let selected = null;
let recognition;
let listening = false;
let lastSpoken = "";

const date = (value) =>
  value
    ? new Date(
        typeof value === "number" && value < 1e12 ? value * 1000 : value,
      ).toLocaleString()
    : "Activity time unavailable";

async function request(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status})`);
  }
  return { response, data };
}

function show(session) {
  document.querySelector("#empty").hidden = true;
  document.querySelector("#selected").hidden = false;
  document.querySelector("#title").textContent = session.title;
  document.querySelector("#status").textContent = String(
    session.status,
  ).toUpperCase();
  document.querySelector("#meta").textContent =
    `${session.directory || "Project path unavailable"} · Updated ${date(session.time)}`;
  document.querySelector("#latest").textContent =
    session.latest || "No messages yet.";
  if (
    document.querySelector("#readAloud").checked &&
    session.latestRole === "assistant" &&
    session.latest
  ) {
    speak(session.latest);
  }
}

function drawSessions() {
  list.replaceChildren();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = `session-card${session.id === selected ? " active" : ""}`;
    const title = document.createElement("strong");
    const excerpt = document.createElement("small");
    const bottom = document.createElement("div");
    const status = document.createElement("span");
    const time = document.createElement("span");
    bottom.className = "card-bottom";
    title.textContent = session.title;
    excerpt.textContent = session.latest || "No text message yet";
    status.textContent = String(session.status).toUpperCase();
    time.textContent = date(session.time);
    bottom.append(status, time);
    button.append(title, excerpt, bottom);
    button.addEventListener("click", () => {
      selected = session.id;
      drawSessions();
      show(session);
    });
    list.append(button);
  }
  if (selected) {
    const session = sessions.find((item) => item.id === selected);
    if (session) {
      show(session);
    } else {
      selected = null;
      document.querySelector("#selected").hidden = true;
      document.querySelector("#empty").hidden = false;
    }
  }
}

function drawGoals() {
  const target = document.querySelector("#goals");
  target.replaceChildren();
  for (const goal of goals) {
    const card = document.createElement("article");
    const title = document.createElement("strong");
    const description = document.createElement("p");
    const actions = document.createElement("div");
    const status = document.createElement("select");
    const remove = document.createElement("button");
    card.className = "goal-card";
    title.textContent = goal.title;
    description.textContent = goal.description || `Status: ${goal.status}`;
    for (const value of ["open", "in-progress", "done"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      option.selected = goal.status === value;
      status.append(option);
    }
    status.setAttribute("aria-label", `Status for ${goal.title}`);
    status.addEventListener("change", () =>
      updateGoal(goal.id, { status: status.value }),
    );
    remove.className = "quiet";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => deleteGoal(goal.id));
    actions.className = "controls";
    actions.append(status, remove);
    card.append(title, description, actions);
    target.append(card);
  }
}

async function refresh() {
  try {
    const { data } = await request("/api/sessions");
    sessions = data.sessions || [];
    updated.textContent = `Polled ${new Date(data.updatedAt).toLocaleTimeString()}`;
    drawSessions();
  } catch {
    updated.textContent = "Connection unavailable";
  }
}

async function loadGoals() {
  try {
    const { data } = await request("/api/goals");
    goals = data;
    drawGoals();
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
  if (!confirm("Delete this shared goal?")) {
    return;
  }
  try {
    await request(`/api/goals/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadGoals();
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
}

async function speak(text) {
  if (lastSpoken === text) {
    return;
  }
  lastSpoken = text;
  const player = document.querySelector("#player");
  try {
    const { response } = await request("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    player.src = URL.createObjectURL(await response.blob());
    player.hidden = false;
    await player.play();
  } catch (error) {
    document.querySelector("#goalNotice").textContent = `TTS: ${error.message}`;
  }
}

document.querySelector("#refresh").addEventListener("click", refresh);
document
  .querySelector("#composer")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = document.querySelector("#prompt").value.trim();
    if (!selected || !text) {
      return;
    }
    const send = document.querySelector("#send");
    send.disabled = true;
    try {
      await request(`/api/sessions/${encodeURIComponent(selected)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      document.querySelector("#prompt").value = "";
      await refresh();
    } catch (error) {
      alert(error.message);
    } finally {
      send.disabled = false;
    }
  });

document
  .querySelector("#goalForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = document.querySelector("#goalTitle");
    const description = document.querySelector("#goalDescription");
    try {
      await request("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.value,
          description: description.value,
        }),
      });
      title.value = "";
      description.value = "";
      await loadGoals();
    } catch (error) {
      document.querySelector("#goalNotice").textContent = error.message;
    }
  });

document.querySelector("#sendPlan").addEventListener("click", async () => {
  if (!selected) {
    return;
  }
  const goal = goals.find((item) => item.status !== "done");
  if (!goal) {
    document.querySelector("#goalNotice").textContent =
      "Add an open goal first.";
    return;
  }
  try {
    await request(`/api/goals/${encodeURIComponent(goal.id)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: selected }),
    });
    document.querySelector("#goalNotice").textContent =
      `Sent “${goal.title}” to the selected session.`;
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
});

document.querySelector("#applyPlan").addEventListener("click", async () => {
  const targets = sessions.map((session) => session.id);
  if (targets.length === 0 || targets.length > 250) {
    document.querySelector("#goalNotice").textContent =
      "The plan can be sent to 1–250 loaded root sessions.";
    return;
  }
  if (
    !confirm(
      `Send the shared plan as a prompt to all ${targets.length} root sessions? This may start work in each session.`,
    )
  ) {
    return;
  }
  try {
    const { data } = await request("/api/plan/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: targets }),
    });
    document.querySelector("#goalNotice").textContent =
      `Plan sent to ${data.sent} sessions; ${data.failed} failed.`;
  } catch (error) {
    document.querySelector("#goalNotice").textContent = error.message;
  }
});

document.querySelector("#readAloud").addEventListener("change", (event) => {
  const player = document.querySelector("#player");
  if (!event.target.checked) {
    player.pause();
    player.removeAttribute("src");
    lastSpoken = "";
  }
});

document.querySelector("#voice").addEventListener("click", () => {
  const SpeechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = document.querySelector("#voice");
  const state = document.querySelector("#voiceState");
  if (listening) {
    recognition?.stop();
    listening = false;
    button.textContent = "🎙 Start voice";
    state.textContent = "";
    return;
  }
  if (!SpeechApi) {
    state.textContent = "Speech recognition is not supported by this browser.";
    return;
  }
  recognition = new SpeechApi();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join(" ");
    document.querySelector("#prompt").value = transcript;
  };
  recognition.onerror = (event) => {
    state.textContent = `Recognition error: ${event.error}`;
  };
  recognition.onend = () => {
    listening = false;
    button.textContent = "🎙 Start voice";
    if (state.textContent === "Listening…") {
      state.textContent = "";
    }
  };
  try {
    recognition.start();
    listening = true;
    button.textContent = "■ Stop voice";
    state.textContent = "Listening…";
  } catch {
    state.textContent = "Could not start microphone.";
  }
});

async function init() {
  try {
    const { data } = await request("/api/auth/status");
    document.querySelector("#user").textContent = data.user || "Local access";
  } catch {
    document.querySelector("#user").textContent = "";
  }
  await Promise.all([refresh(), loadGoals()]);
  setInterval(refresh, 5000);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
init();
