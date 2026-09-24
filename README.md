# Fab Seller Blocklist

FAB is flooded with practically useless assets that makes discovery of nice assets almost impossible.

With this browser extension you can easily block sellers so they never show up when browsing FAB.

I don't understand why FAB didn't make this feature or curate their marketplace more. The argument of empowering creators doesn't hold up when the actual proper creators drown in trash.

## Block sellers

Hover a seller's name → click **Block**.

![Block button highlighted by a blue arrow](BlockEm.jpg)

## Manage your list

Open the extension's toolbar icon. Add/remove sellers, block keywords, or import/export lists.

Lists stay in this browser; use export/import to move them. Existing lists migrate automatically.

Open **Backups & recovery** in the toolbar popup to download a JSON backup or
restore a downloaded file. The backup includes sellers, keywords, and the reload
preference. Keep a copy outside the browser (for example in your usual backed-up
folder); it can be restored after reinstalling the extension or on another computer.

The extension also saves a restore point before each list or settings change,
including **Clear all** and restores. It keeps up to 10 previous versions, trimming
older versions when the history exceeds about 2 MB. Restoring replaces your list
and settings after confirmation; the replaced list becomes a restore point too.
Normal updates and reloads preserve local data. Uninstalling the extension or
losing the browser profile removes both the list and its local restore points,
so keep a downloaded backup for protection against those cases. File backups are
downloaded on request; nothing is uploaded to a cloud service automatically.

![Seller and keyword controls in the toolbar popup](Toolbar.jpg)

## Install

For **Chrome, Edge, Brave, and Opera** (Chromium). Firefox/Safari not supported.

1. **Code → Download ZIP**, then extract and keep the folder.
2. Open your browser's **Extensions** page → enable **Developer mode**.
3. **Load unpacked** → select the extracted folder containing `manifest.json`.

After updating or reloading the extension, refresh any open Fab tabs too. An
"Extension context invalidated" error means the tab is still running the old
copy of the extension; refresh the Fab page and retry the action. Your saved
blocklist stays in browser storage.

Unofficial; not affiliated with Epic Games.
