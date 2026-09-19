// Fab Seller Blocklist - content script
// Runs at document_start so the MutationObserver is attached before the
// React app renders any listing cards. Blocked cards get their <img> src
// removed before the browser issues the request, then the whole card is hidden.

(() => {
  const STORAGE_KEY = 'blockedSellers';
  const KEYWORDS_KEY = 'blockedKeywords';
  const RELOAD_KEY = 'reloadOnChange';
  let blocked = new Set(); // normalized seller names
  let keywords = []; // lowercased substrings matched against listing titles
  let reloadOnChange = true;
  let hiddenCount = 0;
  let counterEl = null;

  const normalize = (name) => {
    let s = String(name || '');
    try { s = decodeURIComponent(s); } catch (_) {}
    return s.trim().replace(/\s+/g, ' ').toLowerCase();
  };

  // "/sellers/Vanlife%20Game%20Studio" -> "vanlife game studio"
  const sellerFromHref = (href) => {
    const m = /\/sellers\/([^/?#]+)/.exec(href || '');
    return m ? normalize(m[1]) : null;
  };

  // ---------- storage ----------
  const load = () =>
    new Promise((resolve) => {
      chrome.storage.sync.get({ [STORAGE_KEY]: [], [KEYWORDS_KEY]: [], [RELOAD_KEY]: true }, (res) => {
        blocked = new Set((res[STORAGE_KEY] || []).map(normalize));
        keywords = (res[KEYWORDS_KEY] || []).map(normalize).filter(Boolean);
        reloadOnChange = res[RELOAD_KEY] !== false;
        resolve();
      });
    });

  const save = () =>
    chrome.storage.sync.set({ [STORAGE_KEY]: [...blocked].sort() });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes[RELOAD_KEY]) reloadOnChange = changes[RELOAD_KEY].newValue !== false;
    let dirty = false;
    if (changes[STORAGE_KEY]) {
      blocked = new Set((changes[STORAGE_KEY].newValue || []).map(normalize));
      dirty = true;
    }
    if (changes[KEYWORDS_KEY]) {
      keywords = (changes[KEYWORDS_KEY].newValue || []).map(normalize).filter(Boolean);
      dirty = true;
    }
    if (dirty) rescan(true);
  });

  // ---------- image suppression ----------
  const stripImages = (root) => {
    root.querySelectorAll('img, source, video').forEach((el) => {
      if (el.dataset.fsbSrc === undefined) {
        el.dataset.fsbSrc = el.getAttribute('src') || '';
        el.dataset.fsbSrcset = el.getAttribute('srcset') || '';
      }
      el.removeAttribute('src');
      el.removeAttribute('srcset');
      if (el.tagName === 'VIDEO') el.removeAttribute('poster');
    });
    // Background images set via inline style
    root.querySelectorAll('[style*="background"]').forEach((el) => {
      if (el.dataset.fsbBg === undefined) el.dataset.fsbBg = el.style.backgroundImage;
      el.style.backgroundImage = 'none';
    });
  };

  const restoreImages = (root) => {
    root.querySelectorAll('[data-fsb-src]').forEach((el) => {
      if (el.dataset.fsbSrc) el.setAttribute('src', el.dataset.fsbSrc);
      if (el.dataset.fsbSrcset) el.setAttribute('srcset', el.dataset.fsbSrcset);
      delete el.dataset.fsbSrc;
      delete el.dataset.fsbSrcset;
    });
    root.querySelectorAll('[data-fsb-bg]').forEach((el) => {
      el.style.backgroundImage = el.dataset.fsbBg;
      delete el.dataset.fsbBg;
    });
  };

  // ---------- card handling ----------
  // Walk up from a seller link to the element that represents one listing card.
  // Fab wraps cards in <li> in carousels and in a div grid in search results.
  const findCard = (sellerLink) => {
    let el = sellerLink;
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      el = el.parentElement;
      if (!el) break;
      if (el.tagName === 'LI') return el;
      // A card contains exactly one listing link and one seller link
      if (
        el.querySelectorAll('a[href*="/listings/"]').length === 1 &&
        el.querySelectorAll('a[href*="/sellers/"]').length === 1 &&
        el.querySelector('img, [class*="Thumbnail"]')
      ) {
        // keep climbing while the parent still only wraps this one card
        const p = el.parentElement;
        if (
          p &&
          p.querySelectorAll('a[href*="/listings/"]').length === 1 &&
          p.children.length === 1
        ) {
          continue;
        }
        return el;
      }
    }
    return null;
  };

  // Title of the listing inside a card. Fab puts "Title by Seller" in the
  // listing link's aria-label; fall back to the link text.
  const cardTitle = (card) => {
    const a = card.querySelector('a[href*="/listings/"]');
    if (!a) return '';
    const label = a.getAttribute('aria-label') || '';
    if (!label) return normalize(a.textContent);
    // Strip the exact " by <seller>" suffix so titles containing " by " survive intact
    const sellerLink = card.querySelector('a[href*="/sellers/"]');
    const sellerText = sellerLink ? sellerLink.textContent.trim() : '';
    const suffix = ' by ' + sellerText;
    const t = sellerText && label.endsWith(suffix)
      ? label.slice(0, -suffix.length)
      : label.replace(/\s+by\s+[^]*$/i, '');
    return normalize(t);
  };

  // Returns the first keyword found in the text, or null.
  const matchKeyword = (text) => {
    if (!text || !keywords.length) return null;
    for (const k of keywords) if (text.includes(k)) return k;
    return null;
  };

  const processSellerLink = (link) => {
    const seller = sellerFromHref(link.getAttribute('href'));
    if (!seller) return;
    const card = findCard(link);
    if (!card) return;

    const kw = matchKeyword(cardTitle(card));
    const isBlocked = blocked.has(seller) || kw !== null;
    const wasHidden = card.classList.contains('fsb-hidden');

    if (isBlocked && !wasHidden) {
      stripImages(card);
      card.classList.add('fsb-hidden');
      card.dataset.fsbReason = blocked.has(seller) ? 'seller:' + seller : 'keyword:' + kw;
      hiddenCount++;
    } else if (!isBlocked && wasHidden) {
      card.classList.remove('fsb-hidden');
      restoreImages(card);
      delete card.dataset.fsbReason;
      hiddenCount = Math.max(0, hiddenCount - 1);
    }

    addButton(link, seller);
  };

  const addButton = (link, seller) => {
    if (link.dataset.fsbBtn) return;
    if (link.closest('.fsb-banner')) return;
    link.dataset.fsbBtn = '1';
    const btn = document.createElement('button');
    btn.className = 'fsb-btn';
    btn.type = 'button';
    const label = blocked.has(seller) ? 'Unblock' : 'Block';
    btn.textContent = label;
    btn.title = label + ' seller "' + seller + '"';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleSeller(seller);
    });
    link.insertAdjacentElement('afterend', btn);
  };

  const toggleSeller = (seller) => {
    if (blocked.has(seller)) blocked.delete(seller);
    else blocked.add(seller);
    // Persist. If enabled, reload so the grid refills with fresh listings;
    // otherwise the onChanged listener hides/restores cards in place.
    Promise.resolve(save()).then(() => {
      if (reloadOnChange) location.reload();
    });
  };

  // ---------- page-level: seller profile and listing detail ----------
  const currentPageSeller = () => {
    // Seller profile page
    const m = /\/sellers\/([^/?#]+)/.exec(location.pathname);
    if (m) return normalize(m[1]);
    // Listing detail page: read schema.org Product block
    if (/\/listings\//.test(location.pathname)) {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(s.textContent);
          const name =
            (data && data.offers && data.offers.seller && data.offers.seller.name) ||
            (data && data.brand && data.brand.name);
          if (name) return normalize(name);
        } catch (_) {}
      }
    }
    return null;
  };

  const currentPageTitle = () => {
    if (!/\/listings\//.test(location.pathname)) return '';
    const og = document.querySelector('meta[property="og:title"]');
    return normalize((og && og.getAttribute('content')) || document.title);
  };

  const updateBanner = () => {
    if (!document.body) return;
    const seller = currentPageSeller();
    const kw = matchKeyword(currentPageTitle());
    const sellerBlocked = !!(seller && blocked.has(seller));
    const existing = document.querySelector('.fsb-banner');
    if (!sellerBlocked && !kw) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const banner = document.createElement('div');
    banner.className = 'fsb-banner';
    const text = document.createElement('span');
    text.textContent = sellerBlocked
      ? 'Seller "' + seller + '" is on your blocklist.'
      : 'Title matches blocked keyword "' + kw + '".';
    banner.appendChild(text);
    if (sellerBlocked) {
      const btn = document.createElement('button');
      btn.textContent = 'Unblock';
      btn.addEventListener('click', () => toggleSeller(seller));
      banner.appendChild(btn);
    }
    document.body.prepend(banner);
  };

  // ---------- counter ----------
  const updateCounter = () => {
    if (!document.body) return;
    if (hiddenCount === 0) {
      if (counterEl) counterEl.remove();
      counterEl = null;
      return;
    }
    if (!counterEl || !counterEl.isConnected) {
      counterEl = document.createElement('div');
      counterEl.className = 'fsb-counter';
      document.body.appendChild(counterEl);
    }
    counterEl.textContent = hiddenCount + ' listing' + (hiddenCount === 1 ? '' : 's') + ' hidden';
  };

  // ---------- scanning ----------
  const scan = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('a[href*="/sellers/"]').forEach(processSellerLink);
    if (root.matches && root.matches('a[href*="/sellers/"]')) processSellerLink(root);
  };

  const rescan = (full) => {
    if (full) {
      hiddenCount = 0;
      document.querySelectorAll('.fsb-hidden').forEach((card) => {
        card.classList.remove('fsb-hidden');
        restoreImages(card);
        delete card.dataset.fsbReason;
      });
      document.querySelectorAll('.fsb-btn').forEach((b) => b.remove());
      document.querySelectorAll('[data-fsb-btn]').forEach((l) => delete l.dataset.fsbBtn);
    }
    scan(document);
    updateBanner();
    updateCounter();
  };

  let scheduled = false;
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) scan(n);
      });
    }
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        updateBanner();
        updateCounter();
      });
    }
  });

  // SPA navigation: re-evaluate the banner and counter on URL changes
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      hiddenCount = document.querySelectorAll('.fsb-hidden').length;
      updateBanner();
      updateCounter();
    }
  }, 500);

  // ---------- boot ----------
  load().then(() => {
    const start = () => {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      rescan(false);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });

  // Messages from the popup ("which seller is this page?")
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg && msg.type === 'fsb:currentSeller') {
      respond({ seller: currentPageSeller() });
    }
  });
})();
