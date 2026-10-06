#!/usr/bin/env node
// staging-guard.mjs — phan loai contamination nhanh staging (shared module,
// test rieng trong staging-guard.test.mjs). Goc loi incident 37466641605
// (run 37466077247): guard cu trong collect-staging.mjs chi nhin ba-cham
// origin/main...sha — moi file staging TU COMMIT tu merge-base deu bi coi la
// contamination, ke ca khi blob DA GIONG HET main (commit reconcile sync
// derived state tren staging). False positive chan production mai mai,
// repair khong doan duoc (signature unclassified) -> PAUSE + escalate.
//
// Guard moi (fail-closed VAN GIU): chi la contamination khi content thuc su
// khac main:
//   - blob sha tren staging khac blob sha tren main;
//   - file ngoai _posts/*.md moi tren staging (khong co tren main);
//   - file ton tai tren main bi XOA tren nhanh staging.
// Blob trung khop main = SACH, du file do staging tu commit tu merge-base.

export const POST_FILE = /^_posts\/[a-z0-9-]+\.md$/;

export function nonPostPaths(paths) {
  return (paths || []).map((s) => String(s).trim()).filter(Boolean).filter((p) => !POST_FILE.test(p));
}

// blobOf(path, 'staging' | 'main') -> blob sha (string) hoac null khi file khong ton tai tren ref do.
export function classifyStrayFiles(candidates, blobOf) {
  if (typeof blobOf !== 'function') {
    throw new TypeError('classifyStrayFiles: can blobOf(path, side)');
  }
  return (candidates || []).filter((p) => {
    const stg = blobOf(p, 'staging');
    const mn = blobOf(p, 'main');
    if (stg === null) return mn !== null; // staging xoa file con ton tai tren main
    if (mn === null) return true;          // file ngoai _posts moi tren staging
    return stg !== mn;                     // chi khac content moi la contamination
  });
}
