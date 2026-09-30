// porcelain.mjs — parse `git status --porcelain` output into changed paths.
// Porcelain v1 line format: "XY <path>" where XY is two status characters
// followed by one space. The line may START WITH A SPACE (e.g. " M file"
// means modified-not-staged) — that space is part of the format, so the
// line must never be trimmed before slicing. Trimming first silently eats
// the first character of the path ("data/x" -> "ata/x"), which previously
// made every derived file fail the publish-loop scope check.
// Rename/copy lines ("R  orig -> path") are returned as-is on purpose:
// the caller then fails closed (they never match a narrow allowlist).
export function changedPaths(porcelain) {
  return porcelain
    .split('\n')
    .filter(l => l.trim())
    .map(l => l.slice(3).trim())
    .filter(Boolean);
}
