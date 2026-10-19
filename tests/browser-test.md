# Browser Test Instructions

These steps verify the extension in Chrome against the local fixtures. No
network access is required; all fixture images are generated locally.

## Setup

1. Generate fixture images if missing: `node tools/gen-fixtures.mjs`
2. Run tests: `node --test tests/image-utils.test.mjs tests/scanner-smoke.test.mjs
   tests/popup-smoke.test.mjs` (22 tests, including a Node DOM harness for popup.js).
3. Open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, select the project folder.
4. Confirm: no manifest errors, extension icon appears.

## Test 1 — Scanner accuracy (fixtures/scanner.html)

Serve the fixtures over HTTP (the content script cannot inject into `file://`
pages by default):

```
python3 -m http.server 8000   # run inside tests/fixtures/
```

Open `http://localhost:8000/scanner.html` and click **Scan**. Expected:

| Fixture case | Expected result |
|---|---|
| Standard images | `small-red.png`, `large-blue.png` with intrinsic sizes |
| srcset / picture | `xlarge-blue.png` present as source or as a labelled "larger version?" candidate |
| Lazy attributes | `green.png`, `param.png` found even though `src` is a placeholder |
| CSS backgrounds | `bg-tile.png`, `green.png`, `param.png`, `small-red.png` (inline, rule, and computed passes) |
| Duplicate URLs | `large-blue.png` via absolute/relative path merged into **one** card; `?v=2` stays separate (query may matter) |
| Broken images | Cards render "Preview failed", no crash |
| Tracking pixels | 1×1 images hidden while "Hide tiny" is on (under the **Filters** button) |
| Query-parameter URLs | `param.png?…token=abc` keeps its full query string |
| Identical filenames | Both `img/same-name.png` and `img/sub/same-name.png` listed |
| Image links | `xlarge-blue.png` found via anchor; thumbnail card shows candidate badge |
| Open shadow DOM | `large-blue.png?v=shadow` found (inline background inside shadow roots is a known limitation) |
| Dynamic insert | `green.png?v=late` found on a re-scan after load |

## Test 2 — Deep Scan

On the same page click **Deep Scan**, do not touch the mouse. Expected:
page scrolls in steps, progress bar updates, scroll-triggered
`large-blue.png?scroll=1..5` images appear during the run, original scroll
position is restored at the end. Click **Cancel** mid-run to verify
cancellation. Note: the tab must stay focused — headless Chrome gives
background tabs no paint frames, so scroll events never dispatch there
(verified automation calls `bringToFront` on the page tab first).

## Test 3 — Selection, search, filters

- Search `green` → only matching cards remain.
- Sort `largest` → 1600×1200 first.
- Click **Filters** to reveal the secondary filters; the badge shows how many
  are active. Min W `500` → images known to be narrower disappear. **Reset
  filters** clears them.
- Clicking a card selects it (footer button reads "Download N images"); the
  **i** button opens details without changing the selection.
- Select all visible / clear selection work; footer counts update.
- "Select all visible" selects only rendered cards (page size 60).

## Test 4 — Downloads

- Click ↓ on one card → file lands in `Downloads/ImageHunter/…` (per
  settings), correct name, correct bytes (compare with `sha256sum` against
  `tests/fixtures/img/`).
- Select several images including the two `same-name.png` variants → both
  download; conflicts resolved with ` (1)` suffixes by Chrome.
- With "Use download subfolder" off → files go to the plain download directory.
- Cancel mid-batch → remaining files stop, status reports honest counts.

## Test 5 — ZIP export

Select fixture images → **ZIP export** → archive opens in any unzip tool,
names are sanitized, duplicates renamed. Unreachable images are listed as
skipped, not silently dropped.

## Test 6 — Stress and restricted pages

- Open `many-images.html` (3000 elements / 500 unique URLs): scan completes,
  gallery renders in pages of 60 with **Show more**.
- On `chrome://extensions`, `https://chrome.google.com/webstore`, and a
  `file://` page: Scan shows a clear "not accessible" banner, no crash.

## Test 7 — Privacy check

With DevTools → Network open on a scanned page, confirm no requests go to
any host other than the page's own image hosts (thumbnails requested by the
popup come from the same URLs the page itself already used). The extension
contains no analytics or remote endpoints.
