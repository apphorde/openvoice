export function isSubjectAllowed(subject, allowlist) {
  return allowlist.length === 0 || allowlist.includes(subject);
}
