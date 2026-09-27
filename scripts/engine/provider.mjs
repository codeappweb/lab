// Writer providers — honest capability model.
//
//   mock               : TEST ONLY. Produces synthetic drafts that can never be
//                        published (mock front matter; validation rejects them
//                        outside dry-run). Never report mock as a real writer.
//   mistral_vibe_local : MANUAL DRAFT INGESTION. A human/AI session authors
//                        drafts/<slug>.md locally; the runner validates and
//                        publishes. Real writing happens, but NOT automated by
//                        this repository — so real_writer(automated)=false.
//   mistral_api        : BLOCKED. No working adapter is implemented, and an
//                        environment variable alone proves nothing. A paid chat
//                        subscription is NOT API access. No paid calls are made
//                        from this repository.
//
// No credential ever belongs in this repository.
import fs from 'node:fs';
import path from 'node:path';

export function preflight(root, cfg) {
  const report = {
    provider: cfg.provider,
    // true ONLY if an automated writer adapter actually works end-to-end.
    real_writer: false,
    automated_generation_possible: false,
    status: 'blocked', // 'ok' | 'test-only' | 'manual-draft-ingestion' | 'blocked'
    reason: null,
    checked_at: new Date().toISOString(),
    checks: []
  };
  const mode = cfg.provider;

  if (mode === 'mock') {
    report.status = 'test-only';
    report.reason = 'mock provider is orchestration-test only; it must never be described or used as a real writer, and mock drafts can never be published';
    report.checks.push({ name: 'mock-mode', ok: true, note: report.reason });
  } else if (mode === 'mistral_vibe_local') {
    const draftsDir = path.join(root, 'drafts');
    const hasDir = fs.existsSync(draftsDir);
    report.status = 'manual-draft-ingestion';
    report.reason = 'drafts are authored by a local Mistral/Vibe session into drafts/ (human-in-the-loop); this is manual draft ingestion, not automated writing';
    report.checks.push({ name: 'drafts-dir', ok: hasDir, note: hasDir ? 'drafts/ present' : 'drafts/ missing — create it before the pilot' });
    report.checks.push({ name: 'api-credentials', ok: false, note: 'no server-side API access is configured; a chat subscription does NOT grant API access; none is committed' });
  } else if (mode === 'mistral_api') {
    report.status = 'blocked';
    report.reason = 'no working mistral_api adapter exists in this repository; MISTRAL_API_KEY presence alone proves nothing and no paid generation call is authorized here';
    report.checks.push({ name: 'api-adapter', ok: false, note: report.reason });
    report.checks.push({ name: 'api-creedntials', ok: Boolean(process.env.MISTRAL_API_KEY), note: 'environment variable presence is NOT evidence of a working adapter' });
  } else {
    report.status = 'blocked';
    report.reason = 'unknown provider "' + mode + '"';
    report.checks.push({ name: 'unknown-provider', ok: false, note: report.reason });
  }
  return report;
}

// Evidence collection. For mock: clearly-labelled synthetic evidence so the
// researching stage is executable in tests. For the local mode: the draft
// session supplies drafts/<slug>.meta.json; without it the job fails honestly.
export function collectEvidence(root, job, cfg, mode) {
  if (mode === 'mock') {
    return {
      kind: 'mock-evidence',
      note: 'SYNTHETIC evidence for orchestration tests only — never a real source, never publishable',
      collected_at: new Date().toISOString()
    };
  }
  if (mode === 'mistral_vibe_local') {
    const metaPath = path.join(root, 'drafts', job.slug + '.meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (!meta.sources || !Array.isArray(meta.sources) || !meta.sources.length) {
        const e = new Error('drafts/' + job.slug + '.meta.json has no sources[] — evidence is mandatory before drafting');
        e.code = 'E_NO_EVIDENCE';
        throw e;
      }
      return meta;
    }
    const e = new Error('no evidence file at drafts/' + job.slug + '.meta.json — author it in the local session first (sources[] is mandatory)');
    e.code = 'E_NO_EVIDENCE';
    throw e;
  }
  const e = new Error('provider "' + mode + '" cannot collect evidence (status: blocked)');
  e.code = 'E_PROVIDER_UNAVAILABLE';
  throw e;
}

export function buildOutline(root, job, cfg, mode) {
  if (mode === 'mock') {
    return { sections: ['intro', 'body', 'ket-luan'], kind: 'mock-outline' };
  }
  if (mode === 'mistral_vibe_local') {
    const metaPath = path.join(root, 'drafts', job.slug + '.meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.outline && Array.isArray(meta.outline)) return { sections: meta.outline };
    }
    const e = new Error('no outline in drafts/' + job.slug + '.meta.json (outline[] is mandatory before drafting)');
    e.code = 'E_NO_OUTLINE';
    throw e;
  }
  const e = new Error('provider "' + mode + '" cannot build an outline (status: blocked)');
  e.code = 'E_PROVIDER_UNAVAILABLE';
  throw e;
}

// Draft production. Drafts ALWAYS land in drafts/, never in _posts directly.
export function makeDraft(root, job, cfg, mode) {
  if (mode === 'mock') return mockDraft(job);
  if (mode === 'mistral_vibe_local') {
    const draftPath = path.join(root, 'drafts', job.slug + '.md');
    if (fs.existsSync(draftPath)) return fs.readFileSync(draftPath, 'utf8');
    const e = new Error('no local draft found at drafts/' + job.slug + '.md — author it in the local session first');
    e.code = 'E_NO_DRAFT';
    throw e;
  }
  if (mode === 'mistral_api') {
    const e = new Error('mistral_api adapter does not exist; generation is blocked (no paid calls authorized)');
    e.code = 'E_PROVIDER_UNAVAILABLE';
    throw e;
  }
  throw new Error('unknown provider "' + mode + '"');
}

function mockDraft(job) {
  return [
    '---',
    'title: "' + (job.topic && job.topic.title || job.slug) + '"',
    'description: "Ban nhap kiem thu orchestration — khong phai noi dung that, khong bao gio duoc xuat ban."',
    'date: 2026-01-01 00:00:00 +0700',
    'id: mock-' + job.id,
    'parent_category: sua-chua',
    'child_category: chan-doan-loi',
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
