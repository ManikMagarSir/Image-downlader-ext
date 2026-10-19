# Image Hunter

A free, local-only Chrome extension (Manifest V3) that scans webpages for
downloadable images, shows them in a searchable gallery, identifies
higher-resolution candidates, and downloads selections individually, in bulk,
or as a ZIP archive.

No backend. No account. No API key. No telemetry. Nothing leaves your machine
except ordinary requests to the website you are already viewing.

The popup uses a compact "darkroom" interface (warm amber accents on a cool
charcoal base, with a matching light theme) built for progressive disclosure:
the gallery stays front-and-centre while filters, settings, and per-image
details live one click away.

## Install (unpacked, developer mode)

1. Download or clone this folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Pin the Image Hunter icon to the toolbar.

Works in Chrome and Chromium-based browsers that support Manifest V3
(Chrome 112+ recommended, mainly for `chrome.storage.session` used by scan
reporting).

## Usage

1. Open a normal webpage and click the extension icon.
2. **Scan** — finds images in the current DOM without scrolling or
   navigating.
3. **Deep Scan** — scrolls the page gradually so lazy-loaded and
   infinite-scroll images mount, rescans as it goes, then restores your
   original scroll position. Cancel any time.
4. Click cards (or their checkbox) to select. Search is always visible; the
   **Filters** button reveals type/size/variant filters only when you want
   them, with a badge showing how many are active.
5. **Download selected** sends files through Chrome's download system into
   the `ImageHunter/` subfolder (configurable). **ZIP export** packages the
   selection into one archive. A **Cancel** button appears beside the status
   while a batch is running.
6. The ↓ button on a card downloads that image; the **i** button opens
   details (with size probes for resolution candidates). Clicking the card
   body selects it.

## Interface

The popup is organized so the common path — scan, select, download — needs no
digging:

- **Header** — **Scan** (primary), **Deep Scan**, and a Settings gear. The
  wordmark collapses to just the icon on narrow popups so the actions never
  wrap or overlap.
- **Search + Filters** — search is always visible. The **Filters** button
  toggles a panel (type, min width/height, hide-tiny, collapse URL variants,
  reset) and carries a badge showing how many filters are active.
- **Cards** — a click on the thumbnail selects an image; a checkbox sits in
  the corner; two round buttons appear on the card for quick **download**
  and **details**. Selected cards show the amber viewfinder brackets.
- **Footer** — **Download selected**, **ZIP export**, and an inline status
  readout (with a green/red status dot) plus a **Cancel** button while a batch
  is running.
- **Empty states** are contextual: no scan yet, no results, or a "try Deep
  Scan" hint depending on the situation.
- Respects `prefers-color-scheme` (light/dark) and `prefers-reduced-motion`.

## What gets scanned

- `<img>` elements, `srcset`, `<picture>`/`<source>`
- lazy-load attributes: `data-src`, `data-original`, `data-lazy-src`,
  `data-srcset`, `data-lazy-srcset`, `data-full-url`, `data-image`
- CSS backgrounds: inline styles, same-origin stylesheets, and a chunked
  `getComputedStyle` pass during scans
- `og:image` / `twitter:image` metadata, `<video poster>`,
  `input[type=image]`, and links that point directly at image files
- images inside **open** shadow DOM trees
- `MutationObserver` + stepped scrolling during Deep Scan for dynamically
  inserted content

Deduplication is by normalized URL. Only fragments are stripped — query
strings are never removed or reordered, because they can carry authentication
or transformation semantics. Same URL found through several sources merges
into one card with a combined source list.

## Resolution candidates

Where a larger version can be *inferred* (bigger `srcset` entry, `<picture>`
source, lazy attribute, "open original" anchor), it is attached to the card
as a **candidate** and labelled *inferred — not verified as original*. The
details view probes candidate dimensions before you decide. Downloads never
silently substitute a candidate for the source.

Site-specific URL rewriting is intentionally **not** built in: it breaks
constantly and can strip auth parameters. The candidate architecture is the
supported path.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Scan only the tab you invoked the extension on |
| `scripting` | Inject the scanner on demand |
| `downloads` | Save files and ZIP archives |
| `storage` | Your settings, download history, and transient scan results |

