/*
 * Twitter Better List - ISOLATED world
 *
 * 1) 「Add/remove from Lists」ダイアログのリストを
 *    - 名前順 / 新しい順 / 古い順 に並び替える
 *    - お気に入りを最上部に固定し、▲▼で順番を変更できる
 *    - すべてのリストを裏で自動読み込みする
 * 2) 左サイドバーの「More」を展開する（sidebar.js と連携）
 *
 * ネイティブの Add / Remove ボタンはそのまま残すため、
 * 追加・削除の保存処理は X 本体が行います。
 */
(() => {
  'use strict';

  if (window.__TBL_CONTENT__) return;
  window.__TBL_CONTENT__ = true;

  const MAIN_SOURCE = 'tbl-main';
  const ISOLATED_SOURCE = 'tbl-isolated';

  /*
   * An incomplete cache is filled once in the background.  If that attempt
   * fails or is truncated, opening the dialog for another target must not
   * immediately retry the same full fetch.  A manual ↻ always overrides this.
   */
  const AUTO_REFRESH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

  const DEFAULT_SETTINGS = {
    version: 1,
    sortMode: 'newest', // name | newest | oldest
    favorites: {}, // { [viewerId]: [listId, ...] }
    tags: {}, // { [viewerId]: { [listId]: [tag, ...] } }
    defaultTagSeeded: {}, // { [viewerId]: { [listId]: "v2:<ownerId>" } }
    favoritesFirst: true,
    autoLoadAll: true,
    sidebarEnabled: true,
    hideDiscoverLists: false,
    dialogSearch: false,
    language: 'auto',
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    cache: {}, // { [viewerId]: { updatedAt, complete, lists: { [id]: list } } }
    meta: {},
    viewerId: null,
    pendingByUser: {},
    modal: {
      active: false,
      dialog: null,
      container: null,
      toolbar: null,
      rows: [],
      units: [],
      absolute: false,
      scrollEl: null,
      userId: null,
      itemQueue: [],
      autoLoading: false,
      autoLoadDone: false,
      autoLoadToken: 0,
      cacheCompleteAtOpen: false,
      stall: 0,
      pages: 0,
      nextCursor: null,
      ended: false,
      receivedQuery: false,
      refreshing: false,
      refreshSilent: false,
      refreshRequestId: null,
      autoRefreshRequested: false,
      expectedCount: 0,
      loadedIds: new Set(),
      favoritesOnly: false,
      activeTags: new Set(),
      searchQuery: '',
      expanded: false,
      preparing: false,
      prepareToken: 0,
      expansionFailed: false,
      scrollParent: null,
      headerEl: null,
      styledEls: new Set(),
      originalContainerStyle: null,
    },
    scanTimer: null,
    cacheSaveTimer: null,
    observer: null,
    lastPath: location.pathname,
    storageLoaded: false,
    storageLoading: null,
  };

  const TBL = (window.__TBL__ = window.__TBL__ || {});

  let tagPopover = null;
  let tagPopoverCleanup = null;

  /* ------------------------------------------------------------------ */
  /* i18n / utils                                                       */
  /* ------------------------------------------------------------------ */

  function isJa() {
    if (state.settings.language === 'ja') return true;
    if (state.settings.language === 'en') return false;
    return (document.documentElement.getAttribute('lang') || '').toLowerCase().startsWith('ja');
  }

  function t(ja, en) {
    return isJa() ? ja : en;
  }

  function log(...args) {
    if (state.settings.debug) console.debug('[TBL]', ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toast(message, tone = 'info') {
    try {
      const el = document.createElement('div');
      el.className = `tbl-toast tbl-toast-${tone}`;
      el.textContent = message;
      document.body.appendChild(el);
      requestAnimationFrame(() => el.classList.add('tbl-toast-show'));
      setTimeout(() => {
        el.classList.remove('tbl-toast-show');
        setTimeout(() => el.remove(), 250);
      }, 2400);
    } catch {
      /* ignore */
    }
  }

  function getCookie(name) {
    try {
      const prefix = `${name}=`;
      for (const raw of document.cookie.split(';')) {
        const part = raw.trim();
        if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function readViewerIdFromCookie() {
    try {
      const twid = getCookie('twid');
      if (!twid) return null;
      const decoded = decodeURIComponent(twid);
      const match = decoded.match(/(?:^|&)u=(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /*
   * twid が読めない環境でも、左サイドバーのアカウントメニューの React
   * props にはログイン中の User (currentUser) が入っている。これは
   * 「追加対象」ではなく閲覧者そのものなので、キャッシュキーの復旧に使える。
   */
  function readViewerIdFromAccountSwitcher() {
    try {
      const el = document.querySelector(
        '[data-testid="SideNav_AccountSwitcher_Button"]'
      );
      if (!el) return null;
      let fiber = getFiber(el);
      let depth = 0;
      while (fiber && depth < 40) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        if (props && typeof props === 'object') {
          const candidates = [
            props.currentUser,
            props.loggedInUser,
            props.activeUser,
            props.delegateUser,
            props.user,
          ];
          for (const user of candidates) {
            const id =
              user && typeof user === 'object'
                ? user.rest_id ?? user.id_str ?? user.id
                : null;
            if (id != null && /^\d+$/.test(String(id))) return String(id);
          }
        }
        fiber = fiber.return;
        depth += 1;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getDomViewerId(force = false) {
    const now = Date.now();
    if (
      !force &&
      state.domViewerAt &&
      now - state.domViewerAt < 1000
    ) {
      return state.domViewerId || null;
    }
    const id = readViewerIdFromAccountSwitcher();
    state.domViewerId = id;
    state.domViewerAt = now;
    return id;
  }

  function syncViewerFromDom() {
    const id = getDomViewerId(true);
    if (!id) return null;
    const current =
      readViewerIdFromCookie() || state.viewerId || state.meta.viewerId;
    if (current !== id) {
      setViewerId(id, { trusted: true });
    }
    return id;
  }

  function normalizeSettings(value) {
    const next = { ...DEFAULT_SETTINGS, ...(value || {}) };
    if (!next.favorites || typeof next.favorites !== 'object') next.favorites = {};
    if (!next.tags || typeof next.tags !== 'object') next.tags = {};
    if (!next.defaultTagSeeded || typeof next.defaultTagSeeded !== 'object') {
      next.defaultTagSeeded = {};
    }
    if (!['name', 'newest', 'oldest'].includes(next.sortMode)) next.sortMode = 'newest';
    if (typeof next.favoritesFirst !== 'boolean') next.favoritesFirst = true;
    if (typeof next.autoLoadAll !== 'boolean') next.autoLoadAll = true;
    if (typeof next.sidebarEnabled !== 'boolean') next.sidebarEnabled = true;
    if (typeof next.hideDiscoverLists !== 'boolean') {
      next.hideDiscoverLists = false;
    }
    if (typeof next.dialogSearch !== 'boolean') next.dialogSearch = false;
    return next;
  }

  /*
   * twid は「いまログインしている人」を表す。一覧キャッシュは、追加対象の
   * ユーザーではなく、この閲覧者をキーに共有する。対象ユーザーごとに
   * キャッシュを作ると、別の相手を開いた 2 回目に必ず作り直しになる。
   */
  function getViewerId() {
    return (
      readViewerIdFromCookie() ||
      getDomViewerId() ||
      state.viewerId ||
      state.meta.viewerId ||
      null
    );
  }

  function setViewerId(value, { trusted = false } = {}) {
    const candidate = value == null ? null : String(value);
    const previous = state.viewerId;
    const next =
      readViewerIdFromCookie() ||
      // ListOwnerships の viewerId は「閲覧者」そのもの。既存の
      // meta / state が対象ユーザーIDで汚染されていても、こちらを優先する。
      (trusted && candidate) ||
      state.viewerId ||
      state.meta.viewerId ||
      candidate;
    if (!next) return null;
    if (state.viewerId !== next) state.viewerId = next;
    if (state.meta.viewerId !== next) {
      state.meta.viewerId = next;
      saveMeta();
    }
    if (previous !== next) {
      try {
        window.dispatchEvent(
          new CustomEvent('tbl-viewer-changed', { detail: { viewerId: next } })
        );
      } catch {
        /* ignore */
      }
    }
    if (trusted && previous !== next) {
      // 汚染されたキーで保存済みのキャッシュ・お気に入り・タグを
      // 正しい閲覧者キーへ寄せる。
      migrateViewerCaches();
    }
    return next;
  }

  function getFavoriteIds(viewerId = getViewerId()) {
    if (!viewerId) return [];
    const list = state.settings.favorites[viewerId];
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' || typeof id === 'number').map(String) : [];
  }

  function normalizeTag(value) {
    return String(value || '')
      .trim()
      .replace(/^#+/, '')
      .trim()
      .slice(0, 24);
  }

  function tagKey(value) {
    return normalizeTag(value).toLocaleLowerCase();
  }

  function parseTags(value) {
    const tags = [];
    const seen = new Set();
    for (const part of String(value || '').split(/[\s,、]+/)) {
      const tag = normalizeTag(part);
      if (!tag) continue;
      const key = tagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 12) break;
    }
    return tags;
  }

  function getViewerTags(viewerId = getViewerId()) {
    if (!viewerId) return {};
    const tags = state.settings.tags?.[viewerId];
    return tags && typeof tags === 'object' ? tags : {};
  }

  function getListTags(listId, viewerId = getViewerId()) {
    if (!listId) return [];
    const raw = getViewerTags(viewerId)[String(listId)];
    if (!Array.isArray(raw)) return [];
    const tags = [];
    const seen = new Set();
    for (const value of raw) {
      const tag = normalizeTag(value);
      const key = tagKey(tag);
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }

  function setListTags(listId, tags) {
    const viewerId = getViewerId();
    if (!viewerId || !listId) return;
    if (!state.settings.tags || typeof state.settings.tags !== 'object') {
      state.settings.tags = {};
    }
    const forViewer = {
      ...(state.settings.tags[viewerId] &&
      typeof state.settings.tags[viewerId] === 'object'
        ? state.settings.tags[viewerId]
        : {}),
    };
    if (tags.length > 0) forViewer[String(listId)] = tags;
    else delete forViewer[String(listId)];
    state.settings.tags[viewerId] = forViewer;
    saveSettings();
  }

  function getTagCatalog() {
    const viewerId = getViewerId();
    if (!viewerId) return [];
    const knownIds = new Set();
    const cache = getCacheForViewer(viewerId);
    for (const [id, item] of Object.entries(cache?.lists || {})) {
      // The modal only shows/manages the viewer's own lists.  Do not surface
      // tags that belong only to followed lists from the lists page.
      if (
        !item?.ownerId ||
        String(item.ownerId) === String(viewerId)
      ) {
        knownIds.add(String(id));
      }
    }
    for (const row of state.modal.rows) {
      if (row.dataset.tblListId) knownIds.add(String(row.dataset.tblListId));
    }
    const catalog = new Map();
    for (const [listId, rawTags] of Object.entries(getViewerTags(viewerId))) {
      if (!knownIds.has(String(listId)) || !Array.isArray(rawTags)) continue;
      for (const value of rawTags) {
        const tag = normalizeTag(value);
        const key = tagKey(tag);
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

  function pruneActiveTags() {
    if (!state.modal.activeTags?.size) return;
    const hasCacheLists = getCachedListCount() > 0;
    const hasRows = state.modal.rows.some((row) => row.dataset.tblListId);
    if (!hasCacheLists && !hasRows) return;
    const valid = new Set(getTagCatalog().map((tag) => tag.key));
    for (const key of Array.from(state.modal.activeTags)) {
      if (!valid.has(key)) state.modal.activeTags.delete(key);
    }
  }

  function normalizeSearchText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getRowSearchText(row) {
    if (!row) return '';
    const name = row.dataset.tblName || getRowName(row);
    const id = row.dataset.tblListId ? String(row.dataset.tblListId) : '';
    const tags = id ? getListTags(id) : [];
    return normalizeSearchText([name, ...tags].join(' '));
  }

  function rowMatchesSearch(row) {
    // The dialog search is optional; the own-lists page uses its own search
    // state in lists-page.js.  Keeping this setting check here means turning
    // the option off immediately stops filtering, even before the toolbar
    // refreshes.
    if (!state.settings.dialogSearch) return true;
    const query = normalizeSearchText(state.modal.searchQuery);
    if (!query) return true;
    const text = getRowSearchText(row);
    return query.split(' ').every((term) => text.includes(term));
  }

  function rowMatchesFilters(row) {
    if (!row) return false;
    const id = row.dataset.tblListId ? String(row.dataset.tblListId) : '';
    if (state.modal.favoritesOnly && (!id || !favoriteIdsSet().has(id))) {
      return false;
    }
    if (state.modal.activeTags?.size > 0) {
      // A freshly mounted virtual row may not have an ID yet.  Hiding it
      // makes the list disappear until X's metadata arrives; keep it visible
      // instead and let the later scan apply the tag once the ID is known.
      if (id) {
        const keys = new Set(getListTags(id).map((tag) => tagKey(tag)));
        let matched = false;
        for (const key of state.modal.activeTags) {
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

  function getCacheForViewer(viewerId = getViewerId()) {
    if (!viewerId) return null;
    return state.cache[viewerId] || null;
  }

  function getCachedList(listId, viewerId = getViewerId()) {
    const cache = getCacheForViewer(viewerId);
    return cache?.lists?.[String(listId)] || null;
  }

  /*
   * The modal is for the viewer's own/manageable lists.  The lists page cache
   * can also contain lists owned by other users (followed lists), so do not
   * let those inflate the modal's expected row count.  Entries from older
   * caches have no ownerId and are counted for backwards compatibility.
   */
  function getCachedListCount(viewerId = getViewerId()) {
    const cache = getCacheForViewer(viewerId);
    if (!cache?.lists) return 0;
    const viewer = viewerId == null ? '' : String(viewerId);
    let count = 0;
    for (const item of Object.values(cache.lists)) {
      if (!item) continue;
      if (
        !item.ownerId ||
        !viewer ||
        String(item.ownerId) === viewer
      ) {
        count += 1;
      }
    }
    return count;
  }

  /*
   * The native list dialog is virtualized.  Its scroll container is sized to
   * the viewport, so only a small window of the loaded timeline is mounted.
   * We temporarily make that container tall enough to mount every row, then
   * let the parent (the modal body) be the actual scroll area.  This keeps the
   * native rows, checkboxes and Save button as the source of truth while
   * removing the virtualizer's constant reflow / reorder races.
   */
  function rememberInlineStyle(el, property) {
    if (!el) return;
    const backup = el.__tblInlineBackup || (el.__tblInlineBackup = {});
    if (!(property in backup)) {
      backup[property] = {
        value: el.style.getPropertyValue(property),
        priority: el.style.getPropertyPriority(property),
      };
    }
    state.modal.styledEls.add(el);
  }

  function setInline(el, property, value, priority = 'important') {
    if (!el) return;
    rememberInlineStyle(el, property);
    el.style.setProperty(property, value, priority);
  }

  function restoreInline(el) {
    if (!el) return;
    const backup = el.__tblInlineBackup;
    if (!backup) return;
    for (const [property, entry] of Object.entries(backup)) {
      if (entry.value) el.style.setProperty(property, entry.value, entry.priority);
      else el.style.removeProperty(property);
    }
    delete el.__tblInlineBackup;
  }

  function updateExpectedCount() {
    if (!state.modal.active) return 0;
    state.modal.expectedCount = Math.max(
      state.modal.expectedCount || 0,
      getCachedListCount(),
      state.modal.loadedIds.size,
      state.modal.rows.length
    );
    return state.modal.expectedCount;
  }

  function hasLoadedAllCached() {
    const cache = getCacheForViewer();
    const count = getCachedListCount();
    return Boolean(
      cache?.complete &&
      count > 0 &&
      state.modal.loadedIds.size >= count
    );
  }

  /* ------------------------------------------------------------------ */
  /* storage                                                            */
  /* ------------------------------------------------------------------ */

  function loadStorage() {
    // boot と lists-page の両方から呼ばれる。2 回目以降に storage を読み直すと、
    // まだ書き込みが終わっていない移行前のキャッシュ / meta で state を
    // 上書きしてしまうため、初回だけ読み込む。
    if (state.storageLoaded) return Promise.resolve();
    if (state.storageLoading) return state.storageLoading;
    state.storageLoading = new Promise((resolve) => {
      try {
        chrome.storage.local.get(
          ['settings', 'listCache', 'meta'],
          (result) => {
            state.settings = normalizeSettings(result.settings);
            state.cache = result.listCache && typeof result.listCache === 'object' ? result.listCache : {};
            state.meta = result.meta && typeof result.meta === 'object' ? result.meta : {};
            if (result.settings?.debug) state.settings.debug = true;
            state.storageLoaded = true;
            resolve();
          }
        );
      } catch {
        state.storageLoaded = true;
        resolve();
      }
    }).finally(() => {
      state.storageLoading = null;
    });
    return state.storageLoading;
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ settings: state.settings });
    } catch {
      /* ignore */
    }
  }

  function queueCacheSave() {
    if (state.cacheSaveTimer) clearTimeout(state.cacheSaveTimer);
    state.cacheSaveTimer = setTimeout(() => {
      state.cacheSaveTimer = null;
      try {
        chrome.storage.local.set({
          listCache: state.cache,
          meta: { ...state.meta, viewerId: getViewerId(), updatedAt: Date.now() },
        });
      } catch {
        /* ignore */
      }
    }, 350);
  }

  function notifyCacheChanged() {
    try {
      window.dispatchEvent(
        new CustomEvent('tbl-cache-changed', {
          detail: { viewerId: getViewerId() },
        })
      );
    } catch {
      /* ignore */
    }
  }

  function saveMeta() {
    try {
      chrome.storage.local.set({
        meta: {
          ...state.meta,
          viewerId: getViewerId(),
          updatedAt: Date.now(),
        },
      });
    } catch {
      /* ignore */
    }
  }

  function mergeCacheData(target, source) {
    if (!source || typeof source !== 'object') return;
    target.lists = target.lists || {};
    for (const [id, item] of Object.entries(source.lists || {})) {
      if (!item) continue;
      const previous = target.lists[id];
      if (!previous) {
        target.lists[id] = {
          ...item,
          members: { ...(item.members || {}) },
        };
        continue;
      }
      target.lists[id] = {
        ...item,
        ...previous,
        ownerId:
          previous.ownerId != null
            ? String(previous.ownerId)
            : item.ownerId != null
              ? String(item.ownerId)
              : null,
        members: {
          ...(item.members || {}),
          ...(previous.members || {}),
        },
        lastSeenAt: Math.max(
          Number(previous.lastSeenAt) || 0,
          Number(item.lastSeenAt) || 0
        ),
      };
    }
    target.complete = Boolean(target.complete || source.complete);
    target.updatedAt = Math.max(
      Number(target.updatedAt) || 0,
      Number(source.updatedAt) || 0
    );
    target.lastAutoRefreshAt = Math.max(
      Number(target.lastAutoRefreshAt) || 0,
      Number(source.lastAutoRefreshAt) || 0
    );
  }

  /*
   * 以前の不具合で listCache が「追加対象ユーザー」ごとに保存されていた
   * 場合の救済。members に対象 ID が入っているキャッシュは対象別と判断し、
   * 閲覧者の 1 つのキャッシュへ統合する。
   */
  function cacheLooksTargetKeyed(key, cache) {
    const lists = cache?.lists;
    if (!lists || typeof lists !== 'object') return false;
    return Object.values(lists).some(
      (item) =>
        item?.members &&
        Object.prototype.hasOwnProperty.call(item.members, key)
    );
  }

  /*
   * 新しいキャッシュには viewerId を持たせる。旧バージョンのキャッシュは
   * これが無いため、members の対象IDを見て「対象ユーザー別キャッシュ」を
   * 判別する。別アカウントの正しい閲覧者キャッシュを誤って統合しないための
   * ガードでもある。
   */
  function cacheViewerId(cache) {
    return cache?.viewerId == null ? null : String(cache.viewerId);
  }

  /*
   * viewerId が cookie / アカウントメニュー由来で確かなときだけキャッシュに
   * 自己申告の viewerId を書き込む。起動直後などで対象ユーザーIDを閲覧者と
   * 誤認している可能性があるときは、旧キャッシュと同じ「未マーク」のまま
   * にして、あとから正しい閲覧者へ統合できるようにする。
   */
  function isAuthoritativeViewer(viewerId) {
    const id = viewerId == null ? null : String(viewerId);
    if (!id) return false;
    const cookieViewer = readViewerIdFromCookie();
    if (cookieViewer) return cookieViewer === id;
    const domViewer = getDomViewerId();
    return Boolean(domViewer && domViewer === id);
  }

  function markCacheViewer(cache, viewerId) {
    if (!cache || !viewerId) return;
    if (isAuthoritativeViewer(viewerId)) cache.viewerId = String(viewerId);
  }

  function mergeUniqueStrings(base, extra) {
    const out = Array.isArray(base) ? [...base] : [];
    for (const value of Array.isArray(extra) ? extra : []) {
      const text = String(value);
      if (text && !out.includes(text)) out.push(text);
    }
    return out;
  }

  function migrateViewerSettings(oldKeys, viewerId) {
    if (!oldKeys.length || !viewerId) return;
    const favorites =
      state.settings.favorites && typeof state.settings.favorites === 'object'
        ? state.settings.favorites
        : {};
    const tags =
      state.settings.tags && typeof state.settings.tags === 'object'
        ? state.settings.tags
        : {};
    let viewerFavorites = Array.isArray(favorites[viewerId])
      ? [...favorites[viewerId]]
      : [];
    const viewerTags =
      tags[viewerId] && typeof tags[viewerId] === 'object'
        ? { ...tags[viewerId] }
        : {};
    let changed = false;

    for (const key of oldKeys) {
      const oldFavorites = Array.isArray(favorites[key])
        ? favorites[key]
        : [];
      const mergedFavorites = mergeUniqueStrings(viewerFavorites, oldFavorites);
      if (mergedFavorites.length !== viewerFavorites.length) {
        viewerFavorites = mergedFavorites;
        changed = true;
      }
      const oldTags = tags[key];
      if (oldTags && typeof oldTags === 'object') {
        for (const [listId, values] of Object.entries(oldTags)) {
          const current = Array.isArray(viewerTags[listId])
            ? viewerTags[listId]
            : [];
          const mergedTags = mergeUniqueStrings(current, values);
          if (mergedTags.length !== current.length) {
            viewerTags[listId] = mergedTags;
            changed = true;
          }
        }
      }
      if (key in favorites) {
        delete favorites[key];
        changed = true;
      }
      if (key in tags) {
        delete tags[key];
        changed = true;
      }
    }

    if (viewerFavorites.length) favorites[viewerId] = viewerFavorites;
    if (Object.keys(viewerTags).length) tags[viewerId] = viewerTags;
    if (changed) saveSettings();
  }

  function migrateViewerCaches() {
    const viewerId = getViewerId();
    if (!viewerId || !state.cache || typeof state.cache !== 'object') return;
    const keys = Object.keys(state.cache);
    if (!keys.length) return;

    const existing = state.cache[viewerId];
    const canonical =
      existing && typeof existing === 'object'
        ? existing
        : { updatedAt: 0, complete: false, lists: {} };
    const migrated = [];
    const staleMetaViewer =
      state.meta?.viewerId == null ? null : String(state.meta.viewerId);

    for (const key of keys) {
      if (key === viewerId) continue;
      const cache = state.cache[key];
      if (!cache || typeof cache !== 'object') continue;

      const marker = cacheViewerId(cache);
      if (marker) {
        // 新しいキャッシュは viewerId を自己申告する。別アカウントの
        // キャッシュを現在の閲覧者へ混ぜない。
        if (marker === viewerId) {
          mergeCacheData(canonical, cache);
          migrated.push(key);
        }
        continue;
      }

      // 旧キャッシュの救済。1 件だけ / members に対象IDがある /
      // meta に残っている対象ID、のいずれかなら旧・対象ユーザー別とみなす。
      if (
        keys.length === 1 ||
        cacheLooksTargetKeyed(key, cache) ||
        (staleMetaViewer && key === staleMetaViewer)
      ) {
        mergeCacheData(canonical, cache);
        migrated.push(key);
      }
    }

    const authoritative = isAuthoritativeViewer(viewerId);

    if (!migrated.length) {
      if (
        existing &&
        typeof existing === 'object' &&
        authoritative &&
        existing.viewerId !== viewerId
      ) {
        existing.viewerId = viewerId;
        queueCacheSave();
      }
      return;
    }

    for (const key of migrated) delete state.cache[key];
    if (authoritative) canonical.viewerId = viewerId;
    state.cache[viewerId] = canonical;
    migrateViewerSettings(migrated, viewerId);
    if (state.meta.viewerId !== viewerId) {
      state.meta.viewerId = viewerId;
      saveMeta();
    }
    queueCacheSave();
    notifyCacheChanged();
  }

  function normalizeCacheEntry(previous, item, targetUserId, now) {
    const id = String(item.id);
    const members = { ...(previous.members || {}) };
    if (targetUserId && typeof item.isMember === 'boolean') {
      members[String(targetUserId)] = item.isMember;
    }
    return {
      ...previous,
      id,
      name: item.name || previous.name || '',
      ownerId:
        item.ownerId != null
          ? String(item.ownerId)
          : previous.ownerId != null
            ? String(previous.ownerId)
            : null,
      accessibility: item.accessibility ?? previous.accessibility ?? null,
      mode: item.mode ?? previous.mode ?? null,
      memberCount:
        typeof item.memberCount === 'number'
          ? item.memberCount
          : previous.memberCount ?? null,
      createdAt:
        typeof item.createdAt === 'number'
          ? item.createdAt
          : previous.createdAt ?? null,
      bannerUrl: item.bannerUrl || previous.bannerUrl || null,
      members,
      lastSeenAt: now,
    };
  }

  function mergeLists(viewerId, items, targetUserId = null) {
    if (!viewerId || !Array.isArray(items) || items.length === 0) return;
    const now = Date.now();
    const cache = state.cache[viewerId] || {
      updatedAt: now,
      complete: false,
      lists: {},
    };
    markCacheViewer(cache, viewerId);
    cache.lists = cache.lists || {};
    for (const item of items) {
      if (!item || !item.id) continue;
      const id = String(item.id);
      cache.lists[id] = normalizeCacheEntry(
        cache.lists[id] || {},
        item,
        targetUserId,
        now
      );
    }
    cache.updatedAt = now;
    state.cache[viewerId] = cache;
    queueCacheSave();
    notifyCacheChanged();
  }

  /*
   * A completed background refresh is allowed to be authoritative: it also
   * removes lists which were deleted and applies renames in one atomic write.
   */
  function replaceLists(
    viewerId,
    items,
    targetUserId = null,
    { preserveForeign = false } = {}
  ) {
    if (!viewerId || !Array.isArray(items)) return;
    const now = Date.now();
    const previous = state.cache[viewerId] || { lists: {} };
    const lists = {};
    const incomingIds = new Set();
    for (const item of items) {
      if (!item || !item.id) continue;
      const id = String(item.id);
      incomingIds.add(id);
      lists[id] = normalizeCacheEntry(
        previous.lists?.[id] || {},
        item,
        targetUserId,
        now
      );
    }

    /*
     * A full ListOwnerships refresh only describes the viewer's own lists.
     * The lists page cache also stores followed lists owned by other users;
     * do not delete their metadata just because the modal refresh did not
     * return them.  A ListsManagementPageTimeline response is authoritative
     * for the page and replaces everything.
     */
    if (preserveForeign) {
      for (const [id, item] of Object.entries(previous.lists || {})) {
        if (!item || incomingIds.has(id)) continue;
        if (
          item.ownerId != null &&
          String(item.ownerId) !== String(viewerId)
        ) {
          lists[id] = { ...item, members: { ...(item.members || {}) } };
        }
      }
    }

    const next = {
      ...previous,
      complete: true,
      updatedAt: now,
      lists,
    };
    markCacheViewer(next, viewerId);
    state.cache[viewerId] = next;
    queueCacheSave();
    notifyCacheChanged();
  }

  function markCacheComplete(viewerId = getViewerId()) {
    if (!viewerId) return;
    const cache = state.cache[viewerId];
    if (!cache) return;
    markCacheViewer(cache, viewerId);
    cache.complete = true;
    cache.updatedAt = Date.now();
    queueCacheSave();
    notifyCacheChanged();
  }

  function markAutoRefreshAttempt(viewerId = getViewerId()) {
    if (!viewerId) return;
    const cache = state.cache[viewerId] || {
      updatedAt: 0,
      complete: false,
      lists: {},
    };
    cache.lastAutoRefreshAt = Date.now();
    markCacheViewer(cache, viewerId);
    state.cache[viewerId] = cache;
    queueCacheSave();
  }

  /* ------------------------------------------------------------------ */
  /* bridge                                                             */
  /* ------------------------------------------------------------------ */

  function sendToMain(type, payload) {
    try {
      window.postMessage(
        { __tbl: true, source: ISOLATED_SOURCE, type, payload },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  function handleMainMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__tbl !== true || data.source !== MAIN_SOURCE) return;
    const payload = data.payload || {};

    try {
      switch (data.type) {
        case 'state': {
          if (payload.viewerId) {
            setViewerId(payload.viewerId, {
              trusted: Boolean(payload.viewerTrusted),
            });
          }
          break;
        }

        case 'list-page-meta': {
          /*
           * This response describes every list cell on the page, including
           * \"Lists you might like\".  Do not merge it into the viewer's cache:
           * the lists-page module knows which section is actually the user's
           * own and resolves only those rows.
           */
          try {
            window.dispatchEvent(
              new CustomEvent('tbl-list-page-meta', { detail: payload })
            );
          } catch {
            /* ignore */
          }
          break;
        }

        case 'list-query': {
          handleListQuery(payload);
          break;
        }

        case 'lists-progress': {
          if (state.modal.active) {
            state.modal.pages = payload.pages || state.modal.pages;
            updateToolbar();
          }
          break;
        }

        case 'lists-result': {
          if (payload.viewerId) {
            const payloadViewer = String(payload.viewerId);
            const payloadTarget =
              payload.userId == null ? null : String(payload.userId);
            setViewerId(payloadViewer, {
              trusted: !payloadTarget || payloadViewer !== payloadTarget,
            });
          }
          const silent =
            state.modal.refreshSilent ||
            payload.silent ||
            (state.modal.refreshRequestId &&
              payload.requestId &&
              payload.requestId !== state.modal.refreshRequestId);
          if (Array.isArray(payload.items) && payload.items.length) {
            /*
             * Full-cache refreshes are target-independent.  They are requested
             * with the viewer as the target, so do not write a fake
             * "viewer is a member" flag keyed by the viewer ID.
             */
            const cacheViewerId = getViewerId();
            const memberTargetId =
              payload.userId != null &&
              String(payload.userId) !== String(cacheViewerId)
                ? String(payload.userId)
                : null;
            if (payload.ok && payload.truncated === false) {
              replaceLists(cacheViewerId, payload.items, memberTargetId, {
                preserveForeign: true,
              });
            } else {
              mergeLists(cacheViewerId, payload.items, memberTargetId);
            }
          }
          if (payload.ok && payload.truncated !== true) {
            markCacheComplete(getViewerId());
          }
          state.modal.refreshing = false;
          state.modal.refreshSilent = false;
          state.modal.refreshRequestId = null;
          if (state.modal.active) {
            updateToolbar();
            if (!silent) {
              toast(
                payload.ok
                  ? t(
                      `キャッシュを更新しました（${payload.items?.length || 0}件）`,
                      `Cache updated (${payload.items?.length || 0} lists)`
                    )
                  : t(
                      `キャッシュ更新に失敗しました: ${payload.error || '不明なエラー'}`,
                      `Cache refresh failed: ${payload.error || 'unknown error'}`
                    ),
                payload.ok ? 'success' : 'error'
              );
            }
          }
          if (state.modal.active) scanModalSoon();
          break;
        }

        case 'list-mutation': {
          handleMutation(payload);
          break;
        }

        case 'bridge-error': {
          log('bridge error', payload);
          break;
        }

        default:
          break;
      }
    } catch (error) {
      log('message handling error', error);
    }
  }

  function handleListQuery(payload) {
    // DOM のアカウントメニューから閲覧者を先に確定できる場合は、
    // 対象ユーザーIDで汚染された state / meta をここで正す。
    syncViewerFromDom();
    // payload.viewerId は新しいクエリでは対象ユーザーを指すことがある。
    // ListOwnerships の viewerId だけは閲覧者として信頼し、汚染された
    // meta / state を上書きする。それ以外は twid / 既知の閲覧者を優先。
    if (payload.viewerId) {
      const payloadViewer = String(payload.viewerId);
      const payloadTarget =
        payload.userId == null ? null : String(payload.userId);
      setViewerId(payload.viewerId, {
        trusted:
          payload.source === 'ListOwnerships' ||
          payload.source === 'ListsManagementPageTimeline' ||
          Boolean(payloadTarget && payloadViewer !== payloadTarget),
      });
    }
    if (
      payload.userId &&
      (!state.modal.active || !state.modal.userId)
    ) {
      // 開いているダイアログの対象ユーザーを、別ユーザーの先読みで
      // 上書きしない。未確定のときだけ採用する。
      state.modal.userId = String(payload.userId);
    }

    const items = Array.isArray(payload.items) ? payload.items : [];
    const currentViewerId = getViewerId();
    const targetUserId =
      payload.userId != null &&
      String(payload.userId) !== String(currentViewerId)
        ? String(payload.userId)
        : null;
    // /<user>/lists の一覧レスポンスは、その時点の自分のリスト全体を
    // 一括で返す。削除済みリストもキャッシュから落とせるよう置き換える。
    if (
      payload.complete &&
      payload.source === 'ListsManagementPageTimeline' &&
      items.length > 0
    ) {
      replaceLists(getViewerId(), items, targetUserId);
    } else {
      mergeLists(getViewerId(), items, targetUserId);
    }

    const payloadUserId = payload.userId == null ? null : String(payload.userId);
    const sameModalUser =
      state.modal.active &&
      (!payloadUserId || !state.modal.userId || payloadUserId === state.modal.userId);

    if (sameModalUser) {
      state.modal.receivedQuery = true;
      for (const item of items) {
        if (item && item.id != null) state.modal.loadedIds.add(String(item.id));
      }
      updateExpectedCount();
      if (payload.ended) state.modal.ended = true;
      state.modal.nextCursor =
        payload.ended || payload.nextCursor == null
          ? null
          : String(payload.nextCursor);
      // まだ ID が割り当てられていない行のために、レスポンス順のキューを保持
      state.modal.itemQueue.push(...items);
      state.modal.pages += 1;
      /*
       * cursor は末尾でも返ることがあるため、空ページ / cursor なし /
       * TimelineTerminateTimeline で完了とみなす。先頭ページが要求件数より
       * 少ないだけでは完了にしない（部分キャッシュの原因になる）。
       */
      if (items.length === 0 || payload.ended || !payload.nextCursor) {
        state.modal.autoLoadDone = true;
      }
      if (items.length > 0 && state.modal.ended) {
        markCacheComplete();
      }
      scanModalNow();
    } else {
      // モーダルがまだ開いていない / 別ユーザーのレスポンスはユーザー別に保持
      const key = payloadUserId || 'unknown';
      const previous = state.pendingByUser[key];
      const mergedItems =
        previous && Array.isArray(previous.items)
          ? [...previous.items]
          : [];
      for (const item of items) {
        if (!mergedItems.some((existing) => String(existing.id) === String(item.id))) {
          mergedItems.push(item);
        }
      }
      state.pendingByUser[key] = {
        items: mergedItems,
        nextCursor:
          payload.ended || payload.nextCursor == null
            ? null
            : String(payload.nextCursor),
        ended: Boolean(previous?.ended || payload.ended),
        requestedCount:
          previous?.requestedCount ?? payload.requestedCount ?? null,
        userId: payload.userId == null ? null : String(payload.userId),
        updatedAt: Date.now(),
      };
      const now = Date.now();
      for (const [userId, entry] of Object.entries(state.pendingByUser)) {
        if (!entry || now - entry.updatedAt > 60_000) delete state.pendingByUser[userId];
      }
    }
  }

  function handleMutation(payload) {
    if (!payload || !payload.listId) return;
    const cache = getCacheForViewer(getViewerId());
    const list = cache?.lists?.[String(payload.listId)];
    if (list && payload.success) {
      const added = payload.operation === 'setListMembershipAddMutation';
      if (typeof list.memberCount === 'number') {
        // 楽観的に表示用の人数だけ更新（次回レスポンスで上書きされる）
        list.memberCount = Math.max(0, list.memberCount + (added ? 1 : -1));
      }
      if (state.modal.userId) {
        list.members = list.members || {};
        list.members[String(state.modal.userId)] = added;
      }
      queueCacheSave();
    }
    if (state.modal.active) {
      // ネイティブの aria-pressed が変わるのを待って再描画
      setTimeout(scanModalNow, 80);
    }
  }

  window.addEventListener('message', handleMainMessage);

  /* ------------------------------------------------------------------ */
  /* React fiber helpers                                                 */
  /* ------------------------------------------------------------------ */

  function getFiber(el) {
    try {
      const key = Object.keys(el).find(
        (k) =>
          k.startsWith('__reactFiber$') ||
          k.startsWith('__reactInternalInstance$')
      );
      return key ? el[key] : null;
    } catch {
      return null;
    }
  }

  function ownerIdFromListObject(list) {
    if (!list || typeof list !== 'object') return null;
    const raw =
      list.user ??
      list.owner ??
      list.user_results?.result ??
      list.owner_results?.result ??
      null;
    if (raw == null) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
      return /^\d+$/.test(String(raw)) ? String(raw) : null;
    }
    if (typeof raw === 'object') {
      const nested = raw.result && typeof raw.result === 'object' ? raw.result : null;
      const id =
        raw.rest_id ??
        raw.id_str ??
        raw.id ??
        nested?.rest_id ??
        nested?.id_str ??
        nested?.id ??
        null;
      return id == null ? null : String(id);
    }
    return null;
  }

  function metaFromListObject(list) {
    if (!list || typeof list !== 'object') return null;
    const id =
      list.id_str != null
        ? list.id_str
        : list.rest_id != null
          ? list.rest_id
          : list.id != null
            ? list.id
            : null;
    if (id == null) return null;
    const createdAt = Number(list.created_at);
    return {
      id: String(id),
      name: typeof list.name === 'string' ? list.name : '',
      ownerId: ownerIdFromListObject(list),
      memberCount:
        typeof list.member_count === 'number'
          ? list.member_count
          : typeof list.memberCount === 'number'
            ? list.memberCount
            : null,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
    };
  }

  function findListMetaInFiber(el) {
    let fiber = getFiber(el);
    let depth = 0;
    let fallback = null;
    while (fiber && depth < 40) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props && typeof props === 'object') {
        const listMeta = metaFromListObject(props.list);
        if (listMeta) {
          if (!fallback) fallback = listMeta;
          // Some intermediate components pass a reduced list object without
          // the owner.  Keep walking until the full object with ownerId is
          // found, but retain the reduced meta as a fallback.
          if (listMeta.ownerId) return listMeta;
        }

        if (props.listId != null) {
          const propsMeta = {
            id: String(props.listId),
            name: typeof props.name === 'string' ? props.name : '',
            ownerId:
              props.ownerId != null ? String(props.ownerId) : null,
            memberCount:
              typeof props.memberCount === 'number' ? props.memberCount : null,
            createdAt: null,
          };
          if (!fallback) fallback = propsMeta;
          if (propsMeta.ownerId) return propsMeta;
        }

        const nested =
          props.entry?.content?.itemContent?.list ||
          props.itemContent?.list ||
          props.item?.list ||
          props.value?.list ||
          props.data?.list ||
          null;
        const nestedMeta = metaFromListObject(nested);
        if (nestedMeta) {
          if (!fallback) fallback = nestedMeta;
          if (nestedMeta.ownerId) return nestedMeta;
        }
      }
      fiber = fiber.return;
      depth += 1;
    }
    return fallback;
  }

  function readListIdFromFiber(el) {
    const meta = findListMetaInFiber(el);
    return meta ? meta.id : null;
  }

  /* ------------------------------------------------------------------ */
  /* modal discovery                                                    */
  /* ------------------------------------------------------------------ */

  function isListModalRoute() {
    const path = location.pathname.replace(/\/+$/, '');
    if (path === '/i/lists/add_member') return true;
    // 旧 UI / 別経路のフォールバック
    return (
      location.pathname.includes('/lists/add_member') ||
      location.pathname.includes('/list/add_member')
    );
  }

  function findDialog() {
    const routeMatches = isListModalRoute();
    const allDialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    // 実際のダイアログは aria-modal="true" の内側
    const modalDialogs = allDialogs.filter(
      (dialog) => dialog.getAttribute('aria-modal') === 'true'
    );
    const pool = modalDialogs.length > 0 ? modalDialogs : allDialogs;
    if (pool.length > 0) {
      const withTitle = pool.find((dialog) =>
        /Add\/remove from Lists|リストに追加\/削除|Add or remove from Lists|リストから追加\/削除|リストを選択|Select lists to add/i.test(
          dialog.textContent || ''
        )
      );
      if (withTitle) return withTitle;
      if (!routeMatches) return null;
      const withRows = pool.find(
        (dialog) =>
          dialog.querySelector(
            '[data-testid="listCell"], [role="checkbox"][aria-checked], button[aria-pressed]'
          )
      );
      if (withRows) return withRows;
      // モーダル内にまだ行が描画されていない場合
      return pool[pool.length - 1] || null;
    }

    if (!routeMatches) return null;

    // role="dialog" が付かない実装へのフォールバック
    const buttons = Array.from(
      document.querySelectorAll(
        'button[aria-pressed], [data-testid="listCell"], [role="checkbox"][aria-checked]'
      )
    );
    if (buttons.length === 0) return null;
    let node = buttons[0].parentElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (
        style.position === 'fixed' ||
        style.position === 'absolute' ||
        node.getAttribute('role') === 'dialog'
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function getListButtons(dialog) {
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('button[aria-pressed]')).filter(
      (btn) => {
        if (btn.classList.contains('tbl-icon-btn')) return false;
        const text = (btn.textContent || '').trim();
        // ローディング中はテキストが空になることがあるため aria-pressed を優先
        if (!text) return true;
        return /^(Add|Remove|追加|削除|追加する|削除する|リストに追加|リストから削除)$/i.test(
          text
        );
      }
    );
  }

  // responsive-web のリスト選択ダイアログは
  // div[data-testid="listCell"][role="checkbox"][aria-checked] の行を持つ。
  function getCheckboxCells(dialog) {
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll(
        '[data-testid="listCell"][role="checkbox"], [role="checkbox"][aria-checked]'
      )
    ).filter((cell) => !cell.closest('.tbl-row-actions'));
  }

  function getRowElementForCell(cell) {
    return (
      cell.closest('[data-testid="cellInnerDiv"]') ||
      cell.parentElement ||
      cell
    );
  }

  function getRowForButton(btn) {
    let row = btn.parentElement;
    // 念のため、ボタンを含む flex 行まで遡る
    let depth = 0;
    while (row && depth < 4) {
      if (row.querySelector('img') || row.querySelector('[style*="background-image"]')) {
        return row;
      }
      row = row.parentElement;
      depth += 1;
    }
    return btn.parentElement;
  }

  function getRowName(row) {
    if (!row) return '';
    try {
      const fiberMeta = findListMetaInFiber(row);
      if (fiberMeta?.name) return fiberMeta.name.trim();

      // 新 UI: 行内で最初の意味のある [dir="ltr"] がリスト名
      const ltrTexts = Array.from(row.querySelectorAll('[dir="ltr"]'))
        .map((el) => (el.textContent || '').trim())
        .filter(Boolean);
      const looksLikeName = (text) =>
        Boolean(text) &&
        !/^@/.test(text) &&
        !/^[·•]?\s*[\d,]+\s*(members?|メンバー)$/i.test(text) &&
        !/^(Private|非公開|Public|公開)$/i.test(text) &&
        !/^\d{4}年/.test(text);
      const ltrName = ltrTexts.find(looksLikeName);
      if (ltrName) return ltrName;

      // 旧 UI: X の Text (weight=bold) は font-bold クラスを持つ
      const bold = row.querySelector('span.font-bold, [class*="font-bold"]');
      if (bold && bold.textContent?.trim()) {
        return bold.textContent.trim();
      }
      const textBlock = row.querySelector(
        'span.flex.min-w-0.flex-1.flex-col, span.flex.flex-col'
      );
      if (textBlock) {
        const first = textBlock.querySelector('span');
        if (first && first.textContent?.trim()) return first.textContent.trim();
      }
      const leaves = Array.from(row.querySelectorAll('span, div[dir="ltr"]'))
        .filter((el) => el.childElementCount === 0)
        .map((el) => el.textContent?.trim() || '')
        .filter(Boolean);
      return (
        leaves.find(
          (text) =>
            !/^(Private|非公開)$/i.test(text) &&
            !/^[·•]?\s*[\d,]+\s*(members?|メンバー)$/i.test(text) &&
            !/^@/.test(text)
        ) || leaves[0] || ''
      );
    } catch {
      return '';
    }
  }

  function getRowMemberCount(row) {
    try {
      const text = row.textContent || '';
      const match = text.match(/([\d,]+)\s*(members?|メンバー)/i);
      return match ? Number(match[1].replace(/,/g, '')) : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* modal scanning                                                     */
  /* ------------------------------------------------------------------ */

  /*
   * 開いた直後は 1 回目のスキャンを待たせない。従来の debounce は X の
   * 連続描画でタイマーがリセットされ続け、ツールバーが 0.5 秒以上遅れる
   * ことがあった。モーダル表示前は最速、表示後は 90ms のスロットルにする。
   */
  function scanModalSoon() {
    if (state.scanTimer) return;
    // 表示直後は公式ダイアログの描画に追従して素早く反応する。展開後は
    // 行の再配置だけなので、少し間隔を空けて負荷を抑える。
    const delay = state.modal.active ? (state.modal.expanded ? 120 : 45) : 0;
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanModalNow();
    }, delay);
  }

  function scanModalNow() {
    try {
      const dialog = findDialog();
      if (!dialog) {
        if (state.modal.active) cleanupModal();
        return;
      }

      if (!state.modal.active || state.modal.dialog !== dialog) {
        // ダイアログの差し替え時は、新ダイアログ向けに届いた
        // pending を消さない。完全に閉じたときだけ破棄する。
        if (state.modal.active) cleanupModal(false);
        beginModal(dialog);
      }

      const cells = getCheckboxCells(dialog);
      let rows = [];

      if (cells.length > 0) {
        const seen = new Set();
        for (const cell of cells) {
          const row = getRowElementForCell(cell);
          if (row && !seen.has(row)) {
            seen.add(row);
            rows.push(row);
          }
        }
      } else {
        const buttons = getListButtons(dialog);
        for (const btn of buttons) {
          const row = getRowForButton(btn);
          if (row && !rows.includes(row)) rows.push(row);
        }
      }

      if (rows.length === 0) {
        // 行やスクロール領域より先にダイアログの外枠だけが出ることがある。
        // その場合もツールバーを先に置き、あとから正式な親へ移動する。
        ensureToolbar(dialog, null);
        updateToolbar();
        return;
      }

      const container = rows[0].parentElement;
      if (!container) return;

      const absolute = rows.some(
        (row) => getComputedStyle(row).position === 'absolute'
      );

      if (state.modal.container !== container) {
        state.modal.container = container;
        if (state.modal.expanded && !state.modal.preparing) {
          prepareContainer(container, absolute);
        }
      }
      state.modal.absolute = absolute;

      state.modal.rows = rows;
      assignListIds(rows);
      updateExpectedCount();
      ensureToolbar(dialog, container);

      if (state.modal.expanded && !state.modal.preparing) {
        prepareContainer(container, absolute);
        rows.forEach((row, index) => enhanceRow(row, index));
        applyOrder(rows);
      }

      updateToolbar();

      if (
        !state.modal.expanded &&
        !state.modal.preparing &&
        !state.modal.autoLoading &&
        !state.modal.expansionFailed
      ) {
        startPreparation(dialog, container).catch((error) =>
          log('prepare failed', error)
        );
      }

      if (state.modal.rows.length > 0) {
        maybeAutoRefresh();
      }
    } catch (error) {
      log('scan error', error);
    }
  }

  function beginModal(dialog) {
    syncViewerFromDom();
    state.modal.active = true;
    state.modal.dialog = dialog;
    state.modal.container = null;
    state.modal.toolbar = null;
    state.modal.rows = [];
    state.modal.units = [];
    state.modal.absolute = false;
    state.modal.scrollEl = null;
    state.modal.itemQueue = [];
    state.modal.autoLoading = false;
    state.modal.autoLoadDone = false;
    state.modal.autoLoadToken += 1;
    state.modal.prepareToken += 1;
    state.modal.stall = 0;
    state.modal.pages = 0;
    state.modal.nextCursor = null;
    state.modal.ended = false;
    state.modal.receivedQuery = false;
    state.modal.refreshing = false;
    state.modal.refreshSilent = false;
    state.modal.refreshRequestId = null;
    state.modal.autoRefreshRequested = false;
    state.modal.expectedCount = getCachedListCount();
    // A complete cache means repeat opens must not trigger native pagination
    // just to rebuild information we already have.  The tall viewport below
    // still lets React mount every row it has already received.
    state.modal.cacheCompleteAtOpen = Boolean(getCacheForViewer()?.complete);
    if (!state.storageLoaded) {
      // The modal can be opened before the first storage read finishes.  Do
      // not treat that moment as "no complete cache" and start pagination.
      const token = state.modal.prepareToken;
      loadStorage().then(() => {
        if (
          !state.modal.active ||
          state.modal.dialog !== dialog ||
          state.modal.prepareToken !== token ||
          state.modal.expanded
        ) {
          return;
        }
        state.modal.cacheCompleteAtOpen = Boolean(getCacheForViewer()?.complete);
        updateExpectedCount();
        scanModalNow();
      });
    }
    state.modal.loadedIds = new Set();
    state.modal.favoritesOnly = false;
    state.modal.activeTags = new Set();
    state.modal.searchQuery = '';
    state.modal.expanded = false;
    state.modal.preparing = false;
    state.modal.expansionFailed = false;
    state.modal.scrollParent = null;
    state.modal.headerEl = null;
    state.modal.styledEls = new Set();

    // ルートから userId を取得（URL が最も確実）。
    // 前回ダイアログの対象を引きずらないよう、いったんクリアする。
    state.modal.userId = null;
    try {
      const params = new URLSearchParams(location.search);
      state.modal.userId =
        params.get('user_id') ||
        params.get('userId') ||
        null;
    } catch {
      /* ignore */
    }

    // モーダル描画前に届いていたクエリ結果を引き継ぐ
    let pending = state.modal.userId
      ? state.pendingByUser[state.modal.userId]
      : null;
    if (!pending) {
      const entries = Object.entries(state.pendingByUser).filter(
        ([, entry]) =>
          entry &&
          Array.isArray(entry.items) &&
          (entry.items.length > 0 || entry.userId)
      );
      if (entries.length > 0) {
        entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        pending = entries[0][1];
      }
    }
    if (pending && Array.isArray(pending.items)) {
      state.modal.receivedQuery = true;
      state.modal.itemQueue = pending.items.slice();
      if (!state.modal.userId && pending.userId) {
        state.modal.userId = String(pending.userId);
      }
      for (const item of pending.items) {
        if (item && item.id != null) state.modal.loadedIds.add(String(item.id));
      }
      state.modal.ended = Boolean(pending.ended);
      state.modal.nextCursor =
        pending.ended || pending.nextCursor == null
          ? null
          : String(pending.nextCursor);
      state.modal.pages = pending.items.length > 0 ? 1 : 0;
      state.modal.autoLoadDone =
        pending.items.length === 0 || pending.ended || !pending.nextCursor;
      for (const [userId, entry] of Object.entries(state.pendingByUser)) {
        if (entry === pending) delete state.pendingByUser[userId];
      }
    }
    updateExpectedCount();

    log('modal opened', state.modal.userId);
  }

  function prepareContainer(container, absolute = false) {
    try {
      if (!container.dataset.tblOriginalStyle) {
        container.dataset.tblOriginalStyle = container.getAttribute('style') || '';
      }
      if (absolute) {
        // X のタイムラインは各行を position:absolute + translateY で配置する。
        // display を変えず、並び替えは applyOrder 側で transform を割り当てる。
        container.dataset.tblAbsolute = '1';
        if (getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
        }
        return;
      }
      container.dataset.tblFlex = '1';
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      // X の行は padding で高さを稼いでいるため gap は不要
      if (!container.style.rowGap) container.style.rowGap = '0px';
    } catch {
      /* ignore */
    }
  }

  function restoreContainer() {
    const container = state.modal.container;
    if (!container) return;
    try {
      const original = container.dataset.tblOriginalStyle;
      if (original != null) {
        if (original) container.setAttribute('style', original);
        else container.removeAttribute('style');
      }
      delete container.dataset.tblOriginalStyle;
      delete container.dataset.tblFlex;
      delete container.dataset.tblAbsolute;
    } catch {
      /* ignore */
    }
  }

  function cleanupModal(clearPending = true) {
    try {
      closeTagEditor();
      if (state.scanTimer) {
        clearTimeout(state.scanTimer);
        state.scanTimer = null;
      }
      state.modal.autoLoadToken += 1;
      state.modal.prepareToken += 1;
      if (state.modal.dialog) {
        state.modal.dialog.removeAttribute('data-tbl-preparing');
        state.modal.dialog.removeAttribute('data-tbl-expanded');
      }
      for (const el of state.modal.styledEls || []) restoreInline(el);
      if (state.modal.toolbar) state.modal.toolbar.remove();
      for (const row of state.modal.rows) {
        row.querySelectorAll(':scope > .tbl-row-actions').forEach((el) => el.remove());
        row.style.removeProperty('order');
        if (row.dataset.tblOriginalTransform != null) {
          if (row.dataset.tblOriginalTransform) {
            row.style.transform = row.dataset.tblOriginalTransform;
          } else {
            row.style.removeProperty('transform');
          }
        }
        delete row.dataset.tblOriginalTransform;
        delete row.dataset.tblRow;
        delete row.dataset.tblListId;
        delete row.dataset.tblName;
        delete row.dataset.tblCreatedAt;
        delete row.dataset.tblIndex;
        delete row.dataset.tblFiltered;
      }
      restoreContainer();
    } catch {
      /* ignore */
    } finally {
      state.modal.active = false;
      state.modal.dialog = null;
      state.modal.container = null;
      state.modal.toolbar = null;
      state.modal.rows = [];
      state.modal.units = [];
      state.modal.absolute = false;
      state.modal.scrollEl = null;
      state.modal.itemQueue = [];
      state.modal.autoLoading = false;
      state.modal.autoLoadDone = false;
      state.modal.pages = 0;
      state.modal.nextCursor = null;
      state.modal.stall = 0;
      state.modal.refreshing = false;
      state.modal.refreshSilent = false;
      state.modal.refreshRequestId = null;
      state.modal.autoRefreshRequested = false;
      state.modal.expectedCount = 0;
      state.modal.loadedIds = new Set();
      state.modal.favoritesOnly = false;
      state.modal.activeTags = new Set();
      state.modal.searchQuery = '';
      state.modal.expanded = false;
      state.modal.preparing = false;
      state.modal.expansionFailed = false;
      state.modal.scrollParent = null;
      state.modal.headerEl = null;
      state.modal.styledEls = new Set();
      state.modal.userId = null;
      if (clearPending) state.pendingByUser = {};
    }
  }

  /* ------------------------------------------------------------------ */
  /* list id assignment                                                 */
  /* ------------------------------------------------------------------ */

  function getMetaForRow(row) {
    if (!row) return null;
    const cell =
      row.matches?.('[data-testid="listCell"]')
        ? row
        : row.querySelector?.('[data-testid="listCell"]');
    return findListMetaInFiber(row) || (cell ? findListMetaInFiber(cell) : null);
  }

  function assignListIds(rows) {
    const queue = state.modal.itemQueue;
    if (!queue.length && rows.every((row) => row.dataset.tblListId)) return;

    // 1) 既に割り当て済みの ID をキューから除外
    const assignedIds = new Set(
      rows.map((row) => row.dataset.tblListId).filter(Boolean)
    );
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (assignedIds.has(String(queue[i].id))) queue.splice(i, 1);
    }

    const unassigned = rows.filter((row) => !row.dataset.tblListId);
    if (unassigned.length === 0) return;

    // 2) React fiber から ID / 名前を取得できる場合は最優先
    for (const row of unassigned) {
      const meta = getMetaForRow(row);
      if (!meta || !meta.id) continue;
      row.dataset.tblListId = String(meta.id);
      const cached = getCachedList(meta.id);
      row.dataset.tblName = meta.name || cached?.name || getRowName(row);
      if (meta.createdAt) row.dataset.tblCreatedAt = String(meta.createdAt);
      const index = queue.findIndex((item) => String(item.id) === String(meta.id));
      if (index >= 0) queue.splice(index, 1);
    }

    // 3) 名前が一致するものを割り当て
    for (const row of rows) {
      if (row.dataset.tblListId) continue;
      const name = getRowName(row);
      if (!name) continue;
      const index = queue.findIndex((item) => item.name === name);
      if (index >= 0) {
        const item = queue.splice(index, 1)[0];
        row.dataset.tblListId = String(item.id);
        row.dataset.tblName = item.name || name;
        if (item.createdAt) row.dataset.tblCreatedAt = String(item.createdAt);
      }
    }

    // 4) 残りはレスポンス順と DOM 順が一致する前提で割り当て
    const still = rows.filter((row) => !row.dataset.tblListId);
    if (still.length > 0 && still.length === queue.length) {
      still.forEach((row, index) => {
        const item = queue[index];
        row.dataset.tblListId = String(item.id);
        row.dataset.tblName = item.name || getRowName(row);
        if (item.createdAt) row.dataset.tblCreatedAt = String(item.createdAt);
      });
      queue.length = 0;
    }

    // 5) それでも未割り当てなら、キャッシュから一意に特定できる名前で補完
    for (const row of rows) {
      if (row.dataset.tblListId) continue;
      const name = row.dataset.tblName || getRowName(row);
      if (!name) continue;
      const cache = getCacheForViewer();
      if (!cache) continue;
      const matches = Object.values(cache.lists || {}).filter(
        (item) => item.name === name
      );
      if (matches.length === 1) {
        row.dataset.tblListId = String(matches[0].id);
        row.dataset.tblName = name;
        if (matches[0].createdAt) {
          row.dataset.tblCreatedAt = String(matches[0].createdAt);
        }
      }
    }

    // 6) 名前だけは fiber / DOM / キャッシュから補完しておく
    for (const row of rows) {
      if (!row.dataset.tblName) {
        row.dataset.tblName = getRowName(row);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* row enhancement                                                    */
  /* ------------------------------------------------------------------ */

  function favoriteIdsSet() {
    return new Set(getFavoriteIds());
  }

  function closeTagEditor() {
    try {
      if (tagPopoverCleanup) tagPopoverCleanup();
    } catch {
      /* ignore */
    }
    tagPopoverCleanup = null;
    if (tagPopover) tagPopover.remove();
    tagPopover = null;
  }

  function openTagEditor(
    row,
    listId,
    { onChange = refreshAllRows, anchor = null } = {}
  ) {
    if (!listId) return;
    closeTagEditor();

    const button =
      anchor ||
      row?.querySelector(':scope > .tbl-row-actions .tbl-tag-btn') ||
      row?.querySelector('.tbl-tag-btn');
    const current = getListTags(listId);
    const popover = document.createElement('div');
    popover.className = 'tbl-tag-popover';
    popover.dataset.tbl = 'tag-editor';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');

    const heading = document.createElement('div');
    heading.className = 'tbl-tag-popover-heading';
    heading.textContent = t('リストのタグ', 'List tags');

    const name = document.createElement('div');
    name.className = 'tbl-tag-popover-name';
    name.textContent = row?.dataset?.tblName || getRowName(row) || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tbl-tag-input';
    input.value = current.map((tag) => `#${tag}`).join(' ');
    input.placeholder = t('#仕事 #推し', '#work #favorite');
    input.setAttribute('aria-label', t('タグ（スペース区切り）', 'Tags (space separated)'));

    const hint = document.createElement('div');
    hint.className = 'tbl-tag-hint';
    hint.textContent = t(
      'スペース・カンマ・読点で区切って複数指定できます。',
      'Separate multiple tags with spaces, commas, or commas.'
    );

    const actions = document.createElement('div');
    actions.className = 'tbl-tag-popover-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tbl-tag-action';
    cancel.textContent = t('キャンセル', 'Cancel');

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tbl-tag-action is-primary';
    save.textContent = t('保存', 'Save');

    const commit = () => {
      const next = parseTags(input.value);
      save.disabled = true;
      setListTags(listId, next);
      closeTagEditor();
      try {
        onChange();
      } catch {
        refreshAllRows();
      }
    };

    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTagEditor();
    });
    save.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commit();
    });
    input.addEventListener('keydown', (event) => {
      // 日本語 IME の変換確定 Enter を保存として扱わない
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commit();
      }
    });
    popover.addEventListener('pointerdown', (event) => event.stopPropagation());
    popover.addEventListener('mousedown', (event) => event.stopPropagation());

    actions.append(cancel, save);
    popover.append(heading, name, input, hint, actions);
    document.body.appendChild(popover);

    const rect = button?.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = rect
      ? Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))
      : Math.max(8, (innerWidth - width) / 2);
    let top = rect ? rect.bottom + 8 : Math.max(8, (innerHeight - height) / 2);
    if (rect && top + height > innerHeight - 8) {
      top = Math.max(8, rect.top - height - 8);
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;

    const onPointerDown = (event) => {
      if (!popover.contains(event.target)) closeTagEditor();
    };
    const onKeyDown = (event) => {
      if (event.isComposing) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeTagEditor();
    };
    const onViewportChange = () => closeTagEditor();
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
    }, 0);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);

    tagPopover = popover;
    tagPopoverCleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };

    requestAnimationFrame(() => {
      if (!tagPopover) return;
      input.focus();
      input.select();
    });
  }

  function getViewerTagCatalog() {
    const catalog = new Map();
    for (const values of Object.values(getViewerTags())) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const tag = normalizeTag(value);
        const key = tagKey(tag);
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

  function renameTagEverywhere(fromKey, toValue) {
    const viewerId = getViewerId();
    if (!viewerId || !fromKey) return false;
    const forViewer = getViewerTags(viewerId);
    const to = normalizeTag(toValue);
    let changed = false;

    for (const [listId, values] of Object.entries(forViewer)) {
      if (!Array.isArray(values)) continue;
      const next = [];
      const seen = new Set();
      for (const value of values) {
        const tag = normalizeTag(value);
        const key = tagKey(tag);
        if (!key) continue;
        const out = key === fromKey ? to : tag;
        if (!out) {
          changed = true;
          continue;
        }
        const outKey = tagKey(out);
        if (seen.has(outKey)) {
          changed = true;
          continue;
        }
        seen.add(outKey);
        next.push(out);
      }
      if (next.join('\u0000') !== values.join('\u0000')) changed = true;
      if (next.length) forViewer[listId] = next;
      else {
        delete forViewer[listId];
        changed = true;
      }
    }

    if (!changed) return false;
    saveSettings();
    try {
      window.dispatchEvent(new CustomEvent('tbl-tags-changed'));
    } catch {
      /* ignore */
    }
    if (state.modal.active) refreshAllRows();
    return true;
  }

  function openBulkTagRename(anchor = null) {
    closeTagEditor();
    const catalog = getViewerTagCatalog();
    if (!catalog.length) {
      toast(
        t('リネームできるタグがありません。', 'There are no tags to rename.'),
        'info'
      );
      return;
    }

    const popover = document.createElement('div');
    popover.className = 'tbl-tag-popover tbl-bulk-tag-popover';
    popover.dataset.tbl = 'bulk-tag-rename';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');

    const heading = document.createElement('div');
    heading.className = 'tbl-tag-popover-heading';
    heading.textContent = t('タグを一括リネーム', 'Rename tag everywhere');

    const select = document.createElement('select');
    select.className = 'tbl-tag-select';
    select.setAttribute('aria-label', t('変更するタグ', 'Tag to rename'));
    for (const tag of catalog) {
      const option = document.createElement('option');
      option.value = tag.key;
      option.textContent = `#${tag.label} (${tag.count})`;
      select.appendChild(option);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tbl-tag-input';
    input.value = catalog[0].label;
    input.placeholder = t('新しいタグ名', 'New tag name');
    input.setAttribute(
      'aria-label',
      t('新しいタグ名（空で削除）', 'New tag name (empty to delete)')
    );

    const hint = document.createElement('div');
    hint.className = 'tbl-tag-hint';
    hint.textContent = t(
      'この閲覧者の全リストに適用します。空欄で保存するとタグを削除します。',
      'Applies to every list for this viewer. Save empty to delete the tag.'
    );

    const actions = document.createElement('div');
    actions.className = 'tbl-tag-popover-actions';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'tbl-tag-action';
    cancel.textContent = t('キャンセル', 'Cancel');

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'tbl-tag-action is-primary';
    apply.textContent = t('一括変更', 'Rename');

    select.addEventListener('change', () => {
      const tag = catalog.find((item) => item.key === select.value);
      input.value = tag ? tag.label : '';
      input.focus();
      input.select();
    });

    const commit = () => {
      const fromKey = select.value;
      const changed = renameTagEverywhere(fromKey, input.value);
      closeTagEditor();
      if (changed) {
        toast(t('タグを一括変更しました。', 'Renamed the tag.'), 'success');
      } else {
        toast(t('変更はありません。', 'No changes.'), 'info');
      }
    };

    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeTagEditor();
    });
    apply.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        commit();
      }
    });
    popover.addEventListener('pointerdown', (event) => event.stopPropagation());
    popover.addEventListener('mousedown', (event) => event.stopPropagation());

    actions.append(cancel, apply);
    popover.append(heading, select, input, hint, actions);
    document.body.appendChild(popover);

    const rect = anchor?.getBoundingClientRect?.();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const left = rect
      ? Math.max(8, Math.min(rect.right - width, innerWidth - width - 8))
      : Math.max(8, (innerWidth - width) / 2);
    let top = rect ? rect.bottom + 8 : Math.max(8, (innerHeight - height) / 2);
    if (rect && top + height > innerHeight - 8) {
      top = Math.max(8, rect.top - height - 8);
    }
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;

    const onPointerDown = (event) => {
      if (!popover.contains(event.target)) closeTagEditor();
    };
    const onKeyDown = (event) => {
      if (event.isComposing) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeTagEditor();
    };
    const onViewportChange = () => closeTagEditor();
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
    }, 0);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);

    tagPopover = popover;
    tagPopoverCleanup = () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };

    requestAnimationFrame(() => {
      if (!tagPopover) return;
      select.focus();
    });
  }

  function enhanceRow(row, index) {
    try {
      if (!row.dataset.tblRow) row.dataset.tblRow = '1';
      row.dataset.tblIndex = String(index);

      let actions = row.querySelector(':scope > .tbl-row-actions');
      if (!actions) {
        actions = document.createElement('span');
        actions.className = 'tbl-row-actions';
        actions.addEventListener('mousedown', (event) => event.stopPropagation());
        actions.addEventListener('pointerdown', (event) => event.stopPropagation());
        actions.addEventListener('pointerup', (event) => event.stopPropagation());
        actions.addEventListener('click', (event) => event.stopPropagation());
        row.appendChild(actions);
      }
      actions.classList.toggle(
        'is-overlay',
        state.modal.absolute || row.matches?.('[data-testid="cellInnerDiv"]')
      );

      const id = row.dataset.tblListId || '';
      const favorite = id ? favoriteIdsSet().has(id) : false;
      const tags = id ? getListTags(id) : [];
      const signature = `${id}|${favorite ? '1' : '0'}|${getFavoriteIds().join(',')}|${tags.join(',')}`;
      if (actions.dataset.tblSignature === signature) return;
      actions.dataset.tblSignature = signature;
      actions.textContent = '';

      // # タグ
      const tag = document.createElement('button');
      tag.type = 'button';
      tag.className = `tbl-icon-btn tbl-tag-btn${tags.length > 0 ? ' has-tags' : ''}`;
      tag.textContent = '#';
      tag.title = tags.length > 0
        ? t(
            `タグ: ${tags.map((value) => `#${value}`).join(' ')}`,
            `Tags: ${tags.map((value) => `#${value}`).join(' ')}`
          )
        : t('タグを追加', 'Add tags');
      tag.setAttribute('aria-label', tag.title);
      tag.disabled = !id;
      tag.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!id) {
          toast(t('リストIDを取得できませんでした。少し待ってから再度お試しください。', 'Could not resolve the list ID. Please try again in a moment.'), 'error');
          return;
        }
        openTagEditor(row, id);
      });
      actions.appendChild(tag);

      // ★ お気に入り
      const star = document.createElement('button');
      star.type = 'button';
      star.className = `tbl-icon-btn tbl-star${favorite ? ' is-favorite' : ''}`;
      star.textContent = favorite ? '★' : '☆';
      star.title = favorite
        ? t('お気に入りから外す', 'Remove from favorites')
        : t('お気に入りに追加', 'Add to favorites');
      star.setAttribute('aria-label', star.title);
      star.setAttribute('aria-pressed', favorite ? 'true' : 'false');
      star.disabled = !id;
      star.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!id) {
          toast(t('リストIDを取得できませんでした。少し待ってから再度お試しください。', 'Could not resolve the list ID. Please try again in a moment.'), 'error');
          return;
        }
        toggleFavorite(id);
      });
      actions.appendChild(star);

      if (favorite && id) {
        const up = document.createElement('button');
        up.type = 'button';
        up.className = 'tbl-icon-btn tbl-move';
        up.textContent = '▲';
        up.title = t('お気に入りを上へ', 'Move favorite up');
        up.setAttribute('aria-label', up.title);
        up.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveFavorite(id, -1);
        });

        const down = document.createElement('button');
        down.type = 'button';
        down.className = 'tbl-icon-btn tbl-move';
        down.textContent = '▼';
        down.title = t('お気に入りを下へ', 'Move favorite down');
        down.setAttribute('aria-label', down.title);
        down.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          moveFavorite(id, 1);
        });

        actions.appendChild(up);
        actions.appendChild(down);
      }
    } catch (error) {
      log('enhance row error', error);
    }
  }

  function toggleFavorite(listId) {
    const viewerId = getViewerId();
    if (!viewerId) {
      toast(t('ログイン情報を取得できませんでした。', 'Could not detect the signed-in account.'), 'error');
      return;
    }
    const current = getFavoriteIds(viewerId);
    const index = current.indexOf(String(listId));
    if (index >= 0) current.splice(index, 1);
    else current.push(String(listId));
    state.settings.favorites[viewerId] = current;
    saveSettings();
    refreshAllRows();
  }

  function moveFavorite(listId, delta) {
    const viewerId = getViewerId();
    if (!viewerId) return;
    const current = getFavoriteIds(viewerId);
    const index = current.indexOf(String(listId));
    if (index < 0) return;
    const next = index + delta;
    if (next < 0 || next >= current.length) return;
    [current[index], current[next]] = [current[next], current[index]];
    state.settings.favorites[viewerId] = current;
    saveSettings();
    refreshAllRows();
  }

  function refreshAllRows() {
    if (!state.modal.active) return;
    for (const row of state.modal.rows) {
      const actions = row.querySelector(':scope > .tbl-row-actions');
      if (actions) delete actions.dataset.tblSignature;
      enhanceRow(row, Number(row.dataset.tblIndex || 0));
    }
    applyOrder(state.modal.rows);
    updateToolbar();
  }

  /* ------------------------------------------------------------------ */
  /* toolbar                                                            */
  /* ------------------------------------------------------------------ */

  function findScrollContainer(dialog, container) {
    try {
      if (
        state.modal.scrollEl &&
        state.modal.scrollEl.isConnected &&
        dialog?.contains(state.modal.scrollEl) &&
        (!container || state.modal.scrollEl.contains(container))
      ) {
        return state.modal.scrollEl;
      }

      const viewport = dialog?.querySelector('div[data-viewportview="true"]');
      if (viewport && (!container || viewport.contains(container))) {
        return viewport;
      }

      let node = container || dialog;
      while (node && node !== dialog) {
        const style = getComputedStyle(node);
        if (
          (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
          node.scrollHeight > node.clientHeight
        ) {
          return node;
        }
        node = node.parentElement;
      }
      const candidates = Array.from(dialog?.querySelectorAll('div') || []);
      return (
        candidates.find((el) => {
          const style = getComputedStyle(el);
          return (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight &&
            el.querySelector('[data-testid="listCell"], button[aria-pressed]')
          );
        }) || null
      );
    } catch {
      return null;
    }
  }

  function clearEarlyToolbarStyles(toolbar) {
    for (const property of [
      'position',
      'top',
      'left',
      'right',
      'bottom',
      'width',
      'box-sizing',
      'border-top-left-radius',
      'border-top-right-radius',
      'z-index',
    ]) {
      toolbar.style.removeProperty(property);
    }
  }

  /*
   * 公式ダイアログのスクロール領域ができるまでは、ダイアログ上端に
   * fixed で重ねておく。本文の中央に挿し込むと、あとで正式配置へ移った
   * ときに大きくジャンプするため。幅も本文の内側幅に合わせ、移動時に
   * 横方向へ動かないようにする。
   */
  function parkToolbarAtDialogTop(dialog, toolbar) {
    try {
      const rect = dialog.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (toolbar.parentElement !== dialog) dialog.appendChild(toolbar);
        return;
      }
      if (toolbar.parentElement !== document.body) {
        document.body.appendChild(toolbar);
      }
      const width = Math.max(0, dialog.clientWidth || rect.width);
      toolbar.style.order = '';
      toolbar.style.position = 'fixed';
      toolbar.style.top = `${Math.round(rect.top + dialog.clientTop)}px`;
      toolbar.style.left = `${Math.round(rect.left + dialog.clientLeft)}px`;
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';
      toolbar.style.width = `${Math.round(width)}px`;
      toolbar.style.boxSizing = 'border-box';
      const dialogStyle = getComputedStyle(dialog);
      toolbar.style.borderTopLeftRadius = dialogStyle.borderTopLeftRadius;
      toolbar.style.borderTopRightRadius = dialogStyle.borderTopRightRadius;
      toolbar.style.zIndex = '2147483646';
    } catch {
      /* ignore */
    }
  }

  function placeToolbar(dialog, container) {
    const toolbar = state.modal.toolbar;
    if (!toolbar) return false;
    try {
      const scroll = findScrollContainer(dialog, container);
      if (scroll) state.modal.scrollEl = scroll;

      let parent = null;
      let before = null;
      if (container && !state.modal.absolute) {
        parent = container;
        before = container.firstChild;
      } else if (scroll?.parentElement) {
        parent = scroll.parentElement;
        before = scroll;
      } else if (container) {
        parent = container;
        before = container.firstChild;
      }

      if (!parent) {
        parkToolbarAtDialogTop(dialog, toolbar);
        return false;
      }

      clearEarlyToolbarStyles(toolbar);
      const alreadyPlaced =
        toolbar.parentElement === parent &&
        (before === toolbar || toolbar.nextElementSibling === before);
      if (!alreadyPlaced) parent.insertBefore(toolbar, before);

      // 絶対配置の仮想リストではスクロール領域の兄弟として置くため、
      // order は不要。通常のリストでは先頭に固定する。
      toolbar.style.order = parent === container ? '-1000' : '';
      return true;
    } catch {
      parkToolbarAtDialogTop(dialog, toolbar);
      return false;
    }
  }

  function ensureToolbar(dialog, container = null) {
    if (state.modal.toolbar && state.modal.toolbar.isConnected) {
      placeToolbar(dialog, container);
      return;
    }
    const toolbar = document.createElement('div');
    toolbar.className = 'tbl-toolbar';
    toolbar.dataset.tbl = 'toolbar';
    toolbar.style.order = '-1000';

    const main = document.createElement('div');
    main.className = 'tbl-toolbar-main';

    const title = document.createElement('div');
    title.className = 'tbl-toolbar-title';
    title.textContent = t('リストの並び順', 'List order');

    const favoritesOnly = document.createElement('button');
    favoritesOnly.type = 'button';
    favoritesOnly.className = 'tbl-sort-btn tbl-fav-filter';
    favoritesOnly.textContent = t('☆ お気に入り', '☆ Favorites');
    favoritesOnly.title = t('お気に入りのみ表示', 'Show favorites only');
    favoritesOnly.setAttribute('aria-label', favoritesOnly.title);
    favoritesOnly.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.modal.favoritesOnly = !state.modal.favoritesOnly;
      applyOrder(state.modal.rows);
      updateToolbar();
    });

    const sorts = document.createElement('div');
    sorts.className = 'tbl-sort-group';
    for (const mode of ['name', 'newest', 'oldest']) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tbl-sort-btn';
      btn.dataset.sort = mode;
      btn.textContent =
        mode === 'name'
          ? t('名前順', 'Name')
          : mode === 'newest'
            ? t('新しい順', 'Newest')
            : t('古い順', 'Oldest');
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        state.settings.sortMode = mode;
        saveSettings();
        applyOrder(state.modal.rows);
        updateToolbar();
      });
      sorts.appendChild(btn);
    }

    const status = document.createElement('span');
    status.className = 'tbl-status';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'tbl-refresh-btn';
    refresh.textContent = '↻';
    refresh.title = t('リストを再取得（手動）', 'Reload lists (manual)');
    refresh.setAttribute('aria-label', refresh.title);
    refresh.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      requestCacheRefresh();
    });

    const tail = document.createElement('div');
    tail.className = 'tbl-toolbar-tail';
    tail.append(status, refresh);

    main.append(title, favoritesOnly, sorts, tail);

    const filters = document.createElement('div');
    filters.className = 'tbl-filter-row';
    filters.dataset.tbl = 'filters';

    const filterLabel = document.createElement('span');
    filterLabel.className = 'tbl-filter-label';
    filterLabel.textContent = t('タグ', 'Tags');

    const chips = document.createElement('div');
    chips.className = 'tbl-filter-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', t('タグで絞り込み', 'Filter by tag'));

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tbl-filter-clear';
    clear.textContent = t('クリア', 'Clear');
    clear.title = t('タグ絞り込みを解除', 'Clear tag filter');
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.modal.activeTags.clear();
      applyOrder(state.modal.rows);
      updateToolbar();
    });

    const bulkRename = document.createElement('button');
    bulkRename.type = 'button';
    bulkRename.className = 'tbl-filter-clear tbl-bulk-rename';
    bulkRename.textContent = t('✎ タグ名変更', '✎ Rename tags');
    bulkRename.title = t('タグを一括リネーム', 'Rename a tag everywhere');
    bulkRename.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openBulkTagRename(event.currentTarget);
    });

    filters.append(filterLabel, chips, bulkRename, clear);

    const searchRow = document.createElement('div');
    searchRow.className = 'tbl-search-row';
    searchRow.dataset.tbl = 'search';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'tbl-search-input';
    searchInput.placeholder = t('リスト名・タグを検索', 'Search lists or tags');
    searchInput.setAttribute(
      'aria-label',
      t('リスト名・タグを検索', 'Search lists or tags')
    );
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;

    const clearSearch = document.createElement('button');
    clearSearch.type = 'button';
    clearSearch.className = 'tbl-filter-clear tbl-search-clear';
    clearSearch.textContent = t('クリア', 'Clear');
    clearSearch.title = t('検索をクリア', 'Clear search');
    clearSearch.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      state.modal.searchQuery = '';
      searchInput.value = '';
      applyOrder(state.modal.rows);
      updateToolbar();
      searchInput.focus();
    });

    searchInput.addEventListener('input', () => {
      state.modal.searchQuery = searchInput.value;
      applyOrder(state.modal.rows);
      updateToolbar();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      state.modal.searchQuery = '';
      searchInput.value = '';
      applyOrder(state.modal.rows);
      updateToolbar();
    });

    searchRow.append(searchInput, clearSearch);
    toolbar.append(main, filters, searchRow);

    state.modal.toolbar = toolbar;
    placeToolbar(dialog, container);
    updateToolbar();
  }

  function syncSearchControls(toolbar) {
    if (!toolbar) return;
    const row = toolbar.querySelector('.tbl-search-row');
    const input = toolbar.querySelector('.tbl-search-input');
    const clear = toolbar.querySelector('.tbl-search-clear');
    if (!row || !input) return;
    const visible = state.settings.dialogSearch === true;
    row.style.display = visible ? '' : 'none';
    if (!visible) {
      // Do not keep an invisible filter active when the option is off.
      state.modal.searchQuery = '';
    }
    if (input.value !== state.modal.searchQuery) {
      input.value = state.modal.searchQuery;
    }
    if (clear) {
      clear.style.display = state.modal.searchQuery ? '' : 'none';
    }
  }

  function updateToolbar() {
    const toolbar = state.modal.toolbar;
    if (!toolbar || !toolbar.isConnected) return;
    syncSearchControls(toolbar);
    const sortMode = state.settings.sortMode;
    toolbar.querySelectorAll('.tbl-sort-btn[data-sort]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.sort === sortMode);
      btn.setAttribute(
        'aria-pressed',
        btn.dataset.sort === sortMode ? 'true' : 'false'
      );
    });

    const favoritesOnlyBtn = toolbar.querySelector('.tbl-fav-filter');
    if (favoritesOnlyBtn) {
      favoritesOnlyBtn.classList.toggle('is-active', state.modal.favoritesOnly);
      favoritesOnlyBtn.setAttribute(
        'aria-pressed',
        state.modal.favoritesOnly ? 'true' : 'false'
      );
    }

    // お気に入りだけを表示している間は、お気に入り内の手動順が常に
    // 優先されるため、名前順/新旧順は実質的に効かない。操作できない
    // ことが一目で分かるよう、ソート群をグレーダウンする。
    const sortGroup = toolbar.querySelector('.tbl-sort-group');
    if (sortGroup) {
      const muted = Boolean(
        state.modal.favoritesOnly && state.settings.favoritesFirst
      );
      sortGroup.classList.toggle('is-muted', muted);
      sortGroup.setAttribute('aria-disabled', muted ? 'true' : 'false');
      sortGroup.title = muted
        ? t(
            'お気に入りフィルター中は登録順です',
            'Favorites order while favorites-only is on'
          )
        : '';
      sortGroup.querySelectorAll('button').forEach((btn) => {
        btn.disabled = muted;
      });
    }

    renderTagFilters(toolbar);

    const status = toolbar.querySelector('.tbl-status');
    if (status) {
      const rows = state.modal.rows.length;
      const expected = Math.max(
        state.modal.expectedCount || 0,
        getCachedListCount()
      );
      const favorites = getFavoriteIds().length;
      const searchActive = Boolean(
        state.settings.dialogSearch && normalizeSearchText(state.modal.searchQuery)
      );
      const filtersActive =
        state.modal.favoritesOnly ||
        state.modal.activeTags.size > 0 ||
        searchActive;
      const visible = filtersActive
        ? state.modal.rows.filter((row) => rowMatchesFilters(row)).length
        : rows;
      let text = '';
      if (state.modal.preparing || state.modal.autoLoading) {
        // 初回は総数が確定するまで件数を出さない。20 → 40 のように
        // 読み込み中に件数が動いて見えるのを避ける。
        if (expected > 0 && getCacheForViewer()?.complete) {
          // 2 回目以降はキャッシュ済みの最終件数をそのまま出す。ネイティブ側の
          // ページ読み込みは裏で進め、ユーザーには再取得しているよう見せない。
          text = t(`全${expected}件`, `${expected} lists`);
        } else {
          text = t('リストを読み込み中…', 'Loading lists…');
        }
      } else if (rows === 0) {
        if (expected > 0 && getCacheForViewer()?.complete) {
          // 2 回目以降は行が復元される前から最終件数を出す。クエリが
          // 終わっていても仮想行のマウントが遅れることがあるため、
          // autoLoadDone では打ち切らない。
          text = t(`全${expected}件`, `${expected} lists`);
        } else {
          text = state.modal.refreshing
            ? t('キャッシュ更新中…', 'Refreshing cache…')
            : state.modal.autoLoadDone
              ? t('リストはありません', 'No lists')
              : t('リストを読み込み中…', 'Loading lists…');
        }
      } else if (state.modal.favoritesOnly) {
        text = t(`★${visible}/${rows}`, `★${visible} / ${rows}`);
      } else if (state.modal.activeTags.size > 0 || searchActive) {
        // Keep this compact: the native dialog is narrow, and a long
        // "表示n件 / 全n件" label used to push the ↻ button onto its own line.
        text = t(`表示${visible}/${rows}`, `${visible} / ${rows}`);
      } else if (state.modal.expanded || state.modal.autoLoadDone) {
        text = t(`全${rows}件`, `${rows} lists`);
      } else if (state.modal.refreshing) {
        text = t('キャッシュ更新中…', 'Refreshing cache…');
      } else {
        text = t(`${rows}件を表示`, `${rows} shown`);
      }
      if (favorites > 0 && !state.modal.favoritesOnly) {
        text += t(` / ★${favorites}`, ` / ★${favorites}`);
      }
      status.textContent = text;
    }

    const refresh = toolbar.querySelector('.tbl-refresh-btn');
    if (refresh) {
      refresh.disabled = state.modal.refreshing;
      refresh.classList.toggle('is-spinning', state.modal.refreshing);
    }

    if (state.modal.headerEl && state.modal.expanded) {
      setInline(state.modal.headerEl, 'top', `${toolbar.offsetHeight}px`);
    }
  }

  function renderTagFilters(toolbar) {
    const chips = toolbar.querySelector('.tbl-filter-chips');
    if (!chips) return;
    const catalog = getTagCatalog();
    const active = state.modal.activeTags;
    const signature = `${catalog
      .map((tag) => `${tag.key}:${tag.label}:${tag.count}`)
      .join('|')}::${Array.from(active).sort().join(',')}`;
    const clear = toolbar.querySelector(
      '.tbl-filter-clear:not(.tbl-bulk-rename)'
    );
    if (clear) clear.style.display = active.size > 0 ? '' : 'none';

    if (chips.dataset.tblSignature === signature) return;
    chips.dataset.tblSignature = signature;
    chips.textContent = '';

    if (catalog.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tbl-filter-empty';
      empty.textContent = t(
        'タグは各行の「#」から追加できます',
        'Add tags with # on each row'
      );
      chips.appendChild(empty);
      return;
    }

    for (const tag of catalog) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tbl-filter-chip';
      chip.dataset.tag = tag.key;
      chip.textContent = `#${tag.label}`;
      chip.title = t(`${tag.count}件のリスト`, `${tag.count} lists`);
      const isActive = active.has(tag.key);
      chip.classList.toggle('is-active', isActive);
      chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      chip.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (active.has(tag.key)) active.delete(tag.key);
        else active.add(tag.key);
        applyOrder(state.modal.rows);
        updateToolbar();
      });
      chips.appendChild(chip);
    }
  }

  let listPageMetaRequest = 0;

  function requestListPageMeta() {
    listPageMetaRequest += 1;
    const requestId = `tbl-page-${Date.now()}-${listPageMetaRequest}`;
    sendToMain('read-list-page', { requestId });
    return requestId;
  }

  function requestCacheRefresh(silent = false) {
    /*
     * Re-check the automatic conditions here as well as in maybeAutoRefresh:
     * the automatic refresh is delayed, and a native pagination may have made
     * the cache complete (or the user may have turned auto-load OFF) while the
     * timer was pending.
     */
    if (
      silent &&
      (!state.settings.autoLoadAll || getCacheForViewer()?.complete)
    ) {
      return;
    }
    const viewerId = getViewerId();
    if (!viewerId) {
      if (!silent) {
        toast(t('ユーザー情報を取得できませんでした。', 'Could not detect the user information.'), 'error');
      }
      return;
    }
    if (state.modal.refreshing) return;
    const requestId = `tbl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.modal.refreshing = true;
    state.modal.refreshSilent = Boolean(silent);
    state.modal.refreshRequestId = requestId;
    markAutoRefreshAttempt(viewerId);
    updateToolbar();
    /*
     * The add/remove target only changes each list's is_member flag.  The list
     * set itself belongs to the viewer, so fetch it once with the viewer as
     * the target.  This is what makes opening the dialog for user B reuse the
     * same cache that was built while adding user A.
     */
    sendToMain('fetch-all-lists', {
      requestId,
      userId: viewerId,
      viewerId,
      maxPages: 100,
    });
  }

  function maybeAutoRefresh() {
    if (
      !state.modal.active ||
      state.modal.refreshing ||
      state.modal.autoRefreshRequested ||
      state.modal.rows.length === 0 ||
      // Let the native pagination finish first.  If it reaches the end, the
      // cache becomes complete and this background refresh is unnecessary.
      state.modal.preparing
    ) {
      return;
    }
    /*
     * "未取得のリストを自動で読み込む" must also cover this background full
     * refresh.  Otherwise turning it OFF still caused a fetch whenever the
     * cache was incomplete.
     */
    if (!state.settings.autoLoadAll) return;

    const cache = getCacheForViewer();
    // 全件キャッシュができた後は自動再取得しない。2 回目以降を軽くするため、
    // 更新はユーザーが ↻ を押したときだけ行う。
    if (cache?.complete) return;

    // A failed/truncated attempt must not be retried on every dialog open.
    // The target user is irrelevant here because the full list set is cached
    // per viewer.  Manual ↻ ignores this cooldown.
    const lastAttempt = Number(cache?.lastAutoRefreshAt) || 0;
    if (lastAttempt > 0 && Date.now() - lastAttempt < AUTO_REFRESH_COOLDOWN_MS) {
      return;
    }

    state.modal.autoRefreshRequested = true;
    setTimeout(() => {
      if (!state.settings.autoLoadAll) return;
      if (getCacheForViewer()?.complete) return;
      if (state.modal.active && !state.modal.refreshing) {
        requestCacheRefresh(true);
      }
    }, state.modal.expanded ? 700 : 250);
  }

  /* ------------------------------------------------------------------ */
  /* ordering                                                           */
  /* ------------------------------------------------------------------ */

  let collator = null;
  let collatorLang = '';

  function getCollator() {
    const lang = isJa() ? 'ja' : 'en';
    if (!collator || collatorLang !== lang) {
      collator = new Intl.Collator(lang, { numeric: true, sensitivity: 'base' });
      collatorLang = lang;
    }
    return collator;
  }

  function compareById(a, b, direction) {
    const aId = a.dataset.tblListId;
    const bId = b.dataset.tblListId;
    if (aId && bId) {
      try {
        const diff = BigInt(aId) - BigInt(bId);
        if (diff !== 0n) return direction * (diff > 0n ? 1 : -1);
      } catch {
        /* fall through */
      }
      const numA = Number(aId);
      const numB = Number(bId);
      if (Number.isFinite(numA) && Number.isFinite(numB) && numA !== numB) {
        return direction * (numA > numB ? 1 : -1);
      }
    }
    const createdA = Number(a.dataset.tblCreatedAt);
    const createdB = Number(b.dataset.tblCreatedAt);
    if (Number.isFinite(createdA) && Number.isFinite(createdB) && createdA !== createdB) {
      return direction * (createdA > createdB ? 1 : -1);
    }
    const indexA = Number(a.dataset.tblIndex || 0);
    const indexB = Number(b.dataset.tblIndex || 0);
    return direction * (indexA - indexB);
  }

  function applyOrder(rows) {
    if (!rows || rows.length === 0) return;
    pruneActiveTags();
    const visibleRows = [];
    for (const row of rows) {
      if (rowMatchesFilters(row)) {
        row.removeAttribute('data-tbl-filtered');
        visibleRows.push(row);
      } else {
        row.setAttribute('data-tbl-filtered', '1');
      }
    }

    const favorites = getFavoriteIds();
    const favoriteIndex = new Map(favorites.map((id, index) => [id, index]));
    const mode = state.settings.sortMode;

    const sorted = [...visibleRows].sort((a, b) => {
      const aFav = a.dataset.tblListId
        ? favoriteIndex.has(String(a.dataset.tblListId))
        : false;
      const bFav = b.dataset.tblListId
        ? favoriteIndex.has(String(b.dataset.tblListId))
        : false;

      if (state.settings.favoritesFirst) {
        if (aFav && bFav) {
          return (
            favoriteIndex.get(String(a.dataset.tblListId)) -
            favoriteIndex.get(String(b.dataset.tblListId))
          );
        }
        if (aFav !== bFav) return aFav ? -1 : 1;
      }

      if (mode === 'name') {
        const nameA = a.dataset.tblName || getRowName(a);
        const nameB = b.dataset.tblName || getRowName(b);
        const diff = getCollator().compare(nameA, nameB);
        if (diff !== 0) return diff;
        return compareById(a, b, 1);
      }

      // newest = 新しい ID が先
      return mode === 'newest'
        ? compareById(a, b, -1)
        : compareById(a, b, 1);
    });

    const container = state.modal.container;

    if (state.modal.absolute && container) {
      applyAbsoluteOrder(container, sorted);
      return;
    }

    sorted.forEach((row, index) => {
      row.style.order = String(index);
    });

    // 行以外の子要素の順序を固定
    if (container) {
      for (const child of Array.from(container.children)) {
        if (child === state.modal.toolbar) {
          child.style.order = '-1000';
          continue;
        }
        if (rows.includes(child)) continue;
        if (child.querySelector && findShowMoreIn(child)) {
          child.style.order = '999999';
        } else if (
          /Create a new List|新しいリストを作成|リストを作成/i.test(
            child.textContent || ''
          )
        ) {
          child.style.order = '-900';
        }
      }
    }
  }

  function isBlankSpacer(child) {
    return (
      !child.textContent.trim() &&
      !child.querySelector('button, a, [role="button"]')
    );
  }

  function applyAbsoluteOrder(container, sortedRows) {
    const rowSet = new Set(sortedRows);
    const children = Array.from(container.children).filter(
      (child) => child.nodeType === 1
    );

    if (sortedRows.length === 0) {
      // フィルタで 0 件になった場合でも、先頭の「新しいリストを作成」行は
      // 残し、巨大な仮想スクロール用スペーサーだけを畳む。
      const allRows = new Set(state.modal.rows);
      const keep = [];
      for (const child of children) {
        if (
          allRows.has(child) ||
          child.getAttribute('data-tbl-filtered') === '1'
        ) {
          continue;
        }
        if (isBlankSpacer(child)) {
          setInline(child, 'display', 'none');
          continue;
        }
        keep.push(child);
      }
      let top = 0;
      for (const child of keep) {
        setInline(child, 'position', 'absolute');
        setInline(child, 'width', '100%');
        setInline(child, 'transform', `translateY(${top}px)`);
        top += Math.max(0, child.offsetHeight);
      }
      setInline(container, 'height', `${top}px`);
      setInline(container, 'min-height', `${top}px`);
      setInline(container, 'max-height', `${top}px`);
      fitExpandedViewport();
      return;
    }

    if (!children.includes(sortedRows[0])) {
      // 行が直接の子ではない場合は CSS order にフォールバック
      sortedRows.forEach((row, index) => {
        row.style.order = String(index);
      });
      return;
    }

    const firstRowIndex = children.findIndex((child) => rowSet.has(child));
    const lastRowIndex = children.reduce(
      (last, child, index) => (rowSet.has(child) ? index : last),
      -1
    );
    const leading = children.filter(
      (child, index) => index < firstRowIndex && !rowSet.has(child)
    );
    const trailing = children.filter(
      (child, index) => index > lastRowIndex && !rowSet.has(child)
    );

    // 仮想リストの末尾には高さ 200px 程度の空スペーサーが残ることがある。
    // 全行を実測して並べ終えた後は不要なので、空の末尾要素だけ隠す。
    const hiddenTrailing = trailing.filter((child) => isBlankSpacer(child));
    hiddenTrailing.forEach((child) => setInline(child, 'display', 'none'));

    const visibleTrailing = trailing.filter(
      (child) => !hiddenTrailing.includes(child)
    );
    const ordered = [...leading, ...sortedRows, ...visibleTrailing];
    let top = 0;
    for (const child of ordered) {
      setInline(child, 'position', 'absolute');
      setInline(child, 'width', '100%');
      setInline(child, 'transform', `translateY(${top}px)`);
      top += Math.max(0, child.offsetHeight);
    }

    // X's virtualizer uses a large spacer element.  Once all rows are mounted
    // we know the real height, so collapse the spacer and remove the dead
    // space below the last row.
    if (top > 0) {
      setInline(container, 'height', `${top}px`);
      setInline(container, 'min-height', `${top}px`);
      setInline(container, 'max-height', `${top}px`);
      fitExpandedViewport();
    }
  }

  function fitExpandedViewport() {
    if (
      !state.modal.expanded ||
      !state.modal.scrollEl ||
      !state.modal.container
    ) {
      return;
    }
    const sc = state.modal.scrollEl;
    const container = state.modal.container;
    if (!sc.isConnected || !container.isConnected || !sc.contains(container)) {
      return;
    }
    try {
      const scRect = sc.getBoundingClientRect();
      const section = container.closest('section');
      const sectionTop = section
        ? section.getBoundingClientRect().top - scRect.top
        : 0;
      const containerTop = section
        ? container.getBoundingClientRect().top -
          section.getBoundingClientRect().top
        : container.getBoundingClientRect().top - scRect.top;
      const content =
        sectionTop + containerTop + Math.max(0, container.offsetHeight) + 12;
      const height = Math.max(640, Math.ceil(content));
      setInline(sc, 'height', `${height}px`);
      setInline(sc, 'flex', `0 0 ${height}px`);
    } catch {
      /* ignore layout read failures */
    }
  }

  /* ------------------------------------------------------------------ */
  /* auto load all                                                      */
  /* ------------------------------------------------------------------ */

  function findShowMoreIn(root) {
    if (!root || !root.querySelectorAll) return null;
    const buttons = Array.from(root.querySelectorAll('button'));
    return (
      buttons.find((btn) => {
        if (btn.hasAttribute('aria-pressed')) return false;
        const text = (btn.textContent || '').trim();
        return /^(Show more|さらに表示|もっと見る|もっと表示)$/i.test(text);
      }) || null
    );
  }

  function findShowMore(dialog) {
    return findShowMoreIn(dialog);
  }

  function nativeHeaderFor(sc) {
    if (!sc) return null;
    const first = sc.firstElementChild;
    if (first && first.querySelector('[data-testid="app-bar-close"], button')) {
      return first;
    }
    const close = sc.querySelector('[data-testid="app-bar-close"]');
    return close?.closest('div[style*="sticky"]') || close?.parentElement?.parentElement || null;
  }

  function expandNativeList(dialog, container) {
    try {
      const count = Math.max(
        updateExpectedCount(),
        state.modal.rows.length,
        state.modal.loadedIds.size,
        1
      );
      const sc = findScrollContainer(dialog, container);
      if (!sc) return false;
      state.modal.scrollEl = sc;

      // Small lists already fit without expansion; still allow sorting.
      if (count <= 12 && sc.scrollHeight <= sc.clientHeight + 120) {
        state.modal.expanded = true;
        return true;
      }

      const parent = sc.parentElement;
      if (!parent) return false;
      state.modal.scrollParent = parent;
      state.modal.headerEl = nativeHeaderFor(sc);

      const height = Math.min(
        20000,
        Math.max(1400, count * 76 + 500)
      );
      setInline(sc, 'height', `${height}px`);
      setInline(sc, 'max-height', 'none');
      setInline(sc, 'min-height', '0');
      setInline(sc, 'flex', `0 0 ${height}px`);
      setInline(sc, 'overflow', 'visible');

      setInline(parent, 'overflow-y', 'auto');
      setInline(parent, 'overscroll-behavior', 'contain');

      const header = state.modal.headerEl;
      if (header) {
        const toolbarHeight = state.modal.toolbar?.offsetHeight || 0;
        setInline(header, 'top', `${toolbarHeight}px`);
        setInline(header, 'z-index', '19');
        setInline(header, 'background', 'var(--tbl-bg-solid)');
      }

      dialog.setAttribute('data-tbl-expanded', '1');
      state.modal.expanded = true;
      // Force React/layout to mount the rows which are now inside the tall viewport.
      void sc.offsetHeight;
      return true;
    } catch (error) {
      log('expand failed', error);
      return false;
    }
  }

  function collapseNativeList(dialog) {
    try {
      const sc = state.modal.scrollEl;
      const parent = state.modal.scrollParent;
      const header = state.modal.headerEl;
      restoreInline(sc);
      restoreInline(parent);
      restoreInline(header);
      if (parent) parent.scrollTop = 0;
      if (sc) sc.scrollTop = 0;
      dialog?.removeAttribute('data-tbl-expanded');
      state.modal.expanded = false;
      state.modal.scrollParent = null;
      state.modal.headerEl = null;
    } catch (error) {
      log('collapse failed', error);
    }
  }

  function isCurrentPreparation(token) {
    return (
      state.modal.active &&
      state.modal.prepareToken === token &&
      !state.modal.expansionFailed
    );
  }

  function setPreparationScrollOverflow(hidden) {
    const parent =
      state.modal.scrollParent || state.modal.scrollEl?.parentElement;
    if (!parent) return;
    setInline(parent, 'overflow-y', hidden ? 'hidden' : 'auto');
  }

  function applyPreparedRows() {
    const container = state.modal.container;
    if (!container) return false;
    prepareContainer(container, state.modal.absolute);
    state.modal.rows.forEach((row, index) => enhanceRow(row, index));
    applyOrder(state.modal.rows);
    return true;
  }

  /*
   * X keeps loading the next page after the tall viewport is installed.  Keep
   * the rows hidden until that native pagination becomes quiet as well; this
   * is what prevents the visible 20 -> 40 -> 60 row/count jumps on repeat
   * opens.  The cache total is only a target: if X cannot mount all of it we
   * still reveal the rows after a bounded wait.
   */
  async function waitForPaginationIdle(token, target = 0) {
    const started = Date.now();
    let lastLoaded = state.modal.loadedIds.size;
    let lastRows = state.modal.rows.length;
    let lastChangeAt = started;
    let sawData = lastLoaded > 0 || lastRows > 0;
    const maxMs = target > 0 ? 2800 : 3400;
    while (Date.now() - started < maxMs) {
      if (!isCurrentPreparation(token)) return false;
      scanModalNow();
      if (!isCurrentPreparation(token)) return false;
      const loaded = state.modal.loadedIds.size;
      const rows = state.modal.rows.length;
      if (loaded !== lastLoaded || rows !== lastRows) {
        lastLoaded = loaded;
        lastRows = rows;
        lastChangeAt = Date.now();
      }
      if (loaded > 0 || rows > 0) sawData = true;
      /*
       * An incomplete cache has no cached target yet.  Once X explicitly ends
       * the query, its loaded-id count is the final target; waiting for those
       * rows prevents a brief "no lists" toolbar state before the virtualized
       * rows mount.
       */
      const queryEnded =
        state.modal.receivedQuery &&
        (state.modal.ended || state.modal.nextCursor == null);
      const effectiveTarget =
        target > 0 ? target : queryEnded ? loaded : 0;
      const targetReached = effectiveTarget <= 0 || rows >= effectiveTarget;
      const quietFor = Date.now() - lastChangeAt;
      const elapsed = Date.now() - started;

      /*
       * A complete cache knows the final row count.  Once every cached row is
       * mounted and X has explicitly ended the pagination, there is nothing
       * left to wait for; revealing immediately avoids the old extra quiet
       * period that made a cached open feel like a refetch.
       */
      if (
        sawData &&
        state.modal.receivedQuery &&
        effectiveTarget > 0 &&
        targetReached &&
        queryEnded
      ) {
        return true;
      }
      if (
        sawData &&
        state.modal.receivedQuery &&
        effectiveTarget > 0 &&
        targetReached &&
        quietFor >= 180
      ) {
        return true;
      }
      if (
        sawData &&
        state.modal.receivedQuery &&
        targetReached &&
        (state.modal.ended || state.modal.nextCursor == null) &&
        quietFor >= 220
      ) {
        return true;
      }
      /*
       * Incomplete caches have no reliable target.  Give X enough time to
       * request page 2 before revealing the rows, otherwise the user still
       * sees 20 -> 40 even though the loading state itself is hidden.  If the
       * cache total is known and still short, wait until the bounded timeout
       * instead of exposing a partial list early.
       */
      if (
        elapsed >= 1200 &&
        sawData &&
        state.modal.receivedQuery &&
        quietFor >= 700 &&
        targetReached
      ) {
        return true;
      }
      /*
       * Empty lists are valid, but a single 100-row native response can take
       * around a second.  Keep the loading state long enough that a slow first
       * response is not mistaken for an empty list.
       */
      if (!sawData && elapsed >= 2500) {
        return true;
      }
      await sleep(60);
    }
    return sawData;
  }

  async function finishPreparation(dialog, token) {
    if (!isCurrentPreparation(token)) return;
    state.modal.expanded = true;

    // スクロールバーは準備中には出さない。行の高さと順序を確定させてから
    // overflow を戻すため、開いた直後にサムが伸び縮みしない。
    setPreparationScrollOverflow(true);

    const cacheComplete = Boolean(getCacheForViewer()?.complete);
    const cachedCount = getCachedListCount();
    await waitForPaginationIdle(token, cacheComplete ? cachedCount : 0);
    if (!isCurrentPreparation(token)) return;

    const expected = Math.max(state.modal.expectedCount, getCachedListCount());
    const settled =
      expected > 0 &&
      state.modal.rows.length >= expected &&
      (state.modal.ended || state.modal.nextCursor == null);

    if (!settled) {
      for (let pass = 0; pass < 4; pass += 1) {
        if (!isCurrentPreparation(token)) return;
        const before = state.modal.rows.length;
        scanModalNow();
        if (!isCurrentPreparation(token)) return;
        applyPreparedRows();
        await sleep(pass === 0 ? 60 : 30);
        if (!isCurrentPreparation(token)) return;
        if (state.modal.rows.length === before && pass >= 1) break;
      }
    }

    // 最終レイアウトを決めてからスクロールバーを戻し、もう一度だけ
    // 並びを適用してから行を見せる。全行が揃ってクエリも終わっている
    // 場合は、余分な待ち pass を飛ばして次フレームで見せる。
    applyPreparedRows();
    setPreparationScrollOverflow(false);
    await sleep(settled ? 16 : 40);
    if (!isCurrentPreparation(token)) return;
    applyPreparedRows();

    state.modal.preparing = false;
    dialog?.removeAttribute('data-tbl-preparing');
    scanModalNow();

    const allCachedRowsLoaded =
      Boolean(getCacheForViewer()?.complete) &&
      expected > 0 &&
      (state.modal.rows.length >= expected ||
        state.modal.loadedIds.size >= expected);
    /*
     * A Bottom cursor can still be present on the final ListOwnerships page,
     * so a quiet DOM alone is not proof that native pagination ended.  Mark
     * the cache complete only on an explicit end signal (terminate instruction
     * / missing cursor) or when an already-complete cache's rows are mounted.
     */
    const cursorEnded =
      state.modal.receivedQuery && state.modal.nextCursor == null;
    if (state.modal.ended || cursorEnded || allCachedRowsLoaded) {
      markCacheComplete();
    }
    maybeAutoRefresh();
  }

  async function startPreparation(dialog, container) {
    if (
      state.modal.preparing ||
      state.modal.expanded ||
      state.modal.autoLoading ||
      state.modal.expansionFailed
    ) {
      return;
    }
    const token = state.modal.prepareToken + 1;
    state.modal.prepareToken = token;
    state.modal.preparing = true;
    dialog.setAttribute('data-tbl-preparing', '1');
    updateToolbar();

    try {
      if (!state.storageLoaded) await loadStorage();
      if (!isCurrentPreparation(token)) return;
      state.modal.cacheCompleteAtOpen = Boolean(getCacheForViewer()?.complete);
      const expected = updateExpectedCount();
      const cachedCount = getCachedListCount();
      const cacheComplete = Boolean(getCacheForViewer()?.complete && cachedCount > 0);

      /*
       * 2 回目以降、X は直前のクエリ結果をメモリに持っていることが多い。
       * 全件そろっていれば autoLoad（末尾スクロールによる再取得）を行わない。
       * まだ行が無い場合は 550ms も待たず、先にネイティブのリストを縦に
       * 広げて X 自身の 1 ページ目を早く描画させる。
       */
      const naturalReady =
        cacheComplete &&
        (state.modal.rows.length >= cachedCount ||
          state.modal.loadedIds.size >= cachedCount);
      if (naturalReady) {
        state.modal.autoLoadDone = true;
        updateToolbar();
      }

      // X may already have loaded every list item in the first response while
      // only mounting the visible rows.  In that case scrolling / clicking
      // "Show more" is unnecessary and makes repeat opens look like a fresh
      // collection even though the cache is already complete.
      const cacheCompleteNow = Boolean(
        getCacheForViewer()?.complete && getCachedListCount() > 0
      );
      const allItemsLoaded =
        expected > 0 && state.modal.loadedIds.size >= expected;
      const shouldLoad =
        state.settings.autoLoadAll &&
        !state.modal.autoLoadDone &&
        !naturalReady &&
        !allItemsLoaded &&
        !cacheCompleteNow &&
        (state.modal.nextCursor != null ||
          (expected > 0 && state.modal.loadedIds.size < expected));

      if (shouldLoad) {
        await startAutoLoad(dialog);
      }
      if (!isCurrentPreparation(token)) return;

      if (!expandNativeList(dialog, container)) {
        state.modal.expansionFailed = true;
        state.modal.preparing = false;
        setPreparationScrollOverflow(false);
        dialog.removeAttribute('data-tbl-preparing');
        state.modal.expanded = true;
        scanModalNow();
        return;
      }
      setPreparationScrollOverflow(true);

      // Let React mount the additional rows before measuring/sorting.
      await sleep(60);
      if (!isCurrentPreparation(token)) return;
      scanModalNow();

      const expectedNow = Math.max(
        state.modal.expectedCount,
        getCachedListCount()
      );
      const allItemsLoadedNow =
        expectedNow > 0 && state.modal.loadedIds.size >= expectedNow;
      if (
        state.settings.autoLoadAll &&
        state.modal.rows.length < expectedNow &&
        state.modal.nextCursor != null &&
        !state.modal.autoLoadDone &&
        !allItemsLoadedNow &&
        !getCacheForViewer()?.complete
      ) {
        // Multiple pages arrived before the viewport was expanded; collapse
        // once more so X can paginate in its normal virtualized layout.
        collapseNativeList(dialog);
        await startAutoLoad(dialog);
        if (!isCurrentPreparation(token)) return;
        expandNativeList(dialog, container);
        await sleep(150);
        if (!isCurrentPreparation(token)) return;
        scanModalNow();
      }

      await finishPreparation(dialog, token);
    } catch (error) {
      log('prepare error', error);
      if (isCurrentPreparation(token)) {
        state.modal.preparing = false;
        setPreparationScrollOverflow(false);
        dialog.removeAttribute('data-tbl-preparing');
        state.modal.expansionFailed = true;
        state.modal.expanded = true;
        scanModalNow();
      }
    }
  }

  async function waitForRowGrowth(before, timeout, token, beforeLoaded = 0) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!state.modal.active || token !== state.modal.autoLoadToken) return false;
      scanModalNow();
      if (hasLoadedAllCached()) return true;
      if (state.modal.loadedIds.size > beforeLoaded) {
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function startAutoLoad(dialog) {
    if (!state.settings.autoLoadAll) return;
    if (state.modal.autoLoading || state.modal.autoLoadDone) return;
    state.modal.autoLoading = true;
    state.modal.autoLoadToken += 1;
    const token = state.modal.autoLoadToken;
    updateToolbar();

    try {
      for (let page = 0; page < 50; page += 1) {
        if (!state.modal.active || token !== state.modal.autoLoadToken) return;

        if (hasLoadedAllCached()) {
          state.modal.autoLoadDone = true;
          break;
        }

        const button = findShowMore(dialog);
        if (button) {
          const before = state.modal.rows.length;
          const beforeLoaded = state.modal.loadedIds.size;
          try {
            button.click();
          } catch {
            break;
          }
          state.modal.pages += 1;
          updateToolbar();

          const grew = await waitForRowGrowth(before, 750, token, beforeLoaded);
          if (!grew) {
            state.modal.stall += 1;
            if (state.modal.stall >= 2) {
              state.modal.autoLoadDone = true;
              break;
            }
          } else {
            state.modal.stall = 0;
          }
          continue;
        }

        // 現行 UI には「さらに表示」ボタンがなく、スクロール末尾で次ページを取得する
        if (state.modal.absolute || getCheckboxCells(dialog).length > 0) {
          if (state.modal.nextCursor == null) {
            state.modal.autoLoadDone = true;
            break;
          }
          const scrollEl =
            state.modal.scrollEl || findScrollContainer(dialog, state.modal.container);
          if (!scrollEl) {
            state.modal.autoLoadDone = true;
            break;
          }
          state.modal.scrollEl = scrollEl;
          const before = state.modal.rows.length;
          const beforeLoaded = state.modal.loadedIds.size;
          scrollEl.scrollTop = scrollEl.scrollHeight;
          state.modal.pages += 1;
          updateToolbar();

          const grew = await waitForRowGrowth(before, 700, token, beforeLoaded);
          if (!grew) {
            state.modal.stall += 1;
            // バックグラウンドの全件取得が完了するまで待つ余裕を残す。
            // 途中で打ち切ると 40 件しかないように見えることがある。
            if (state.modal.stall >= 4 || state.modal.nextCursor == null) {
              state.modal.autoLoadDone = true;
              break;
            }
          } else {
            state.modal.stall = 0;
          }
          continue;
        }

        state.modal.autoLoadDone = true;
        break;
      }

      if (!findShowMore(dialog) && state.modal.nextCursor == null) {
        state.modal.autoLoadDone = true;
        markCacheComplete();
      }
    } finally {
      state.modal.autoLoading = false;
      updateToolbar();
    }
  }

  /* ------------------------------------------------------------------ */
  /* observers                                                          */
  /* ------------------------------------------------------------------ */

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (location.pathname !== state.lastPath) {
        state.lastPath = location.pathname;
        if (!isListModalRoute()) cleanupModal();
      }
      if (isListModalRoute()) scanModalSoon();
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-pressed'],
    });

    if (isListModalRoute()) scanModalSoon();

    // SPA のルート変更を監視（X 側の実装に依存しない保険）
    setInterval(() => {
      if (location.pathname !== state.lastPath) {
        state.lastPath = location.pathname;
        if (isListModalRoute()) scanModalSoon();
        else cleanupModal();
      }
      if (isListModalRoute() && !state.modal.active) scanModalSoon();
      // X が行の transform を再計算した場合に備えて並び順を再適用
      if (
        state.modal.active &&
        state.modal.expanded &&
        !state.modal.preparing &&
        state.modal.rows.length > 0
      ) {
        applyOrder(state.modal.rows);
      }
    }, 800);
  }

  /* ------------------------------------------------------------------ */
  /* settings sync                                                      */
  /* ------------------------------------------------------------------ */

  function watchStorage() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.settings) {
          state.settings = normalizeSettings(changes.settings.newValue);
          if (state.modal.active) refreshAllRows();
        }
        if (changes.listCache && changes.listCache.newValue) {
          state.cache = changes.listCache.newValue;
        }
        if (changes.meta && changes.meta.newValue) {
          state.meta = changes.meta.newValue;
          const cookieViewer = readViewerIdFromCookie();
          if (cookieViewer) state.viewerId = cookieViewer;
          else if (changes.meta.newValue.viewerId) {
            state.viewerId = changes.meta.newValue.viewerId;
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* public API (sidebar.js から利用)                                    */
  /* ------------------------------------------------------------------ */

  Object.assign(TBL, {
    state,
    isJa,
    t,
    toast,
    log,
    sleep,
    getViewerId,
    getFavoriteIds,
    getCacheForViewer,
    getCachedList,
    getCachedListCount,
    getListTags,
    setListTags,
    getViewerTags,
    getViewerTagCatalog,
    normalizeTag,
    tagKey,
    parseTags,
    openTagEditor,
    openBulkTagRename,
    renameTagEverywhere,
    readListMeta: findListMetaInFiber,
    requestListPageMeta,
    saveSettings,
    loadStorage,
    normalizeSettings,
    DEFAULT_SETTINGS,
    scanModalSoon,
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  async function boot() {
    await loadStorage();
    state.viewerId = getViewerId();
    migrateViewerCaches();
    if (state.viewerId && state.meta.viewerId !== state.viewerId) {
      state.meta.viewerId = state.viewerId;
      saveMeta();
    }
    watchStorage();
    startObserver();
    sendToMain('hello');
    // MAIN 側の準備ができるまで数回挨拶する
    setTimeout(() => sendToMain('hello'), 400);
    setTimeout(() => sendToMain('hello'), 1600);
    // アカウントメニューが描画されたら閲覧者IDを確定する。twid が
    // 読めない環境でも、対象ユーザーIDをキャッシュキーにしない。
    setTimeout(syncViewerFromDom, 600);
    setTimeout(syncViewerFromDom, 1600);
    setInterval(syncViewerFromDom, 5000);
    log('content booted', state.viewerId);
  }

  boot();
})();
