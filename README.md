# Fab Seller Blocklist

FAB is flooded with practically useless assets that makes discovery of nice assets almost impossible.

With this browser extension you can easily block sellers so they never show up when browsing FAB.

I don't understand why FAB didn't make this feature or curate their marketplace more. The argument of empowering creators doesn't hold up when the actual proper creators drown in trash.

## Block a seller while browsing

Hover over a seller's name on a listing card to reveal **Block**, then click it to hide listings from that seller.

![The Block button below a seller's name, highlighted with a blue arrow](BlockEm.jpg)

## Manage your blocklist from the toolbar

Click the extension's icon in your browser toolbar to open this panel. Add or remove sellers, block keywords in listing titles, and import or export your lists. Use **Remove** to let a seller's listings appear again.

![Extension toolbar panel with blocked sellers, blocked keywords, reload preference, and import and export controls](Toolbar.jpg)

## Browser compatibility

Designed for Chromium browsers, including Google Chrome, Microsoft Edge, Brave, and Opera.
Firefox and Safari are not currently tested or supported.

## Install (unpacked)

1. Open your browser's Extensions page (`chrome://extensions` in Chrome or `edge://extensions` in Edge).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Browse Fab. Hover a seller name on any card and click **Block**.

Works in Edge, Brave and other Chromium browsers the same way.

## Usage

- **On cards:** hover a seller name, click **Block** / **Unblock**.
- **On a seller or listing page:** a red banner appears if the seller is blocked.
- **Popup (toolbar icon):** add by name, remove, import/export as a plain newline list,
  or block the seller of the page you are currently on.
- **Blocked keywords:** any listing whose title contains one of these substrings
  (case-insensitive) is hidden, regardless of seller. E.g. `metahuman` hides "MetaHuman Tank Top".
  In import/export, lines prefixed with `kw:` are keywords; everything else is a seller.
- **Reload the page after blocking or unblocking** (popup checkbox, on by default): when on,
  every change reloads the Fab tab so the grid refills with fresh listings. When off, cards are
  hidden or restored in place without a reload.
- The list is stored in your browser's extension storage (`chrome.storage.sync`). Cross-device syncing depends on your browser and sync settings.

## How it works

`content.js` runs at `document_start`, attaches a `MutationObserver`, and processes every
`a[href*="/sellers/"]` link as Fab's React app renders it. The seller slug is decoded from the
href and compared case-insensitively against the blocklist. Matching cards get every `img`,
`source` and `video` stripped of `src`/`srcset` and are given `display: none`.

On listing detail pages the seller is read from the schema.org `Product` JSON-LD block that
Fab server-renders for search engines, so it does not depend on Fab's hashed CSS class names.

No network requests are made by the extension and nothing leaves your browser.
