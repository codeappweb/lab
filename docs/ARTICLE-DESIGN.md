# Article Design — typography, components, and formatting rules

This document defines how article (`post` layout) pages are designed and how new
posts must be formatted. The site publishes **no photographs and no article
illustrations**; the reading experience comes from typography, hierarchy, spacing,
and navigation only. Small inline SVG icons (existing `icon.html` include) are
permitted for functional controls.

## Design tokens (assets/css/article.css)

Article styling is centralized in `assets/css/article.css`, loaded after
`app4.css` in `_includes/head.html`. Global base tokens (colors, spacing,
radius, `--content`, `--font`) stay in `assets/css/main.css`; article-specific
tokens are:

| Token | Value | Meaning |
|---|---|---|
| `--art-measure` | `720px` | reading column max width (desktop grid: text + TOC) |
| `--art-body` | `clamp(1.0625rem, .34vw + .98rem, 1.1875rem)` | body 17px mobile → 19px desktop |
| `--art-leading` | `1.78` | long-form line-height |
| `--art-h2` / `--art-h3` | clamp-based | heading scale, subordinate to H1 |
| `--art-pad` | `20px` | mobile horizontal padding |
| `--art-note-bg` | `var(--surface-2)` | background for opt-in note/tip/warning blocks |

The font stack is the existing system stack in `main.css` (`-apple-system,
Segoe UI, Roboto, Noto Sans…`) — fully Vietnamese-capable, zero external font
requests. Both themes use the existing `[data-theme="dark"]` token overrides;
`article.css` adds no new colors except an amber warning accent.

## CSS scoping contract

Every rule in `article.css` is scoped under the `.article` root (the
`<article class="container article">` element of the post layout). Article
styling must never leak into the homepage, category pages or utility pages;
genuinely shared rules belong in `main.css` / `app*.css` by deliberate change,
not by accident. Known leaks that were fixed and must not return: bare
`.prose` selectors, the mobile `.container` padding override (now
`.article.container`), and bare `.tool-btn` / `.toc` selectors.

## Navigation source of truth (menu/footer consistency rule)

Navigation has exactly one source of truth per concern, rendered everywhere
from data — never re-hardcoded per surface:

- `data/navigation.yml` — static pages (main + utility) for header
  `.main-nav`, the nav drawer "Thông tin" column, the footer "Thông tin"
  column.
- `data/menu-cats.yml` + `data/taxonomy.yml` — parent categories for the
  header mega menu (the group string must cover EXACTLY primary + more),
  the footer "Khám phá" columns, the nav drawer "Khám phá" list.
- `data/taxonomy.yml` — parent/child labels and slugs for mega menu,
  nav drawer detail screens and the topic sheet.

Rule: a shared destination URL must carry the SAME visible label on every
surface. Group headings may differ (they describe different groupings), and
the full form "Tất cả <label>" is a legitimate variant — but no casual
shortening or alternate spelling of a shared label. The gate
`scripts/validate-navigation.mjs` enforces this at source level (always) and
against the rendered build (`--site _site`), and writes
`reports/navigation-inventory.json` (item → label → URL → surfaces).

## Article page structure (_layouts/post.html)

One `H1` per page. Order: breadcrumb → category badge → H1 → lead (`page.description`)
→ meta row (published date, optional *Cập nhật* date, reading time) → toolbar →
collapsible mobile TOC → reading column (`.prose`) + sticky desktop TOC →
related (≤3) → hub link → prev/next → JSON-LD.

Rules:
- The *Cập nhật* date renders only when `page.updated_at` exists and differs
  from the publish date. Never invent or hardcode an updated date.
- No author, reviewer, expertise badge, or verification claim is rendered.
- Related cards are capped at 3 in BOTH paths: precomputed
  (`data/related-posts.json`, `scripts/gen-site-data.mjs` `picked.length >= 3`)
  and the Liquid fallback (`limit: 3`).
- No images, no thumbnails, no hero placeholders, no engagement counters.

## Body elements

- **Headings**: H2/H3/H4 with `overflow-wrap: break-word` and
  `scroll-margin-top: 104px` (clears the sticky header for anchors).
- **Heading permalinks**: `assets/js/article.js` (loaded AFTER `main.js` so the
  TOC is built from pristine heading text) appends a quiet `#` link
  (`.h-link`) to each `h2[id]`/`h3[id]`, idempotently. Clicking updates the
  hash, scrolls to the heading, and copies the section URL — with HONEST
  feedback: the "copied" state appears only when a real copy succeeded
  (clipboard API resolve, or the `execCommand` fallback returning true).
  Anchors work without JS because Kramdown auto-generates heading IDs.
  The runtime contract is asserted by `scripts/tests/article-runtime.test.mjs`
  (a real DOM environment, not a syntax check).
