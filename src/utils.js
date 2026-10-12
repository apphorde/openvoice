export function rootSessions(sessions) {
  const entries = Array.isArray(sessions)
    ? sessions
    : Array.isArray(sessions?.data)
      ? sessions.data
      : [];
  return entries
    .filter((session) => !session.parentID)
    .sort(
      (a, b) =>
        (b.time?.updated || b.time?.created || 0) -
        (a.time?.updated || a.time?.created || 0),
    );
}
export function latestExcerpt(message) {
  if (!message) {
    return "";
  }
  const text = (message.content || message.parts || [])
    .filter(
      (part) =>
        (part.type === "text" || part.type === "text-delta") &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .concat(typeof message.text === "string" ? [message.text] : [])
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}
