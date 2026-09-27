// Writer providers. 'mock' exists ONLY to test orchestration and is never a
// real writer. 'mistral_vibe_local' is the real mode: drafts are authored in
// a local Vibe/Mistral session and placed in drafts/; the runner validates and
// publishes. No API credential belongs in this repository.
import fs from 'node:fs';
import path from 'node:path';

export function preflight(root, cfg) {
  const report = {
    provider: cfg.provider,
    real_writer: false,
    checked_at: new Date().toISOString(),
    checks: []
  };
  const mode = cfg.provider;
  if (mode === 'mock') {
    report.checks.push({ name: 'mock-mode', ok: true, note: 'mock provider present; orchestration-test only, NOT a real writer' });
  } else if (mode === 'mistral_vibe_local') {
    report.checks.push({ name: 'local-session', ok: true, note: 'drafts authored in a local Vibe/Mistral session into drafts/; runner picks them up' });
    report.checks.push({ name: 'api-credentials', ok: false, note: 'no server-side API access configured (a paid chat subscription is not API access); none committed' });
    report.real_writer = true; // real writing happens, human-in-the-loop locally
  } else if (mode === 'mistral_api') {
    const token = process.env.MISTRAL_API_KEY;
    report.checks.push({ name: 'api-credentials', ok: Boolean(token), note: token ? 'MISTRAL_API_KEY present in environment (not committed)' : 'MISTRAL_API_KEY missing — provider unavailable' });
    report.real_writer = Boolean(token);
  } else {
    report.checks.push({ name: 'unknown-provider', ok: false, note: 'unknown provider "' + mode + '"' });
  }
  return report;
}

export function makeDraft(root, job, cfg, provider) {
  if (provider === 'mock') return mockDraft(job);
  if (provider === 'mistral_vibe_local') {
    const draftPath = path.join(root, 'drafts', job.slug + '.md');
    if (fs.existsSync(draftPath)) return fs.readFileSync(draftPath, 'utf8');
    const e = new Error('no local draft found at drafts/' + job.slug + '.md — author it in the local session first');
    e.code = 'E_NO_DRAFT';
    throw e;
  }
  if (provider === 'mistral_api') {
    const e = new Error('mistral_api adapter requires MISTRAL_API_KEY and explicit approval; generation is disabled');
    e.code = 'E_PROVIDER_UNAVAILABLE';
    throw e;
  }
  throw new Error('unknown provider "' + provider + '"');
}

function mockDraft(job) {
  return [
    '---',
    'title: "' + job.topic.title + '"',
    'description: "Ban nhap kiem thu orchestration — khong phai noi dung that, khong bao gio duoc xuat ban."',
    'date: 2026-01-01 00:00:00 +0700',
    'id: mock-' + job.id,
    'cluster: MOCK',
    'search_intent: informational',
    'legal_sensitivity: false',
    'mock: true',
    'published: false',
    'sitemap: false',
    '---',
    '',
    'Noi dung mock danh rieng cho kiem thu pipeline. Bai nay nam trong thu muc drafts va bi moi validator tu choi neu bi day len _posts.'
  ].join('\n');
}
