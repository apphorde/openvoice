export function rootSessions(sessions) {
  const entries = Array.isArray(sessions) ? sessions : Array.isArray(sessions?.data) ? sessions.data : [];
  return entries
    .filter((session) => !session.parentID)
    .sort((a, b) => (b.time?.updated || b.time?.created || 0) - (a.time?.updated || a.time?.created || 0));
}
export function messageText(message) {
  if (!message) {
    return "";
  }
  const text = (message.content || message.parts || [])
    .filter((part) => (part.type === "text" || part.type === "text-delta") && typeof part.text === "string")
    .map((part) => part.text)
    .concat(typeof message.text === "string" ? [message.text] : [])
    .join("\n")
    .trim();
  return text;
}

export function latestExcerpt(message) {
  const text = messageText(message).replace(/\s+/g, " ");
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

export function messageRole(message) {
  return message?.type || message?.role || message?.info?.role || "";
}
