/**
 * Twitter Better List - own/public lists page (ISOLATED world)
 *
 * /<screen_name>/lists のリスト一覧にも、追加/削除ダイアログと同じ
 * 並び替え・お気に入り・タグ絞り込みを適用する。
 *
 * ネイティブの行 (listCell / cellInnerDiv) はそのまま使い、絶対配置の
 * transform だけを付け替える。ネイティブが再描画した場合は監視して
 * 再度適用する。
 */
(() => {
  'use strict';

  const TBL = window.__TBL__;
  if (!TBL) return;

  const PAGE_RE = /^\/([^/]+)\/lists\/?$/i;
  const RESERVED = new Set([
    'i',
    'home',
    'explore',
    'notifications',
    'messages',
    'settings',
    'compose',
    'search',
  ]);
  const CREATE_RE = /Create a new List|新しいリストを作成|リストを作成/i;

  const state = {
    active: false,
    starting: false,
    primary: null,
    container: null,
    containerIsOwn: false,
    pageHandle: '',
    toolbar: null,
    rows: [],
    otherRows: [],
    favoritesOnly: false,
    activeTags: new Set(),
    searchQuery: '',
    chipsSignature: '',
    observer: null,
    observerTarget: null,
    scanTimer: null,
    metaRequestAt: 0,
    discoverExpanded: false,
    discoverToggle: null,
    discoverHidden: new Set(),
    isScrolling: false,
    scrollTimer: null,
    pageViewport: null,
    pageViewportParent: null,
    pageExpanded: false,
    pageExpandHeight: 0,
    pageBaseScrollHeight: 0,
    pageExpandAt: 0,
    pageFitsContent: false,
    lastScrollTop: 0,
    reorderBlocked: false,
    sectionOffsetApplied: false,
    sectionOffsetDirty: true,
    sectionOffsetDelta: 0,
    sectionOffsetContainer: null,
    sectionOffsetExpanded: null,
    sectionOffsetHide: null,
    discoverMode: '',
  };

  const OWN_RE = /^(自分のリスト|Your lists?)$/i;
  const GENERIC_LIST_RE = /^(リスト|Lists?)$/i;
  const DISCOVER_RE =
    /^(新しいリストを見つける|Discover new Lists?|New to Lists|Lists you might like|Find new lists)$/i;

  let collator = null;
  let collatorLang = '';

  function getCollator() {
    const lang = TBL.isJa() ? 'ja' : 'en';
    if (!collator || collatorLang !== lang) {
      collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
      collatorLang = lang;
    }
    return collator;
  }

  function pathInfo() {
    const match = location.pathname.match(PAGE_RE);
    if (!match) return null;
    const handle = match[1];
    if (!handle || RESERVED.has(handle.toLowerCase())) return null;
    return { handle };
  }

  function shouldRun(info) {
    // /<user>/lists は、自分以外の公開リストページでも同じ並び替え・
    // フィルターを使えるようにする。ダイアログ用の /i/lists/add_member
    // などは pathInfo 側で除外している。
    return Boolean(info);
  }

  function isCreateRow(el) {
    return CREATE_RE.test(el?.textContent || '');
  }

  function isBlankSpacer(el) {
    return (
      !el.textContent.trim() &&
      !el.querySelector('button, a, [role="button"]')
    );
  }

  function normalizePageName(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
  }

  function extractNodeTextWithEmoji(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'IMG') {
        const alt = node.getAttribute('alt');
        if (alt) return alt;
      }
      let out = '';
      for (const child of node.childNodes) {
        out += extractNodeTextWithEmoji(child);
      }
      return out;
    }
    return '';
  }

  function getRowName(el) {
    const cell = el?.querySelector('[data-testid="listCell"]') || el;
    if (!cell) return '';
    const label = cell.querySelector('[dir="ltr"]');
    if (label) {
      const text = extractNodeTextWithEmoji(label).trim();
      if (text) return text;
    }
    return extractNodeTextWithEmoji(cell).split('\n')[0].trim();
  }

  function getRowMemberCount(el) {
    const text = el?.innerText || '';
    const ja = text.match(/([\d,.]+)\s*人のメンバー/);
    const en = text.match(/([\d,.]+)\s+members?/i);
    const raw = ja?.[1] || en?.[1];
    if (!raw) return null;
    const value = Number(raw.replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  }

  /*
   * The real content script runs in an isolated world, where React's fiber
   * expando properties are not readable.  In that case, resolve the list ID
   * from the cache that the main-world bridge populated from X's own
   * ListsManagementPageTimeline / ListOwnerships response.  The native row
   * text is enough to identify it.
   */
  function findCachedRowMeta(el, name) {
    const key = normalizePageName(name);
    if (!key) return null;

    // Normally the current viewer's cache is authoritative.  If the viewer
    // could not be detected (isolated world / stale meta), fall back to the
    // other caches so that a target-keyed legacy cache still supplies IDs.
    const current = TBL.getCacheForViewer?.();
    const caches = [];
    if (current?.lists) caches.push(current);
    for (const cache of Object.values(TBL.state?.cache || {})) {
      if (cache?.lists && cache !== current) caches.push(cache);
    }

    const matched = new Map();
    for (const cache of caches) {
      let candidates = Object.values(cache.lists).filter(
        (item) => item && normalizePageName(item.name) === key
      );
      if (candidates.length > 1) {
        const count = getRowMemberCount(el);
        if (count != null) {
          const exact = candidates.filter(
            (item) => Number(item.memberCount) === count
          );
          if (exact.length === 1) candidates = exact;
        }
      }
      // A unique hit in the current viewer cache is authoritative.  Do not
      // let a stale cache from another viewer turn it into an ambiguous match.
      if (cache === current && candidates.length === 1) {
        const item = candidates[0];
        if (item?.id != null) {
          return {
            id: String(item.id),
            name: item.name || name,
            ownerId: item.ownerId == null ? null : String(item.ownerId),
            createdAt: Number(item.createdAt) || 0,
          };
        }
      }
      for (const item of candidates) {
        if (item?.id != null) matched.set(String(item.id), item);
      }
    }

    if (matched.size !== 1) return null;
    const item = Array.from(matched.values())[0];
    return {
      id: String(item.id),
      name: item.name || name,
      ownerId: item.ownerId == null ? null : String(item.ownerId),
      createdAt: Number(item.createdAt) || 0,
    };
  }

  function extractListIdFromRow(el) {
    if (!el) return null;
    const link =
      (el.matches?.('a[href]') ? el : null) ||
      el.querySelector?.('a[href*="/lists/"], [role="link"][href*="/lists/"]') ||
      el.closest?.('a[href*="/lists/"]');
    if (link) {
      const href = link.getAttribute('href') || link.href || '';
      const match = href.match(/\/lists\/(\d+)(?:[/?#]|$)/);
      if (match) return match[1];
    }
    const allLinks = el.querySelectorAll?.('a[href]');
    if (allLinks) {
      for (const a of allLinks) {
        const href = a.getAttribute('href') || a.href || '';
        const match = href.match(/\/lists\/(\d+)(?:[/?#]|$)/);
        if (match) return match[1];
      }
    }
    return null;
  }

  function resolveRowMeta(el, cell) {
    let fiberMeta = null;
    try {
      fiberMeta = TBL.readListMeta(cell) || TBL.readListMeta(el);
    } catch {
      fiberMeta = null;
    }
    const name = getRowName(el) || fiberMeta?.name || '';
    if (fiberMeta?.id) {
      return {
        id: String(fiberMeta.id),
        name: fiberMeta.name || name,
        ownerId:
          fiberMeta.ownerId == null ? null : String(fiberMeta.ownerId),
        createdAt: Number(fiberMeta.createdAt) || 0,
      };
    }

    const domId = extractListIdFromRow(el) || extractListIdFromRow(cell);
    if (domId) {
      const cached = TBL.getCachedList?.(domId);
      return {
        id: domId,
        name: name || cached?.name || '',
        ownerId: cached?.ownerId == null ? null : String(cached.ownerId),
        createdAt: Number(cached?.createdAt) || 0,
      };
    }

    // A recycled virtualized row may still carry the previous list's ID.
    // Only trust it when the visible name still matches.
    if (el.dataset.tblListId && el.dataset.tblName === name) {
      return {
        id: String(el.dataset.tblListId),
        name,
        ownerId: el.dataset.tblOwnerId || null,
        createdAt: Number(el.dataset.tblCreatedAt) || 0,
      };
    }

    const cached = findCachedRowMeta(el, name);
    if (cached) return cached;
    return { id: '', name, ownerId: null, createdAt: 0 };
  }

  function backupStyle(el) {
    if (!el || el.__tblPageBackup) return;
    el.__tblPageBackup = {
      transform: el.style.transform,
      position: el.style.position,
      width: el.style.width,
      top: el.style.top,
    };
  }

  function restoreStyle(el) {
    const backup = el?.__tblPageBackup;
    if (!backup) return;
    if (backup.transform) el.style.transform = backup.transform;
    else el.style.removeProperty('transform');
    if (backup.position) el.style.position = backup.position;
    else el.style.removeProperty('position');
    if (backup.width) el.style.width = backup.width;
    else el.style.removeProperty('width');
    if (backup.top) el.style.top = backup.top;
    else el.style.removeProperty('top');
    delete el.__tblPageBackup;
  }

  function setStyle(el, property, value) {
    if (el.style.getPropertyValue(property) !== value) {
      el.style.setProperty(property, value);
    }
  }

  /*
   * X positions every timeline row with an inline
   * `transform: translateY(...)`.  That transform is also what its
   * virtualizer uses to decide which rows stay mounted.  Do not replace it
   * with our own sorted coordinates: when a row is moved out of the
   * virtualizer's window it gets unmounted, which is what made the lists page
   * jump/blank while scrolling.  Keep the native transform untouched and add
   * a relative `top` offset only.  The offset can reorder rows inside the
   * already-mounted window without confusing X's layout bookkeeping.
   */
  function nativeTop(el, container) {
    if (!el || !container) return 0;
    const transform = el.style.transform || '';
    const match = transform.match(/translateY\((-?[\d.]+)px\)/);
    if (match) return Number(match[1]);
    const offset = Number.parseFloat(el.style.top);
    const top =
      el.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return top - (Number.isFinite(offset) ? offset : 0);
  }

  function setTopOffset(el, value) {
    if (!el) return;
    backupStyle(el);
    const rounded = Math.round(value);
    if (Math.abs(rounded) < 1) {
      el.style.removeProperty('top');
    } else {
      setStyle(el, 'top', `${rounded}px`);
    }
  }

  function rowHeight(el) {
    return Math.max(0, el.getBoundingClientRect().height || el.offsetHeight || 0);
  }

  function findPrimary() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function findHeaderByPattern(container, pattern) {
    if (!container) return null;
    const headers = Array.from(
      container.querySelectorAll('h1, h2, [role="heading"]')
    ).filter((el) => pattern.test((el.textContent || '').trim()));
    return headers.length ? headers[headers.length - 1] : null;
  }

  function getViewerHandle() {
    try {
      const link = document.querySelector(
        'a[data-testid="AppTabBar_Profile_Link"]'
      );
      const href = link?.getAttribute('href') || link?.href || '';
      const match = href.match(/^\/([^/?#]+)/);
      if (match) return decodeURIComponent(match[1]).toLowerCase();
      const switcher = document.querySelector(
        '[data-testid="SideNav_AccountSwitcher_Button"]'
      );
      const text = switcher?.innerText || '';
      const handle = text.match(/@([A-Za-z0-9_]+)/);
      if (handle) return handle[1].toLowerCase();
    } catch {
      /* ignore */
    }
    return '';
  }

  function isOwnPageByUrl() {
    const info = pathInfo();
    if (!info?.handle) return null;
    // ListsManagementPageTimeline is only requested for the signed-in
    // viewer's own page.  MAIN world reports that request immediately, which
    // lets us classify the page before the sidebar/profile link or pin
    // buttons have rendered.  Without this, the first scan can treat the
    // recommendation section as a public lists page and move its rows.
    const ownPath = String(
      TBL.state?.ownListsPagePath ||
        document.documentElement?.dataset?.tblOwnListsPath ||
        ''
    )
      .replace(/\/+$/, '')
      .toLowerCase();
    const currentPath = location.pathname.replace(/\/+$/, '').toLowerCase();
    if (ownPath && ownPath === currentPath) {
      return true;
    }
    const viewer = getViewerHandle();
    if (!viewer) return null;
    return info.handle.toLowerCase() === viewer;
  }

  function looksLikeOwnListsPage(container) {
    // Fallback for the first scan, before the profile link / pin buttons are
    // rendered and before MAIN's signal reaches the isolated world.
    // A public page may share the "Your lists" heading, but the discover
    // section precedes the owner's own-list heading on the owner's page.
    const discoverHeader = findDiscoverHeader(container);
    const ownHeader = findHeaderByPattern(container, OWN_RE);
    if (!discoverHeader || !ownHeader) return false;
    return Boolean(
      ownHeader.compareDocumentPosition(discoverHeader) &
        Node.DOCUMENT_POSITION_PRECEDING
    );
  }

  function isOwnContainer(container) {
    if (!container) return false;
    // X uses the localized "自分のリスト" heading on other users' public list
    // pages too, so a heading match cannot distinguish them.  Compare the URL
    // handle with the signed-in account instead.
    const byUrl = isOwnPageByUrl();
    if (byUrl !== null) return byUrl;
    if (looksLikeOwnListsPage(container)) return true;
    // If the navigation/profile link has not rendered yet, the native pin
    // button is still a reliable own-page signal.
    return Boolean(
      container.querySelector('button[data-testid="list-icon-button"]')
    );
  }

  function findOwnScopeStart(container) {
    return (
      findHeaderByPattern(container, OWN_RE) ||
      findHeaderByPattern(container, GENERIC_LIST_RE)
    );
  }

  function findDiscoverHeader(container) {
    if (!container) return null;
    const headers = Array.from(
      container.querySelectorAll('h1, h2, [role="heading"]')
    ).filter((el) =>
      DISCOVER_RE.test((el.textContent || '').trim())
    );
    return headers.length ? headers[0] : null;
  }

  function topLevelChild(container, node) {
    if (!container || !node) return null;
    let el = node;
    while (el.parentElement && el.parentElement !== container) {
      el = el.parentElement;
    }
    return el.parentElement === container ? el : null;
  }

  function removeDiscoverToggle() {
    if (state.discoverToggle) state.discoverToggle.remove();
    state.discoverToggle = null;
  }

  function createDiscoverToggle() {
    const button = createButton(
      'tbl-page-discover-toggle',
      '',
      TBL.t('おすすめリストの表示を切り替え', 'Toggle recommended lists')
    );
    button.dataset.tbl = 'discover-toggle';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.discoverExpanded = !state.discoverExpanded;
      if (state.container) {
        applyDiscoverSection(
          state.container,
          findOwnScopeStart(state.container)
        );
        applyOrder(true);
        renderToolbar();
      }
    });
    return button;
  }

  function restoreDiscover() {
    if (state.container) {
      state.container.classList.remove('tbl-discover-collapsed');
    }
    const hidden = new Set([
      ...state.discoverHidden,
      ...document.querySelectorAll('.tbl-page-discover-hidden'),
    ]);
    for (const el of hidden) {
      el.classList.remove('tbl-page-discover-hidden');
    }
    document.querySelectorAll('.tbl-discover-header-row').forEach((el) => {
      el.classList.remove('tbl-discover-header-row');
    });
    state.discoverHidden.clear();
    removeDiscoverToggle();
  }

  function resetSectionOffsetState() {
    state.sectionOffsetApplied = false;
    state.sectionOffsetDirty = true;
    state.sectionOffsetDelta = 0;
    state.sectionOffsetContainer = null;
    state.sectionOffsetExpanded = null;
    state.sectionOffsetHide = null;
    state.discoverMode = '';
  }

  function applyDiscoverSection(container, ownScope) {
    if (!container) return;
    const hide = Boolean(TBL.state.settings.hideDiscoverLists);
    if (hide) {
      // When hideDiscoverLists is ON (default), the recommendation module is
      // completely filtered out from the GraphQL response in MAIN world before React renders it.
      // No discover rows exist in X's virtualizer, completely eliminating both the flash
      // when scrolling to top (Home key) and the scroll jump (row 35 → 16).
      removeDiscoverToggle();
      container.classList.remove('tbl-discover-collapsed');
      return;
    }

    // When the option is OFF, do not hide or collapse recommendations.
    // Leaving them in their native layout keeps X's virtualizer coordinates 100% in sync,
    // which prevents scroll jumps.  Also clear any hidden classes left behind
    // by an older build or a setting change, otherwise the section stays
    // invisible until X remounts the virtualized rows while scrolling.
    restoreDiscover();
    clearDiscoverSection(container);
  }

  function countFollowingRows(parent, header, cells) {
    if (!parent || !header) return 0;
    return cells.reduce((count, cell) => {
      if (
        cell.parentElement === parent &&
        header.compareDocumentPosition(cell) & Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return count + 1;
      }
      return count;
    }, 0);
  }

  function findContainer(primary) {
    if (!primary) return null;
    const cells = Array.from(
      primary.querySelectorAll('[data-testid="cellInnerDiv"]')
    ).filter((el) => el.querySelector('[data-testid="listCell"]'));
    if (!cells.length) return null;

    const counts = new Map();
    for (const cell of cells) {
      const parent = cell.parentElement;
      if (!parent) continue;
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }

    // The recommended section can mount more rows than the owner's section.
    // Prefer the container that actually contains "Your lists" (or the page's
    // generic "Lists" heading), otherwise the toolbar attaches to the
    // recommendations and the real rows are left in native order.
    let best = null;
    let bestScore = -1;
    let bestCount = -1;
    for (const [parent, count] of counts) {
      const strictHeader = findHeaderByPattern(parent, OWN_RE);
      const header = strictHeader || findHeaderByPattern(parent, GENERIC_LIST_RE);
      const ownCount = countFollowingRows(parent, header, cells);
      // A strict "Your lists" header is much stronger evidence than a generic
      // "Lists" heading that may belong to the recommendations block.
      const score = (strictHeader ? 1000 : 0) + ownCount;
      if (
        score > bestScore ||
        (score === bestScore && count > bestCount)
      ) {
        best = parent;
        bestScore = score;
        bestCount = count;
      }
    }
    return best;
  }

  function backupElementStyle(el) {
    if (!el || el.__tblPageViewportBackup != null) return;
    el.__tblPageViewportBackup = el.getAttribute('style') || '';
  }

  function restoreElementStyle(el) {
    if (!el || el.__tblPageViewportBackup == null) return;
    const style = el.__tblPageViewportBackup;
    if (style) el.setAttribute('style', style);
    else el.removeAttribute('style');
    delete el.__tblPageViewportBackup;
  }

  function elementDepth(el) {
    let depth = 0;
    while (el?.parentElement) {
      depth += 1;
      el = el.parentElement;
    }
    return depth;
  }

  function findPageViewport(primary, container) {
    if (!primary || !container) return null;
    const candidates = Array.from(
      document.querySelectorAll('div[data-viewportview="true"]')
    )
      .filter((el) => el.contains(container) && el.clientHeight > 0)
      .sort((a, b) => elementDepth(b) - elementDepth(a));
    if (candidates.length) return candidates[0];

    // Some X layouts do not mark the scroll element.  Fall back to the nearest
    // scrollable ancestor, but never use the document itself.
    let node = container.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        node.clientHeight > 0 &&
        node !== primary
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function pageTargetHeight() {
    const total = Math.max(
      state.rows.length,
      cachedTotalForPage(),
      cachedOwnedCount(),
      1
    );
    const measured = state.rows
      .map((row) => rowHeight(row.el))
      .filter((height) => height > 0);
    const rowHeightEstimate = measured.length
      ? measured.reduce((sum, height) => sum + height, 0) / measured.length
      : 88;
    const base = state.pageBaseScrollHeight || 0;
    return Math.min(
      20000,
      Math.max(
        1600,
        total * Math.max(64, rowHeightEstimate) + 900,
        base + 600
      )
    );
  }

  function collapsePageViewport() {
    if (state.pageViewport) {
      state.pageViewport.removeAttribute('data-tbl-page-expanded');
      restoreElementStyle(state.pageViewport);
    }
    if (state.pageViewportParent) {
      restoreElementStyle(state.pageViewportParent);
    }
    state.pageViewport = null;
    state.pageViewportParent = null;
    state.pageExpanded = false;
    state.pageExpandHeight = 0;
    state.pageBaseScrollHeight = 0;
    state.pageFitsContent = false;
  }

  function ensurePageViewport(container) {
    if (state.containerIsOwn) {
      // Own lists are sorted in the GraphQL response, so leave X's native
      // virtualizer geometry untouched.
      if (state.pageViewport) collapsePageViewport();
      return false;
    }
    const primary = state.primary || findPrimary();
    const viewport = findPageViewport(primary, container);
    if (!viewport) {
      if (state.pageViewport) collapsePageViewport();
      return false;
    }

    if (state.pageViewport !== viewport) {
      collapsePageViewport();
      state.pageViewport = viewport;
      state.pageViewportParent = viewport.parentElement || null;
    }

    if (!state.pageExpanded) {
      state.pageBaseScrollHeight = Math.max(
        state.pageBaseScrollHeight || 0,
        viewport.scrollHeight || 0
      );
    }

    const contentFits =
      viewport.scrollHeight <= viewport.clientHeight + 120;
    if (contentFits && state.rows.length <= 12) {
      // No virtualization is active for a short list.  Mark it safe without
      // changing the page geometry.
      state.pageExpanded = true;
      state.pageFitsContent = true;
      return true;
    }

    const height = Math.max(pageTargetHeight(), state.pageExpandHeight || 0);
    if (
      state.pageExpanded &&
      viewport.clientHeight >= height - 80 &&
      state.pageExpandHeight >= height - 80
    ) {
      state.pageFitsContent =
        viewport.scrollHeight <= viewport.clientHeight + 120;
      return true;
    }

    backupElementStyle(viewport);
    setStyle(viewport, 'height', `${height}px`);
    setStyle(viewport, 'min-height', '0px');
    setStyle(viewport, 'max-height', 'none');
    setStyle(viewport, 'flex', `0 0 ${height}px`);
    setStyle(viewport, 'overflow', 'visible');
    setStyle(viewport, 'overflow-y', 'visible');
    viewport.setAttribute('data-tbl-page-expanded', '1');

    const parent = state.pageViewportParent;
    if (
      parent &&
      parent !== viewport &&
      parent !== document.documentElement
    ) {
      const parentOverflow = getComputedStyle(parent).overflowY;
      if (parentOverflow === 'hidden' || parentOverflow === 'clip') {
        backupElementStyle(parent);
        setStyle(parent, 'overflow-y', 'auto');
        setStyle(parent, 'overscroll-behavior', 'contain');
      }
    }

    state.pageExpanded = true;
    state.pageExpandHeight = height;
    state.pageFitsContent =
      viewport.scrollHeight <= viewport.clientHeight + 120;

    const now = Date.now();
    if (now - state.pageExpandAt > 250) {
      state.pageExpandAt = now;
      // Make X's virtualizer notice the new viewport height.  The mutation
      // observer then scans the newly mounted rows.
      void viewport.offsetHeight;
      window.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
    }
    return true;
  }

  function insertToolbar(primary, container) {
    const toolbar = state.toolbar;
    if (!toolbar || !primary || !container) return;
    let wrapper = container;
    while (wrapper.parentElement && wrapper.parentElement !== primary) {
      wrapper = wrapper.parentElement;
    }

    let parent = null;
    let before = null;
    const hasHeader = Boolean(
      wrapper.querySelector('[data-testid="app-bar-back"]')
    );

    if (hasHeader) {
      // ヘッダーとリスト本体の共通の親を見つけ、リスト本体の直前に置く。
      let common = container;
      while (
        common.parentElement &&
        common.parentElement !== wrapper &&
        !common.parentElement.querySelector('[data-testid="app-bar-back"]')
      ) {
        common = common.parentElement;
      }
      parent = common.parentElement;
      before = common;
    } else {
      // 戻るボタンがないページでも、リスト本体の前（見出しの後ろ）に置く。
      let common = container;
      while (common.parentElement && common.parentElement !== wrapper) {
        common = common.parentElement;
      }
      let root = container;
      while (root.parentElement && root.parentElement !== common) {
        root = root.parentElement;
      }
      if (root.parentElement === common) {
        parent = common;
        before = root;
      }
    }

    if (!parent || !before) {
      if (!toolbar.isConnected) primary.prepend(toolbar);
      return;
    }
    if (toolbar.parentElement !== parent || toolbar.nextElementSibling !== before) {
      parent.insertBefore(toolbar, before);
    }
  }

  function createButton(className, text, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    if (title) {
      button.title = title;
      button.setAttribute('aria-label', title);
    }
    return button;
  }

  function createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'tbl-toolbar tbl-page-toolbar';
    toolbar.dataset.tbl = 'page-toolbar';

    const main = document.createElement('div');
    main.className = 'tbl-toolbar-main';

    const title = document.createElement('div');
    title.className = 'tbl-toolbar-title';
    title.textContent = TBL.t('リストの並び順', 'List order');

    const favoritesOnly = createButton(
      'tbl-sort-btn tbl-fav-filter',
      TBL.t('☆ お気に入り', '☆ Favorites'),
      TBL.t('お気に入りのみ表示', 'Show favorites only')
    );
    favoritesOnly.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.favoritesOnly = !state.favoritesOnly;
      applyOrder(true);
      renderToolbar();
    });

    const sorts = document.createElement('div');
    sorts.className = 'tbl-sort-group';
    for (const mode of ['name', 'newest', 'oldest']) {
      const button = createButton(
        'tbl-sort-btn',
        mode === 'name'
          ? TBL.t('名前順', 'Name')
          : mode === 'newest'
            ? TBL.t('新しい順', 'Newest')
            : TBL.t('古い順', 'Oldest')
      );
      button.dataset.sort = mode;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (TBL.state.settings.sortMode === mode) return;
        TBL.state.settings.sortMode = mode;
        TBL.saveSettings();
        // MAIN world updates X's timeline store directly, so no page reload
        // is needed.  applyOrder() only refreshes our filters/toolbar.
        applyOrder(true);
        renderToolbar();
      });
      sorts.appendChild(button);
    }

    const status = document.createElement('span');
    status.className = 'tbl-status';

    const refresh = createButton(
      'tbl-refresh-btn',
      '↻',
      TBL.t('リストを再読み込み', 'Reload lists')
    );
    refresh.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.containerIsOwn) {
        if (typeof TBL.refreshPage === 'function') {
          TBL.refreshPage();
        } else {
          scan();
        }
        return;
      }
      scan();
    });

    const tail = document.createElement('div');
    tail.className = 'tbl-toolbar-tail';
    tail.append(status, refresh);

    main.append(title, favoritesOnly, sorts, tail);

    const filters = document.createElement('div');
    filters.className = 'tbl-filter-row';

    const filterLabel = document.createElement('span');
    filterLabel.className = 'tbl-filter-label';
    filterLabel.textContent = TBL.t('タグ', 'Tags');

    const chips = document.createElement('div');
    chips.className = 'tbl-filter-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', TBL.t('タグで絞り込み', 'Filter by tag'));

    const bulkRename = createButton(
      'tbl-filter-clear tbl-bulk-rename',
      TBL.t('✎ タグ名変更', '✎ Rename tags'),
      TBL.t('タグを一括リネーム', 'Rename a tag everywhere')
    );
    bulkRename.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      TBL.openBulkTagRename(event.currentTarget);
    });

    const clear = createButton(
      'tbl-filter-clear',
      TBL.t('クリア', 'Clear'),
      TBL.t('タグ絞り込みを解除', 'Clear tag filter')
    );
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.activeTags.clear();
      applyOrder(true);
      renderToolbar();
    });

    filters.append(filterLabel, chips, bulkRename, clear);

    const searchRow = document.createElement('div');
    searchRow.className = 'tbl-search-row';
    searchRow.dataset.tbl = 'search';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'tbl-search-input';
    searchInput.placeholder = TBL.t('リスト名で検索', 'Search list names');
    searchInput.setAttribute(
      'aria-label',
      TBL.t('リスト名で検索', 'Search list names')
    );
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;

    const clearSearch = createButton(
      'tbl-filter-clear tbl-search-clear',
      TBL.t('クリア', 'Clear'),
      TBL.t('検索をクリア', 'Clear search')
    );
    clearSearch.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.searchQuery = '';
      searchInput.value = '';
      applyOrder(true);
      renderToolbar();
      searchInput.focus();
    });

    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      applyOrder(true);
      renderToolbar();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      state.searchQuery = '';
      searchInput.value = '';
      applyOrder(true);
      renderToolbar();
    });

    searchRow.append(searchInput, clearSearch);
    toolbar.append(main, filters, searchRow);
    return toolbar;
  }

  function getPageTagCatalog() {
    const catalog = new Map();
    const idSet = new Set(state.rows.map((row) => row.id).filter(Boolean));
    if (state.containerIsOwn) {
      // The own page is virtualized, so state.rows only covers the mounted
      // part.  Use the complete viewer cache for the chip list/counts, while
      // keeping mounted foreign (followed) lists visible.
      for (const item of cachedOwnedEntries()) {
        if (item?.id != null) idSet.add(String(item.id));
      }
    }
    for (const id of idSet) {
      for (const value of TBL.getListTags(id)) {
        const tag = TBL.normalizeTag(value);
        const key = TBL.tagKey(tag);
        if (!tag || !key) continue;
        const entry = catalog.get(key) || { key, label: tag, count: 0 };
        entry.count += 1;
        catalog.set(key, entry);
      }
    }
    return Array.from(catalog.values()).sort((a, b) =>
      getCollator().compare(a.label, b.label)
    );
  }

  function foreignDefaultTag(row) {
    const viewerId = TBL.getViewerId();
    if (!row?.id || !row.ownerId || !viewerId) return '';
    if (String(row.ownerId) === String(viewerId)) return '';
    return TBL.normalizeTag(
      TBL.t('他人が作ったリスト', 'List by someone else')
    );
  }

  /*
   * Lists created by other users can appear in "Your lists" when they are
   * followed.  Seed the same "created by someone else" tag once, then remember
   * that we did; if the user later removes/renames the tag, it is not re-added
   * on every scan.  Recommended lists outside the own section are never in
   * state.rows, so they are untouched.
   */
  function ensureForeignDefaultTags(rows) {
    const viewerId = TBL.getViewerId();
    if (!viewerId) return false;
    /*
     * lists-page also runs on other users' public /<user>/lists pages.  Only
     * seed defaults when this page also contains at least one list owned by
     * the viewer, i.e. it is the viewer's own lists page.  Otherwise viewing
     * someone else's page would tag all of their lists in our settings.
     */
    const isOwnPage = rows.some(
      (row) =>
        row.ownerId && String(row.ownerId) === String(viewerId)
    );
    if (!isOwnPage) return false;
    const settings = TBL.state.settings;
    if (!settings.tags || typeof settings.tags !== 'object') {
      settings.tags = {};
    }
    if (
      !settings.defaultTagSeeded ||
      typeof settings.defaultTagSeeded !== 'object'
    ) {
      settings.defaultTagSeeded = {};
    }

    const currentTags =
      settings.tags[viewerId] && typeof settings.tags[viewerId] === 'object'
        ? { ...settings.tags[viewerId] }
        : {};
    const seeded =
      settings.defaultTagSeeded[viewerId] &&
      typeof settings.defaultTagSeeded[viewerId] === 'object'
        ? { ...settings.defaultTagSeeded[viewerId] }
        : {};
    let changed = false;

    for (const row of rows) {
      const tag = foreignDefaultTag(row);
      if (!tag) continue;
      const id = String(row.id);
      /*
       * Never rewrite tags that were added by an older build.  Those old
       * markers may point at a tag the user has since renamed or re-created
       * manually, so touching them automatically can delete a legitimate tag.
       * Only lists that have never been seeded get the new default once.
       */
      if (seeded[id]) continue;

      let tags = Array.isArray(currentTags[id])
        ? [...currentTags[id]]
        : [];
      const key = TBL.tagKey(tag);
      if (!tags.some((value) => TBL.tagKey(value) === key)) tags.push(tag);
      currentTags[id] = tags;
      seeded[id] = `v2:${row.ownerId}`;
      changed = true;
    }

    if (changed) {
      settings.tags[viewerId] = currentTags;
      settings.defaultTagSeeded[viewerId] = seeded;
      TBL.saveSettings();
    }
    return changed;
  }

  function pruneActiveTags(catalog) {
    if (!state.activeTags.size) return;
    // While the own page is partially mounted, the visible tag set changes as
    // the user scrolls.  Do not clear an active filter just because all rows
    // carrying that tag are temporarily unmounted.
    if (state.containerIsOwn && state.rows.length < cachedOwnedCount()) return;
    const valid = new Set(catalog.map((tag) => tag.key));
    for (const key of Array.from(state.activeTags)) {
      if (!valid.has(key)) state.activeTags.delete(key);
    }
  }

  function favoritesSet() {
    return new Set(TBL.getFavoriteIds());
  }

  /*
   * The viewer cache contains the viewer's own lists, not the lists of another
   * user's public /<user>/lists page.  Only use its total when the mounted rows
   * actually match cached names; otherwise the toolbar would show e.g. "40"
   * next to a page with five public lists.
   */
  function cachedOwnedEntries() {
    const cache = TBL.getCacheForViewer?.();
    if (!cache?.lists) return [];
    const pageIds = Array.isArray(cache.pageListIds)
      ? new Set(cache.pageListIds.map((id) => String(id)))
      : null;
    if (pageIds && pageIds.size > 0) {
      // The lists page also contains followed lists owned by other users.
      // pageListIds is written only from ListsManagementPageTimeline, so use
      // it instead of filtering by owner (which dropped followed lists).
      return Object.entries(cache.lists)
        .filter(([id]) => pageIds.has(String(id)))
        .map(([, item]) => item)
        .filter(Boolean);
    }
    // Backwards compatibility for caches written before pageListIds existed.
    // The page query replaces this cache on the next load.
    const viewerId = TBL.getViewerId?.();
    return Object.values(cache.lists).filter((item) => {
      if (!item) return false;
      if (!viewerId || !item.ownerId) return true;
      return String(item.ownerId) === String(viewerId);
    });
  }

  function cachedOwnedCount() {
    if (!state.containerIsOwn) return 0;
    return cachedOwnedEntries().length;
  }

  function cachedTotalForPage() {
    if (!state.rows.length || !state.containerIsOwn) return 0;
    const entries = cachedOwnedEntries();
    const cachedNames = new Set(
      entries.map((item) => normalizePageName(item?.name)).filter(Boolean)
    );
    if (!cachedNames.size) return 0;
    let recognized = 0;
    for (const row of state.rows) {
      if (cachedNames.has(normalizePageName(row.name))) recognized += 1;
    }
    if (recognized < Math.max(1, Math.ceil(state.rows.length * 0.8))) {
      return 0;
    }
    return entries.length;
  }

  function rowMatchesSearch(row) {
    const query = normalizeSearchText(state.searchQuery);
    if (!query) return true;
    const text = normalizeSearchText(row.name);
    return query.split(' ').every((term) => text.includes(term));
  }

  function rowMatches(row, favorites) {
    if (state.favoritesOnly && (!row.id || !favorites.has(row.id))) {
      return false;
    }
    if (state.activeTags.size > 0) {
      // A virtual row whose ID has not been resolved yet must stay visible.
      // Otherwise scrolling past it looks like the list was deleted until the
      // next metadata scan fills in its ID.
      if (row.id) {
        const keys = new Set(
          TBL.getListTags(row.id).map((tag) => TBL.tagKey(tag))
        );
        let matched = false;
        for (const key of state.activeTags) {
          if (keys.has(key)) {
            matched = true;
            break;
          }
        }
        if (!matched) return false;
      }
    }
    return rowMatchesSearch(row);
  }

  function compareIds(a, b, direction) {
    if (a.id && b.id) {
      try {
        const diff = BigInt(a.id) - BigInt(b.id);
        if (diff !== 0n) return direction * (diff > 0n ? 1 : -1);
      } catch {
        /* fall through */
      }
      const numA = Number(a.id);
      const numB = Number(b.id);
      if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
        return direction * (numA > numB ? 1 : -1);
      }
    }
    if (a.createdAt !== b.createdAt) {
      return direction * (a.createdAt > b.createdAt ? 1 : -1);
    }
    return direction * (a.nativeIndex - b.nativeIndex);
  }

  function sortRows(rows, favorites) {
    const favoriteIndex = new Map(
      Array.from(favorites).map((id, index) => [String(id), index])
    );
    const mode = TBL.state.settings.sortMode;
    return [...rows].sort((a, b) => {
      const aFav = favoriteIndex.has(a.id);
      const bFav = favoriteIndex.has(b.id);
      if (TBL.state.settings.favoritesFirst) {
        if (aFav && bFav) {
          return favoriteIndex.get(a.id) - favoriteIndex.get(b.id);
        }
        if (aFav !== bFav) return aFav ? -1 : 1;
      }
      if (mode === 'name') {
        const diff = getCollator().compare(a.name, b.name);
        if (diff !== 0) return diff;
        return compareIds(a, b, 1);
      }
      return mode === 'newest'
        ? compareIds(a, b, -1)
        : compareIds(a, b, 1);
    });
  }

  /*
   * Recommended-list visibility is handled in MAIN world by removing X's
   * discover module from ListsManagementPageTimeline before React renders.
   * The remaining rows keep their native geometry, so no section offset is
   * needed on any lists page.  Recalculating offsets here caused the hidden
   * section's height to change while scrolling (the 35 -> 16 jump).
   */
  function applySectionOffset(container, ownScope) {
    if (!container) return { ownEl: null, delta: 0 };
    const ownEl = ownScope ? topLevelChild(container, ownScope) : null;
    if (ownEl) setTopOffset(ownEl, 0);
    return { ownEl, delta: 0 };
  }

  function isLikelyVirtualized() {
    if (!state.container || !state.rows.length) return false;

    // The viewer cache knows how many owned lists should exist.  If only a
    // subset is mounted, X is virtualizing the section even when the whole
    // container also contains recommendations or other sections.
    const cachedTotal = Math.max(cachedTotalForPage(), cachedOwnedCount());
    if (cachedTotal > 0 && state.rows.length >= cachedTotal) return false;
    if (cachedTotal > state.rows.length + 1) return true;

    // With no usable cache total, measure the mounted rows themselves.  A
    // virtualized section spreads native tops over a much taller span than the
    // sum of the mounted row heights; a fully mounted list stays contiguous.
    // Hidden rows (search/tag filter) have height 0, so use an estimate for
    // them or every active filter would look like a virtualized window.
    const rows = state.rows.map((row) => ({
      top: nativeTop(row.el, state.container),
      height: rowHeight(row.el) || 72,
    }));
    if (!rows.length) return false;
    const minTop = Math.min(...rows.map((row) => row.top));
    const maxBottom = Math.max(...rows.map((row) => row.top + row.height));
    const span = maxBottom - minTop;
    const mounted = rows.reduce((sum, row) => sum + row.height, 0);
    return span > mounted + 200;
  }

  function applyOrder(force = false) {
    if (!state.active || !state.container) return;
    // X is changing the mounted window during scrolling.  Re-sorting while
    // that happens makes rows visibly jump; wait until scrolling settles.
    // Once the page viewport has been expanded all rows stay mounted, so the
    // sorted layout remains stable even while the user scrolls.
    if (
      state.isScrolling &&
      !state.pageExpanded &&
      !state.containerIsOwn &&
      !force
    ) {
      return;
    }

    const catalog = getPageTagCatalog();
    pruneActiveTags(catalog);
    const favorites = favoritesSet();
    const visible = state.rows.filter((row) => rowMatches(row, favorites));
    const visibleSet = new Set(visible);
    const sorted = sortRows(visible, favorites);

    for (const row of state.rows) {
      const show = visibleSet.has(row);
      row.el.classList.toggle('tbl-page-hidden', !show);
      if (show) row.el.dataset.tblPageRow = '1';
    }

    if (state.containerIsOwn) {
      // MAIN world sorts X's timeline store, so native rows keep their own
      // transforms and virtualization.  The recommendation section offset is
      // applied once and then locked; recalculating it while scrolling was
      // what caused the visible jump near the middle of long lists.
      // During scrolling, skip applySectionOffset entirely to prevent any
      // layout-affecting DOM changes that could shift the scroll position.
      state.reorderBlocked = false;
      if (!state.isScrolling) {
        applySectionOffset(
          state.container,
          findOwnScopeStart(state.container)
        );
      }
      for (const row of state.rows) setTopOffset(row.el, 0);
      // If the page was briefly treated as a public list page before the
      // viewer handle became available, the public reorder path may have left
      // offsets/filter classes on the recommendation rows.  Clear them even
      // while scrolling: waiting for the scroll to settle leaves the section
      // physically moved out of view until X remounts it.
      restoreRecommendationRows();
      return;
    }

    // Reordering a virtualized window can move a row outside the range X is
    // willing to keep mounted, which makes that list disappear while
    // scrolling.  If the page viewport could not be expanded, keep the native
    // row order and apply only filters/search.  This is deliberately a safe
    // fallback; the normal path expands the viewport so sorting stays active.
    const cachedTotal = Math.max(cachedTotalForPage(), cachedOwnedCount());
    const allCachedRowsMounted =
      cachedTotal === 0 || state.rows.length >= cachedTotal;
    const canReorder =
      !isLikelyVirtualized() ||
      (state.pageExpanded &&
        state.pageFitsContent &&
        allCachedRowsMounted);
    state.reorderBlocked = !canReorder;

    if (!canReorder) {
      for (const row of state.rows) setTopOffset(row.el, 0);
      for (const child of state.otherRows) setTopOffset(child, 0);
      return;
    }

    const section = applySectionOffset(
      state.container,
      findOwnScopeStart(state.container)
    );

    const nativeTops = new Map();
    const heights = new Map();
    for (const row of state.rows) {
      nativeTops.set(row.el, nativeTop(row.el, state.container));
      heights.set(row.el, rowHeight(row.el) || 72);
    }

    const baseTop = state.rows.length
      ? Math.min(...Array.from(nativeTops.values()))
      : 0;
    let top = baseTop;
    for (const row of sorted) {
      const offset = top + section.delta - (nativeTops.get(row.el) || 0);
      setTopOffset(row.el, offset);
      top += heights.get(row.el) || 72;
    }
  }

  function ensureActions(row) {
    const el = row.el;
    let actions = el.querySelector('.tbl-row-actions.is-page-actions');
    if (!actions) {
      actions = document.createElement('span');
      actions.className = 'tbl-row-actions is-page-actions';
      actions.addEventListener('mousedown', (event) => event.stopPropagation());
      actions.addEventListener('pointerdown', (event) =>
        event.stopPropagation()
      );
      actions.addEventListener('pointerup', (event) => event.stopPropagation());
      actions.addEventListener('click', (event) => event.stopPropagation());

      const tagButton = createButton(
        'tbl-icon-btn tbl-tag-btn',
        '#',
        TBL.t('リストのタグを編集', 'Edit list tags')
      );
      tagButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = el.dataset.tblListId;
        if (!id) return;
        TBL.openTagEditor(el, id, {
          anchor: tagButton,
          onChange: () => scan(),
        });
      });

      const star = createButton(
        'tbl-icon-btn tbl-star',
        '☆',
        TBL.t('お気に入りに追加', 'Add to favorites')
      );
      star.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const id = el.dataset.tblListId;
        if (!id) return;
        const favorite = favoritesSet().has(id);
        setFavorite(id, !favorite);
        applyOrder(true);
        renderToolbar();
      });

      actions.append(tagButton, star);
      el.appendChild(actions);
    }

    // Put the page buttons immediately to the left of X's native pin button
    // instead of overlaying it.  If the row has no pin button, fall back to the
    // old top-right overlay placement.
    const pin = el.querySelector('button[data-testid="list-icon-button"]');
    const pinWrapper = pin?.parentElement;
    const rowFlex = pinWrapper?.parentElement;
    if (pin && pinWrapper && rowFlex) {
      actions.classList.add('is-page-inline');
      actions.classList.remove('is-overlay');
      if (
        actions.parentElement !== rowFlex ||
        actions.nextElementSibling !== pinWrapper
      ) {
        rowFlex.insertBefore(actions, pinWrapper);
      }
    } else {
      actions.classList.remove('is-page-inline');
      actions.classList.add('is-overlay');
      if (actions.parentElement !== el) el.appendChild(actions);
    }

    actions.style.display = row.id ? '' : 'none';
    const tagButton = actions.querySelector('.tbl-tag-btn');
    const star = actions.querySelector('.tbl-star');
    const favorite = Boolean(row.id) && favoritesSet().has(row.id);
    const tags = TBL.getListTags(row.id);
    if (tagButton) {
      tagButton.classList.toggle('has-tags', tags.length > 0);
      tagButton.title = tags.length
        ? TBL.t(`タグ: ${tags.join(', ')}`, `Tags: ${tags.join(', ')}`)
        : TBL.t('リストのタグを編集', 'Edit list tags');
    }
    if (star) {
      star.classList.toggle('is-favorite', favorite);
      const starLabel = favorite ? '★' : '☆';
      if (star.textContent !== starLabel) star.textContent = starLabel;
      const starTitle = favorite
        ? TBL.t('お気に入りから外す', 'Remove from favorites')
        : TBL.t('お気に入りに追加', 'Add to favorites');
      star.title = starTitle;
    }
  }

  function setFavorite(listId, favorite) {
    const viewerId = TBL.getViewerId();
    if (!viewerId || !listId) return;
    const settings = TBL.state.settings;
    if (!settings.favorites || typeof settings.favorites !== 'object') {
      settings.favorites = {};
    }
    const current = Array.isArray(settings.favorites[viewerId])
      ? [...settings.favorites[viewerId]]
      : [];
    const id = String(listId);
    const index = current.indexOf(id);
    if (favorite && index < 0) current.push(id);
    if (!favorite && index >= 0) current.splice(index, 1);
    settings.favorites[viewerId] = current;
    TBL.saveSettings();
  }

  function renderChips(toolbar, catalog) {
    const chips = toolbar.querySelector('.tbl-filter-chips');
    if (!chips) return;
    const active = state.activeTags;
    const signature = `${catalog
      .map((tag) => `${tag.key}:${tag.label}:${tag.count}`)
      .join('|')}::${Array.from(active).sort().join(',')}`;
    const clear = toolbar.querySelector('.tbl-filter-clear:not(.tbl-bulk-rename)');
    if (clear) clear.style.display = active.size > 0 ? '' : 'none';
    if (chips.dataset.tblSignature === signature) return;
    chips.dataset.tblSignature = signature;
    chips.textContent = '';

    if (catalog.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tbl-filter-empty';
      empty.textContent = TBL.t(
        'タグは各リストの「#」から追加できます',
        'Add tags with # on each list'
      );
      chips.appendChild(empty);
      return;
    }

    for (const tag of catalog) {
      const chip = createButton(
        'tbl-filter-chip',
        `#${tag.label}`,
        TBL.t(`${tag.count}件のリスト`, `${tag.count} lists`)
      );
      chip.dataset.tag = tag.key;
      const isActive = active.has(tag.key);
      chip.classList.toggle('is-active', isActive);
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (active.has(tag.key)) active.delete(tag.key);
        else active.add(tag.key);
        applyOrder(true);
        renderToolbar();
      });
      chips.appendChild(chip);
    }
  }

  function renderToolbar() {
    const toolbar = state.toolbar;
    if (!toolbar || !toolbar.isConnected) return;
    const searchInput = toolbar.querySelector('.tbl-search-input');
    const searchClear = toolbar.querySelector('.tbl-search-clear');
    if (searchInput && searchInput.value !== state.searchQuery) {
      searchInput.value = state.searchQuery;
    }
    if (searchClear) {
      searchClear.style.display = state.searchQuery ? '' : 'none';
    }

    const sortMode = TBL.state.settings.sortMode;
    toolbar.querySelectorAll('.tbl-sort-btn[data-sort]').forEach((button) => {
      const active = button.dataset.sort === sortMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    const favoritesOnly = toolbar.querySelector('.tbl-fav-filter');
    if (favoritesOnly) {
      favoritesOnly.classList.toggle('is-active', state.favoritesOnly);
      favoritesOnly.setAttribute(
        'aria-pressed',
        state.favoritesOnly ? 'true' : 'false'
      );
    }

    const sortGroup = toolbar.querySelector('.tbl-sort-group');
    if (sortGroup) {
      const muted = Boolean(
        state.favoritesOnly && TBL.state.settings.favoritesFirst
      );
      sortGroup.classList.toggle('is-muted', muted);
      sortGroup.setAttribute('aria-disabled', muted ? 'true' : 'false');
      sortGroup.title = muted
        ? TBL.t(
            'お気に入りフィルター中は登録順です',
            'Favorites order while favorites-only is on'
          )
        : '';
      sortGroup.querySelectorAll('button').forEach((button) => {
        button.disabled = muted;
      });
    }

    const catalog = getPageTagCatalog();
    pruneActiveTags(catalog);
    renderChips(toolbar, catalog);

    const status = toolbar.querySelector('.tbl-status');
    if (status) {
      // X's virtualizer only mounts the visible rows.  On the viewer's own
      // page, use the cache populated by ListsManagementPageTimeline for the
      // total instead of reporting the currently mounted row count.
      const total = Math.max(
        state.rows.length,
        cachedTotalForPage(),
        cachedOwnedCount()
      );
      const favorites = favoritesSet();
      let statusRows = state.rows;
      if (state.containerIsOwn) {
        const byId = new Map();
        for (const item of cachedOwnedEntries()) {
          const id = item?.id == null ? '' : String(item.id);
          if (!id) continue;
          byId.set(id, {
            id,
            name: item?.name || '',
            ownerId: item?.ownerId == null ? null : String(item.ownerId),
            createdAt: Number(item?.createdAt) || 0,
          });
        }
        // Include mounted rows as well (foreign/followed lists are not in the
        // viewer-owned cache).
        for (const row of state.rows) {
          if (row.id && !byId.has(row.id)) byId.set(row.id, row);
        }
        if (byId.size) statusRows = Array.from(byId.values());
      }
      const visible = statusRows.filter((row) =>
        rowMatches(row, favorites)
      ).length;
      const searchActive = Boolean(normalizeSearchText(state.searchQuery));
      let text = '';
      if (total === 0) {
        text = TBL.t('リストを読み込み中…', 'Loading lists…');
      } else if (state.favoritesOnly) {
        text = TBL.t(`★${visible}/${total}`, `★${visible} / ${total}`);
      } else if (state.activeTags.size > 0 || searchActive) {
        // Keep the ↻ button with the count; a long label wraps it alone.
        text = TBL.t(`表示${visible}/${total}`, `${visible} / ${total}`);
      } else {
        text = TBL.t(`全${total}件`, `${total} lists`);
      }
      if (favorites.size > 0 && !state.favoritesOnly) {
        text += TBL.t(` / ★${favorites.size}`, ` / ★${favorites.size}`);
      }
      if (state.reorderBlocked) text += ' ※';
      if (status.textContent !== text) status.textContent = text;
      status.title = state.reorderBlocked
        ? TBL.t(
            `Xの仮想スクロール画面のため、この画面では並び替えを一時停止しています（展開:${state.pageExpanded ? 'あり' : 'なし'} / 行:${state.rows.length} / 所有:${cachedOwnedCount()}）`,
            `Sorting is paused because X is virtualizing this page (expanded:${state.pageExpanded ? 'yes' : 'no'} / rows:${state.rows.length} / owned:${cachedOwnedCount()})`
          )
        : '';
    }
  }

  function clearMovedRecommendationRow(el) {
    if (!el) return;
    const hasHidden =
      el.classList.contains('tbl-page-hidden') ||
      el.classList.contains('tbl-page-discover-hidden') ||
      el.classList.contains('tbl-discover-header-row');
    const moved = el.style.top && el.style.top !== '0px';
    if (!hasHidden && !moved) return;
    // The public reorder path can leave these values behind when the page was
    // briefly classified as a public list page.  Recommendation rows must
    // always use X's native geometry when the option is off.
    el.classList.remove(
      'tbl-page-hidden',
      'tbl-page-discover-hidden',
      'tbl-discover-header-row'
    );
    setTopOffset(el, 0);
  }

  function restoreRecommendationRows() {
    if (TBL.state.settings.hideDiscoverLists) return;
    for (const child of state.otherRows) clearMovedRecommendationRow(child);
    // During the transition from the public layout, the recommendation rows
    // can still be in state.rows until the next full scan.  Own rows always
    // have a native pin button, so clearing only the unpinned rows is safe.
    for (const row of state.rows) {
      if (row.el.querySelector('button[data-testid="list-icon-button"]')) {
        continue;
      }
      clearMovedRecommendationRow(row.el);
    }
    clearDiscoverSection(state.container);
  }

  function clearDiscoverSection(container) {
    if (TBL.state.settings.hideDiscoverLists) return;
    if (!container) return;
    const discoverHeader = findDiscoverHeader(container);
    if (!discoverHeader) return;
    const start = topLevelChild(container, discoverHeader);
    if (!start) return;
    const ownScope = findOwnScopeStart(container);
    const ownEl = ownScope ? topLevelChild(container, ownScope) : null;
    let el = start;
    while (el) {
      clearMovedRecommendationRow(el);
      if (el === ownEl) break;
      // The owner's own rows have a native pin button.  Stop before touching
      // them even if the own heading is temporarily unmounted.
      if (el.querySelector('button[data-testid="list-icon-button"]')) break;
      el = el.nextElementSibling;
    }
  }

  function resetPageRow(el) {
    el.querySelectorAll('.tbl-row-actions.is-page-actions').forEach(
      (actions) => actions.remove()
    );
    el.classList.remove('tbl-page-hidden');
    el.removeAttribute('data-tbl-page-row');
    el.removeAttribute('data-tbl-list-id');
    el.removeAttribute('data-tbl-name');
    el.removeAttribute('data-tbl-owner-id');
    el.removeAttribute('data-tbl-created-at');
    el.removeAttribute('data-tbl-index');
    restoreStyle(el);
  }

  function scan() {
    if (!state.active) return;
    if (!state.container || !state.container.isConnected) {
      state.container = null;
      mount();
      return;
    }

    // On the own page, X's virtualizer remounts rows during scrolling.
    // Defer the full scan while actively scrolling between rows, BUT allow it
    // immediately when near the top (e.g. after pressing Home or scrolling to top)
    // so the collapsed recommendation section does not flash before being hidden.
    const nearTop = state.lastScrollTop <= 120;
    if (state.containerIsOwn && state.isScrolling && !nearTop) {
      // Do not re-sort while scrolling, but still undo any stale geometry
      // left on the recommendation section by an earlier misclassification.
      restoreRecommendationRows();
      return;
    }

    // X can render the recommended lists before the user's own list section.
    // If a section with more rows appears later, move the toolbar and rows to
    // that section instead of staying stuck on the early skeleton.  Once this
    // container is identified as "Your lists", do not switch away just
    // because its heading scrolled out of the virtualized window and the
    // recommendations block has more mounted rows.
    const byUrl = isOwnPageByUrl();
    const currentIsOwn = isOwnContainer(state.container);
    if (byUrl !== null) state.containerIsOwn = byUrl;
    else if (currentIsOwn) state.containerIsOwn = true;

    const best = findContainer(findPrimary());
    const bestIsOwn = isOwnContainer(best);
    const shouldSwitch =
      best &&
      best !== state.container &&
      (!state.container?.isConnected ||
        (!state.containerIsOwn && bestIsOwn));

    if (shouldSwitch) {
      for (const row of state.rows) resetPageRow(row.el);
      for (const child of state.otherRows) restoreStyle(child);
      restoreDiscover();
      resetSectionOffsetState();
      collapsePageViewport();
      state.discoverExpanded = false;
      state.rows = [];
      state.otherRows = [];
      const wasOwn = state.containerIsOwn || bestIsOwn;
      state.container = null;
      state.containerIsOwn = wasOwn;
      mount();
      return;
    }

    const container = state.container;
    const children = Array.from(container.children).filter(
      (child) => child.nodeType === 1
    );
    let listEls = children.filter(
      (child) =>
        child.matches?.('[data-testid="cellInnerDiv"]') &&
        child.querySelector('[data-testid="listCell"]')
    );

    // On the owner's page X renders a "Lists you might like" section above
    // the actual "Your lists" section.  Keep those recommendations untouched
    // and apply sorting/filtering only to the user's own rows.
    const ownScope = findOwnScopeStart(container);
    // On the own page, apply discover section changes when settled or near the top.
    if (!state.containerIsOwn || !state.isScrolling || nearTop) {
      applyDiscoverSection(container, ownScope);
    }
    if (ownScope) {
      const scoped = listEls.filter(
        (el) =>
          ownScope.compareDocumentPosition(el) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
      if (scoped.length > 0) listEls = scoped;
    } else if (state.containerIsOwn) {
      // While the ownScope header is temporarily unmounted during scrolling,
      // distinguish own list rows from recommendation rows by the native pin
      // button.  If no own row has mounted yet, do not fall back to treating
      // the recommendation rows as own: sorting them here is what moved the
      // section out of view until X remounted it.
      const scoped = listEls.filter((el) =>
        el.querySelector('button[data-testid="list-icon-button"]')
      );
      if (scoped.length > 0 || findDiscoverHeader(container)) {
        listEls = scoped;
      }
    }

    const rowEls = new Set(listEls);
    // A list that moved out of the owner's section (or was recycled by X's
    // virtualizer) must lose the page-specific actions/styles.
    for (const row of state.rows) {
      if (!rowEls.has(row.el)) resetPageRow(row.el);
    }

    const rows = [];
    for (let index = 0; index < listEls.length; index += 1) {
      const el = listEls[index];
      const cell = el.querySelector('[data-testid="listCell"]');
      const meta = resolveRowMeta(el, cell);
      const id = meta.id ? String(meta.id) : '';
      el.dataset.tblPageRow = '1';
      el.dataset.tblName = meta.name || '';
      el.dataset.tblIndex = String(index);
      if (id) el.dataset.tblListId = id;
      else el.removeAttribute('data-tbl-list-id');
      if (meta.ownerId) el.dataset.tblOwnerId = String(meta.ownerId);
      else el.removeAttribute('data-tbl-owner-id');
      if (meta.createdAt) {
        el.dataset.tblCreatedAt = String(meta.createdAt);
      } else {
        el.removeAttribute('data-tbl-created-at');
      }
      rowEls.add(el);
      rows.push({
        el,
        id,
        name: meta.name || '',
        ownerId: meta.ownerId == null ? null : String(meta.ownerId),
        createdAt: Number(meta.createdAt) || 0,
        nativeIndex: index,
      });
    }

    state.rows = rows;
    state.otherRows = children.filter((child) => !rowEls.has(child));
    ensurePageViewport(container);
    ensureForeignDefaultTags(rows);
    for (const row of rows) ensureActions(row);
    applyOrder();
    renderToolbar();
    if (rows.some((row) => !row.id)) requestPageMeta();
  }

  function requestPageMeta() {
    const now = Date.now();
    if (now - state.metaRequestAt < 500) return;
    state.metaRequestAt = now;
    try {
      TBL.requestListPageMeta?.();
    } catch {
      /* ignore */
    }
  }

  function applyPageMeta(items) {
    if (!Array.isArray(items) || !items.length) return false;
    const byName = new Map();
    for (const item of items) {
      if (!item?.id || !item.name) continue;
      const key = normalizePageName(item.name);
      const list = byName.get(key) || [];
      list.push(item);
      byName.set(key, list);
    }
    let changed = false;
    for (const row of state.rows) {
      if (row.id) continue;
      let candidates = byName.get(normalizePageName(row.name)) || [];
      if (candidates.length > 1) {
        const count = getRowMemberCount(row.el);
        if (count != null) {
          const exact = candidates.filter(
            (item) => Number(item.memberCount) === count
          );
          if (exact.length === 1) candidates = exact;
        }
      }
      if (candidates.length !== 1) continue;
      const item = candidates[0];
      row.id = String(item.id);
      row.createdAt = Number(item.createdAt) || row.createdAt;
      row.ownerId =
        item.ownerId == null ? row.ownerId : String(item.ownerId);
      row.el.dataset.tblListId = row.id;
      row.el.dataset.tblName = row.name;
      if (row.ownerId) row.el.dataset.tblOwnerId = String(row.ownerId);
      else row.el.removeAttribute('data-tbl-owner-id');
      if (row.createdAt) {
        row.el.dataset.tblCreatedAt = String(row.createdAt);
      }
      changed = true;
    }
    return changed;
  }

  function scheduleScan() {
    if (state.scanTimer) return;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      if (!state.active) return;
      if (!state.container?.isConnected) mount();
      else scan();
    }, 80);
  }

  function observe(primary) {
    if (!primary) return;
    if (state.observer && state.observerTarget === primary) return;
    if (state.observer) state.observer.disconnect();
    const observer = new MutationObserver(() => scheduleScan());
    observer.observe(primary, { childList: true, subtree: true });
    state.observer = observer;
    state.observerTarget = primary;
  }

  function mount() {
    if (!state.active) return;
    const primary = findPrimary();
    if (!primary) return;
    const container = findContainer(primary);
    state.primary = primary;
    if (!container) return;
    state.container = container;
    const byUrl = isOwnPageByUrl();
    if (byUrl !== null) {
      state.containerIsOwn = byUrl;
    } else if (!state.containerIsOwn) {
      state.containerIsOwn = isOwnContainer(container);
    }
    if (!state.toolbar) state.toolbar = createToolbar();
    if (!state.toolbar.isConnected) {
      insertToolbar(primary, container);
    } else {
      insertToolbar(primary, container);
    }
    observe(primary);
    scan();
  }

  function teardown() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
      state.observerTarget = null;
    }
    if (state.scanTimer) {
      clearTimeout(state.scanTimer);
      state.scanTimer = null;
    }
    if (state.scrollTimer) {
      clearTimeout(state.scrollTimer);
      state.scrollTimer = null;
    }
    state.isScrolling = false;
    if (state.toolbar) {
      state.toolbar.remove();
      state.toolbar = null;
    }
    for (const row of state.rows) {
      row.el
        .querySelectorAll('.tbl-row-actions.is-page-actions')
        .forEach((actions) => actions.remove());
      row.el.classList.remove('tbl-page-hidden');
      row.el.removeAttribute('data-tbl-page-row');
      row.el.removeAttribute('data-tbl-list-id');
      row.el.removeAttribute('data-tbl-name');
      row.el.removeAttribute('data-tbl-owner-id');
      row.el.removeAttribute('data-tbl-created-at');
      row.el.removeAttribute('data-tbl-index');
      restoreStyle(row.el);
    }
    for (const child of state.otherRows) restoreStyle(child);
    restoreDiscover();
    resetSectionOffsetState();
    collapsePageViewport();
    state.rows = [];
    state.otherRows = [];
    state.primary = null;
    state.container = null;
    state.containerIsOwn = false;
    state.active = false;
    state.starting = false;
    state.favoritesOnly = false;
    state.discoverExpanded = false;
    state.activeTags.clear();
    state.searchQuery = '';
    state.chipsSignature = '';
    state.reorderBlocked = false;
  }

  function ensure() {
    const info = pathInfo();
    if (!shouldRun(info)) {
      teardown();
      return;
    }
    // Do not carry the "own list" mode across an SPA navigation to another
    // user's public lists page.  The own header can be unmounted while
    // scrolling, so the URL handle is the reliable boundary between pages.
    if (state.pageHandle !== info.handle) {
      state.pageHandle = info.handle;
      state.containerIsOwn = false;
    }
    if (state.active) {
      if (!state.container?.isConnected) mount();
      else scheduleScan();
      return;
    }
    if (state.starting) return;
    state.starting = true;
    Promise.resolve()
      .then(() => TBL.loadStorage())
      .finally(() => {
        state.starting = false;
        const current = pathInfo();
        if (!shouldRun(current) || state.active) return;
        state.active = true;
        state.favoritesOnly = false;
        state.activeTags.clear();
        mount();
      });
  }

  // ページ内の SPA 遷移とネイティブ再描画を拾う。
  setInterval(() => {
    if (!pathInfo()) {
      if (state.active) teardown();
      return;
    }
    ensure();
    if (state.active) {
      if (!state.container?.isConnected) mount();
      else scan();
    }
  }, 700);

  window.addEventListener('popstate', ensure);
  window.addEventListener('hashchange', ensure);
  window.addEventListener(
    'scroll',
    (event) => {
      if (!state.active) return;
      state.isScrolling = true;
      const target = event.target;
      state.lastScrollTop =
        target === document || target === window
          ? window.scrollY || document.documentElement.scrollTop || 0
          : target?.scrollTop || 0;
      if (state.scrollTimer) clearTimeout(state.scrollTimer);
      state.scrollTimer = setTimeout(() => {
        state.scrollTimer = null;
        state.isScrolling = false;
        if (state.active) scheduleScan();
      }, 160);
    },
    { capture: true, passive: true }
  );
  window.addEventListener('tbl-tags-changed', () => {
    if (!state.active) return;
    scan();
  });
  window.addEventListener('tbl-viewer-changed', () => {
    if (!state.active) return;
    scan();
  });
  window.addEventListener('tbl-cache-changed', () => {
    if (!state.active) return;
    scheduleScan();
  });
  window.addEventListener('tbl-list-page-meta', (event) => {
    if (!state.active) return;
    if (applyPageMeta(event.detail?.items)) {
      ensureForeignDefaultTags(state.rows);
      for (const row of state.rows) ensureActions(row);
      applyOrder();
      renderToolbar();
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !state.active) return;
      if (!changes.settings && !changes.listCache && !changes.meta) return;
      scheduleScan();
    });
  } catch {
    /* ignore */
  }

  // document_start でも、DOM が揃うまで待ってから開始する。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensure, { once: true });
  } else {
    ensure();
  }
})();