- **Ordered lists**: NATIVE markers (`::marker`). Decorative custom counters
  were removed because CSS counters ignore the `start`/`value` attributes and
  displayed wrong numbers; native markers preserve ordered-list semantics.
- **Tables**: `article.js` wraps each `.prose table` in `div.table-wrap`
  (`role="region"`, `tabindex="0"`, labelled, horizontally scrollable, wrapped
  exactly once) so wide tables never break the 360px layout. Cells wrap by
  default; `.nw` on a cell is the explicit opt-in for genuinely non-wrapping
  values (numbers, short codes) — there is NO blanket `white-space: nowrap`.
- **Notes / tips / warnings**: opt-in only. Use Kramdown block attributes:
  `{:.note}`, `{:.tip}`, `{:.warning}`. They are styled boxes with a left rule;
  nothing converts plain paragraphs automatically.
- **Blockquotes**: genuine quotations only; never fabricated.
- **Sources/references**: plain content — list them as a final section or
  links inside the body; do not invent sources.

## TOC and reading navigation

- Desktop (≥1100px): sticky TOC (`.toc`, 220px) beside the reading column,
  `max-height: calc(100vh - 132px)` with contained overflow so it never runs
  under the footer. Hidden below 1100px.
- Mobile/tablet: `<details id="tocMobile">` collapsible TOC above the body;
  never auto-opened.
- TOC requires ≥3 `h2[id]` headings; otherwise the entire component is removed.
- Active-section highlighting uses a single `IntersectionObserver` (no scroll
  handlers). Reading progress is a passive `scroll` listener that only sets a
  width.
- `prefers-reduced-motion` disables smooth scrolling and transitions.

## Article toolbar

Existing `.article-tools` (save / share / copy-link / TOC / ask-AI) is kept;
`article.css` guarantees ≥44px touch targets on touch widths (38px on ≥768px).
Copy-link falls back to a hidden textarea + `execCommand('copy')` (this
fallback was broken by a transfer artifact and is fixed). Feedback via the
existing toast; save state persists in `localStorage`.

## Responsive rules (verified structure)

| Width | Behavior |
|---|---|
| 360px | 20px page padding, 17px body, single column, mobile TOC + bottom nav, tables scroll in `.table-wrap` |
| 390px | same as 360 |
| 768px | wider measure, toolbar 38px targets, post-nav 2 columns |
| 1024px | no desktop TOC yet (requires ≥1100px), centered measure |
| 1440px | text 720px + sticky 220px TOC |

No global `overflow: hidden` on `html`/`body`; any overflow would be a bug to
fix, not to hide. No fixed heights on text elements.

## Accessibility checklist

- One H1; heading levels never skip (H2→H3→H4).
- Skip link, `:focus-visible` outlines, keyboard-operable TOC/toolbar
  (`<button>`, `<details>` native).
- `.table-wrap` is a labelled, focusable scroll region.
- Tool buttons have accessible names (existing `aria-label`s).
- Contrast: text uses existing theme tokens (both themes AA-checked for body
  text); links are underlined, never color-only.
- Works without JavaScript: content, anchors, prev/next, related, breadcrumb
  are all server-rendered.

## Visual QA status

Honest limitation: this repo has no browser tooling in CI; design QA performed
so far is source-level only (Liquid structure, CSS cascade, JS behavior). No
screenshots exist. Visual QA COMPLETED: NO — do not mark it complete from
source inspection. Recommended: manual pass at 360/390/768/1024/1440 in light
and dark themes, plus 200% zoom and reduced-motion.

## How future Mistral sessions must format new posts

1. Filename: `_posts/YYYY-MM-DD-<slug>.md`; front matter: `title`,
   `description` (real lead paragraph, will render as the lede), `slug`,
   `cluster`, `parent_category`/`child_category` (or rely on taxonomy map),
   optional `updated_at` (only if truly updated), `legal_sensitivity`,
   `legal_source`, `last_verified`, `next_review`, `verification_status`
   (see docs/SCHEMA-ARTICLE.md — never declare a verification you did not
   perform).
2. 1,200–2,000 Vietnamese syllable-tokens for production articles
   (space-separated word counting, `scripts/validate-content-quality.mjs`;
   exceptions only via `data/short-article-allowlist.json`, legacy ≤2026-09-26).
3. No images, no `![...]`, no `hero`, no thumbnail fields.
4. Use H2/H3 for sections (≥3 H2s activates the TOC), Kramdown auto-IDs.
5. Tables, `{:.note}`/`{:.warning}` blocks, quotes and lists only when the
   content genuinely calls for them. Never add filler to expand length.