No `host_permissions` are declared: access to a site is granted per-click via
`activeTab`. Optional permission for all sites is not requested — enable it
via Chrome's site settings only if you want scans to survive without clicking
the icon.

## Privacy

- Zero network endpoints belonging to the extension; no analytics, crash
  reporting, or update servers are contacted by the code in this repository.
- Scan metadata lives in `chrome.storage.session` (cleared when the browser
  restarts). Settings and history are in `chrome.storage.local`.
- Downloaded image bytes are never stored in extension storage.
- `vendor/jszip.min.js` is bundled locally (JSZip 3.10.1, MIT). Nothing is
  fetched from a CDN at runtime.

## Development

```
manifest.json      MV3 configuration (no host permissions)
popup.html/css/js  gallery UI, filters, selection, progress
scanner.js         content script: discovery + deep scan
image-utils.js     URLs, srcset, dedup, filenames, filters (shared)
background.js      service worker: message routing, session storage setup
downloads.js       download queue: naming, retries, cancellation, progress
zip-export.js      JSZip archive building with size limits
settings.js        preferences + local download history
icons/             generated PNG icons (tools/gen-icons.mjs)
vendor/            locally bundled JSZip
tests/             unit tests (incl. Node DOM harness for popup.js) + fixtures
                   + browser-test.md + browser/ (automated)
tools/             dev-time generators (not loaded by the extension)
```

Run checks:

```
node --test tests/image-utils.test.mjs tests/scanner-smoke.test.mjs tests/popup-smoke.test.mjs   # unit + smoke + popup UI
node tools/gen-icons.mjs                 # regenerate icons
node tools/gen-fixtures.mjs              # regenerate fixture images
```

Follow `tests/browser-test.md` for the manual browser suite. An automated
version (34 checks against real headless Chrome via Puppeteer, last run
34/34) is in `tests/browser/run-browser-test.mjs`; its header comment
documents the one-time sandbox-free setup.

## Known limitations (honest list)

- **Restricted pages**: `chrome://`, Web Store, `file://` (unless you enable
  "Allow access to file URLs"), and other extension pages cannot be scanned.
  The popup reports this instead of pretending success.
- **Deep scan requires the tab to stay open and focused**: lazy loaders that
  react to scroll events receive no frames in occluded/background tabs (most
  extreme in headless Chrome, verified during automated testing). The popup
  closing mid-scan is fine — results persist in session storage and appear
  when you reopen it.
- **Cross-origin stylesheets** cannot be read (browser rule), so background
  images declared only in third-party CSS may be missed by the stylesheet
  pass; the `getComputedStyle` pass usually catches their elements instead.
- **Closed shadow DOM** is not traversable by design. Inline background
  styles inside shadow roots are currently missed (shadow `<img>`s are found).
- **ZIP export fetching** is subject to CORS from the extension page context.
  Same-origin page images usually fetch fine while `activeTab` is granted,
  but hotlink-protected hosts may fail per file; those files are listed as
  skipped, and individual download (which uses Chrome's network stack and is
  not CORS-restricted) still works.
- **Very large archives** (> ~400 MB) abort with a warning because in-browser
  ZIP generation gets unreliable; use bulk download instead.
- **Candidate detection is inference, not proof.** A bigger `srcset` entry is
  likely the original, but only the dimension probe in the details view gives
  evidence, and even that shows dimensions, not identity.
- **Authenticated/hotlink-protected resources** are fetched with your normal
  browser access only. The extension never attempts to bypass DRM,
  authentication, or access controls.
- Expired signed URLs fail with an honest per-file error; the extension does
  not attempt URL regeneration beyond declared page data.
- Very long filenames are truncated to 80 characters (stem) to satisfy
  filesystem limits.

## Troubleshooting

- **"Cannot access page"** — expected on browser-internal pages; use a
  normal website.
- **Empty gallery on a page with images** — many sites mount images after
  scripts settle: run Scan again, then Deep Scan.
- **Downloads land in unexpected folders** — Chrome's own download settings
  (e.g. "Ask where to save each file") override the extension's subfolder
  hint; the `filename` is treated as relative to your chosen directory.
- **Stale gallery after navigating** — click Scan; scan results are keyed to
  the tab and refreshed on demand.

## License

MIT for application code. Bundled JSZip remains under its own MIT license
(`vendor/jszip.min.js`).
