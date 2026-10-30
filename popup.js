/* Twitter Better List - popup */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    version: 1,
    sortMode: 'newest',
    favorites: {},
    tags: {},
    defaultTagSeeded: {},
    favoritesFirst: true,
    autoLoadAll: true,
    sidebarEnabled: true,
    hideDiscoverLists: false,
    language: 'auto',
  };

  const el = {
    sortGroup: document.getElementById('sort-group'),
    favoritesFirst: document.getElementById('favorites-first'),
    autoLoad: document.getElementById('auto-load'),
    sidebarEnabled: document.getElementById('sidebar-enabled'),
    hideDiscover: document.getElementById('hide-discover'),
    cacheMeta: document.getElementById('cache-meta'),
    clearCache: document.getElementById('clear-cache'),
    openX: document.getElementById('open-x'),
    backupText: document.getElementById('backup-text'),
    backupStatus: document.getElementById('backup-status'),
    exportBackup: document.getElementById('export-backup'),
    importBackup: document.getElementById('import-backup'),
    viewer: document.getElementById('viewer'),
  };

  let state = {
    settings: { ...DEFAULT_SETTINGS },
    cache: {},
    meta: {},
  };

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      chrome.storage.local.set(value, () => resolve());
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, () => resolve());
    });
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
    return next;
  }

  function getViewerId() {
    const metaViewer = state.meta?.viewerId || null;
    const keys = new Set([
      ...Object.keys(state.cache || {}),
      ...Object.keys(state.settings.favorites || {}),
      ...Object.keys(state.settings.tags || {}),
    ]);
    if (metaViewer && keys.has(metaViewer)) return metaViewer;
    // 旧バージョンの meta が対象ユーザーIDのまま残っていても、
    // 実データ (お気に入り/タグ/キャッシュ) があるキーを優先する。
    const withData = Array.from(keys).find(
      (key) =>
        state.cache?.[key] ||
        Array.isArray(state.settings.favorites?.[key]) ||
        (state.settings.tags?.[key] &&
          typeof state.settings.tags[key] === 'object')
    );
    return withData || metaViewer || null;
  }

  function getCacheForViewer() {
    const viewerId = getViewerId();
    if (!viewerId) return null;
    return state.cache[viewerId] || null;
  }

  function setSettings(next) {
    state.settings = normalizeSettings(next);
    return storageSet({ settings: state.settings });
  }

  function renderSettings() {
    const settings = state.settings;
    el.sortGroup.querySelectorAll('button[data-sort]').forEach((btn) => {
      const active = btn.dataset.sort === settings.sortMode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    el.favoritesFirst.checked = settings.favoritesFirst !== false;
    el.autoLoad.checked = settings.autoLoadAll !== false;
    el.sidebarEnabled.checked = settings.sidebarEnabled !== false;
    el.hideDiscover.checked = settings.hideDiscoverLists === true;
  }

  function renderCacheMeta() {
    const viewerId = getViewerId();
    if (!viewerId) {
      el.viewer.textContent = 'アカウント未検出';
      el.cacheMeta.textContent =
        'X でリスト追加画面を一度開くと、アカウントとリスト情報を取得します。';
      return;
    }
    el.viewer.textContent = `viewer: ${viewerId}`;
    const cache = getCacheForViewer();
    if (!cache) {
      el.cacheMeta.textContent = 'リストデータはまだありません。';
      return;
    }
    const count = Object.keys(cache.lists || {}).length;
    const updated = cache.updatedAt
      ? new Date(cache.updatedAt).toLocaleString()
      : '不明';
    el.cacheMeta.textContent = `${count}件 / 更新: ${updated}${
      cache.complete ? ' / 全件取得済み' : ''
    }`;
  }

  function uniqueStrings(value) {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(value.map((item) => String(item).trim()).filter(Boolean))
    );
  }

  function sanitizeFavorites(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [viewerId, ids] of Object.entries(value)) {
      const clean = uniqueStrings(ids);
      if (viewerId && clean.length) out[String(viewerId)] = clean;
    }
    return out;
  }

  function sanitizeTags(value) {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const [viewerId, lists] of Object.entries(value)) {
      if (!lists || typeof lists !== 'object') continue;
      const cleanLists = {};
      for (const [listId, tags] of Object.entries(lists)) {
        const clean = uniqueStrings(tags);
        if (listId && clean.length) cleanLists[String(listId)] = clean;
      }
      if (viewerId && Object.keys(cleanLists).length) {
        out[String(viewerId)] = cleanLists;
      }
    }
    return out;
  }

  function importedSettings(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const next = normalizeSettings({
      version: 1,
      sortMode: raw.sortMode,
      favorites: sanitizeFavorites(raw.favorites),
      tags: sanitizeTags(raw.tags),
      defaultTagSeeded:
        raw.defaultTagSeeded && typeof raw.defaultTagSeeded === 'object'
          ? raw.defaultTagSeeded
          : {},
      favoritesFirst: raw.favoritesFirst,
      autoLoadAll: raw.autoLoadAll,
      sidebarEnabled: raw.sidebarEnabled,
      hideDiscoverLists: raw.hideDiscoverLists,
      language: ['auto', 'ja', 'en'].includes(raw.language)
        ? raw.language
        : 'auto',
    });
    return next;
  }

  function remapViewerData(settings, fromViewer, toViewer) {
    if (!fromViewer || !toViewer || fromViewer === toViewer) return settings;
    const favorites = { ...(settings.favorites || {}) };
    const tags = { ...(settings.tags || {}) };
    const seeded = { ...(settings.defaultTagSeeded || {}) };
    const fromFavorites = favorites[fromViewer] || [];
    const toFavorites = favorites[toViewer] || [];
    const mergedFavorites = Array.from(
      new Set([...toFavorites, ...fromFavorites].map(String))
    );
    if (mergedFavorites.length) favorites[toViewer] = mergedFavorites;

    const fromTags = tags[fromViewer] || {};
    const toTags = tags[toViewer] || {};
    for (const [listId, values] of Object.entries(fromTags)) {
      const current = Array.isArray(toTags[listId]) ? toTags[listId] : [];
      toTags[listId] = Array.from(
        new Set([...current, ...(Array.isArray(values) ? values : [])].map(String))
      );
    }
    if (Object.keys(toTags).length) tags[toViewer] = toTags;
    if (seeded[fromViewer] && typeof seeded[fromViewer] === 'object') {
      seeded[toViewer] = {
        ...(seeded[toViewer] && typeof seeded[toViewer] === 'object'
          ? seeded[toViewer]
          : {}),
        ...seeded[fromViewer],
      };
    }
    delete favorites[fromViewer];
    delete tags[fromViewer];
    delete seeded[fromViewer];
    return { ...settings, favorites, tags, defaultTagSeeded: seeded };
  }

  function makeBackup() {
    const settings = { ...state.settings };
    delete settings.debug;
    return {
      app: 'twitter-better-list',
      format: 1,
      exportedAt: new Date().toISOString(),
      viewerId: getViewerId(),
      settings,
    };
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    try {
      el.backupText.focus();
      el.backupText.select();
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }

  function setBackupStatus(text) {
    el.backupStatus.textContent = text || '';
  }

  function bindEvents() {
    el.sortGroup.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-sort]');
      if (!btn) return;
      state.settings.sortMode = btn.dataset.sort;
      setSettings(state.settings).then(renderSettings);
    });

    el.favoritesFirst.addEventListener('change', () => {
      state.settings.favoritesFirst = el.favoritesFirst.checked;
      setSettings(state.settings);
    });

    el.autoLoad.addEventListener('change', () => {
      state.settings.autoLoadAll = el.autoLoad.checked;
      setSettings(state.settings);
    });

    el.sidebarEnabled.addEventListener('change', () => {
      state.settings.sidebarEnabled = el.sidebarEnabled.checked;
      setSettings(state.settings);
    });

    el.hideDiscover.addEventListener('change', () => {
      state.settings.hideDiscoverLists = el.hideDiscover.checked;
      setSettings(state.settings);
    });

    el.clearCache.addEventListener('click', async () => {
      if (!confirm('リストのキャッシュを消去します。お気に入り設定は残ります。よろしいですか？')) {
        return;
      }
      await storageRemove(['listCache']);
      state.cache = {};
      renderCacheMeta();
    });

    el.openX.addEventListener('click', () => {
      chrome.tabs.create({ url: 'https://x.com/home' });
    });

    el.exportBackup.addEventListener('click', async () => {
      const text = JSON.stringify(makeBackup());
      el.backupText.value = text;
      const copied = await copyText(text);
      setBackupStatus(
        copied
          ? 'エクスポートしました。クリップボードにコピー済みです。'
          : 'エクスポートしました。テキストを選択してコピーしてください。'
      );
    });

    el.importBackup.addEventListener('click', async () => {
      const text = el.backupText.value.trim();
      if (!text) {
        setBackupStatus('インポートする JSON を貼り付けてください。');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        setBackupStatus('JSON の形式が正しくありません。');
        return;
      }
      const source =
        payload &&
        typeof payload === 'object' &&
        payload.settings &&
        typeof payload.settings === 'object'
          ? payload.settings
          : payload;
      const known = [
        'sortMode',
        'favorites',
        'tags',
        'defaultTagSeeded',
        'favoritesFirst',
        'autoLoadAll',
        'sidebarEnabled',
        'hideDiscoverLists',
        'language',
      ];
      if (
        !source ||
        typeof source !== 'object' ||
        !known.some((key) => Object.prototype.hasOwnProperty.call(source, key))
      ) {
        setBackupStatus('この JSON はバックアップ形式ではありません。');
        return;
      }
      const hasCurrentData =
        Object.keys(state.settings.favorites || {}).length > 0 ||
        Object.keys(state.settings.tags || {}).length > 0;
      if (
        hasCurrentData &&
        !confirm(
          '現在のお気に入り・タグ・設定をインポート内容で置き換えます。よろしいですか？'
        )
      ) {
        return;
      }

      let next = importedSettings(source);
      const sourceViewer = payload?.viewerId ? String(payload.viewerId) : null;
      const currentViewer = getViewerId();
      const remapped = Boolean(
        sourceViewer && currentViewer && sourceViewer !== String(currentViewer)
      );
      if (remapped) {
        next = remapViewerData(next, sourceViewer, String(currentViewer));
      }

      await setSettings(next);
      state.settings = next;
      renderSettings();
      setBackupStatus(
        remapped
          ? 'インポートしました。別アカウントのデータを現在のアカウントへ統合しました。'
          : 'インポートしました。'
      );
    });
  }

  async function boot() {
    const stored = await storageGet(['settings', 'listCache', 'meta']);
    state.settings = normalizeSettings(stored.settings);
    state.cache = stored.listCache && typeof stored.listCache === 'object' ? stored.listCache : {};
    state.meta = stored.meta && typeof stored.meta === 'object' ? stored.meta : {};
    renderSettings();
    renderCacheMeta();
    bindEvents();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.settings) {
        state.settings = normalizeSettings(changes.settings.newValue);
        renderSettings();
      }
      if (changes.listCache) {
        state.cache = changes.listCache.newValue || {};
        renderCacheMeta();
      }
      if (changes.meta) {
        state.meta = changes.meta.newValue || {};
        renderCacheMeta();
      }
    });
  }

  boot();
})();
