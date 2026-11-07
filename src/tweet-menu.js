/**
 * Twitter Better List - timeline (...) menu (ISOLATED world)
 *
 * Hides selected items in the (...) menu on timeline posts.  Profile pages
 * and the viewer's own posts are intentionally excluded.  The menu is made
 * invisible from the caret click until its items have been classified, so a
 * hidden item is never shown long enough to be clicked by mistake.
 */
(() => {
  'use strict';

  if (window.__TBL_TWEET_MENU__) return;
  window.__TBL_TWEET_MENU__ = true;

  const TBL = window.__TBL__;
  if (!TBL) return;

  const GUARD_ATTR = 'data-tbl-tweet-menu-guard';
  const HIDDEN_CLASS = 'tbl-tweet-menu-hidden';
  const HIDDEN_KEY_ATTR = 'data-tbl-tweet-menu-hidden';
  const SPACER_ATTR = 'data-tbl-tweet-menu-spacer';
  const SPACER_ICON_PATH =
    'M12 2.25c-.23 0-.46.05-.67.14L4.6 5.45A1.75 1.75 0 0 0 3.5 7.05v4.3c0 4.86 3.15 9.31 7.81 11.18.44.18.94.18 1.38 0 4.66-1.87 7.81-6.32 7.81-11.18v-4.3c0-.67-.38-1.28-.98-1.59L12.67 2.39c-.21-.09-.44-.14-.67-.14Z';

  const DEFAULT_MENU = {
    topSpacer: false,
    notInterested: false,
    follow: false,
    unfollow: false,
    listAddRemove: false,
    mute: false,
    quoteOff: false,
    muteConversation: false,
    block: false,
    postActivity: false,
    embedPost: false,
    editImage: false,
    report: false,
    communityNote: false,
  };

  // Follow and unfollow are deliberately separate settings.
  const ITEM_RULES = [
    {
      key: 'unfollow',
      test: (label) =>
        /(?:さんをフォロー(?:を)?解除|さんのフォロー(?:を)?解除)$/.test(
          label
        ) || /^unfollow\s+@/.test(label),
    },
    {
      key: 'follow',
      test: (label) =>
        /さんをフォロー$/.test(label) || /^follow\s+@/.test(label),
    },
    {
      key: 'notInterested',
      test: (label) =>
        label === 'このポストに興味がない' ||
        label === 'not interested in this post' ||
        label === 'not interested',
    },
    {
      key: 'listAddRemove',
      test: (label) =>
        label === 'リストから追加/削除' ||
        label.includes('add/remove from lists') ||
        label.includes('add or remove from lists'),
    },
    {
      key: 'quoteOff',
      test: (label) =>
        /引用(?:リ)?(?:ツイート|rt|ポスト)をオフ/.test(label) ||
        /turn off (?:quote )?(?:reposts?|retweets?)/.test(label),
    },
    {
      key: 'muteConversation',
      test: (label) =>
        label.includes('会話をミュート') ||
        label.includes('mute this conversation'),
    },
    {
      key: 'mute',
      test: (label) =>
        label === 'ミュート' ||
        label === 'mute' ||
        /さんをミュート$/.test(label),
    },
    {
      key: 'block',
      test: (label) =>
        /さんをブロック$/.test(label) ||
        /^block\s+@/.test(label) ||
        label === 'ブロック' ||
        label === 'block',
    },
    {
      key: 'postActivity',
      test: (label) =>
        label.includes('ポストアクティビティを表示') ||
        label.includes('view post engagements'),
    },
    {
      key: 'embedPost',
      test: (label) =>
        label.includes('ポストを埋め込む') || label.includes('embed post'),
    },
    {
      key: 'editImage',
      test: (label) => label === '画像を編集' || label === 'edit image',
    },
    {
      key: 'report',
      test: (label) =>
        label === 'ポストを報告' ||
        label === 'report post' ||
        label === 'report',
    },
    {
      key: 'communityNote',
      test: (label) =>
        label.includes('コミュニティノートをリクエスト') ||
        label.includes('request community note'),
    },
  ];

  const state = {
    settings: { ...DEFAULT_MENU },
    pending: null,
    guardTimer: 0,
    releaseTimer: 0,
    observer: null,
  };

  function normalizeLabel(value) {
    return String(value || '')
      .replace(/[\u200b-\u200d\ufeff]/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function normalizeMenuSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const next = { ...DEFAULT_MENU, ...source };
    for (const key of Object.keys(DEFAULT_MENU)) {
      next[key] = next[key] === true;
    }
    return next;
  }

  function hasActiveSetting() {
    return Object.keys(DEFAULT_MENU).some((key) => state.settings[key]);
  }

  function readStoredSettings() {
    try {
      chrome.storage.local.get(['settings'], (result) => {
        if (result?.settings?.tweetMenu) {
          state.settings = normalizeMenuSettings(result.settings.tweetMenu);
        } else {
          state.settings = { ...DEFAULT_MENU };
        }
        if (!hasActiveSetting()) clearAllMenus();
      });
    } catch {
      /* extension context may have been invalidated */
    }
  }

  function parseHandle(href) {
    const match = String(href || '').match(/^\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]).toLowerCase() : '';
  }

  function findViewerHandle() {
    try {
      const link = document.querySelector(
        'a[data-testid="AppTabBar_Profile_Link"]'
      );
      if (link) {
        const handle = parseHandle(link.getAttribute('href') || link.href);
        if (handle) return handle;
      }
    } catch {
      /* ignore */
    }
    return '';
  }

  function findArticleHandle(article) {
    try {
      const link = article?.querySelector(
        '[data-testid="User-Name"] a[href^="/"]'
      );
      if (!link) return '';
      return parseHandle(link.getAttribute('href') || link.href);
    } catch {
      return '';
    }
  }

  function isOwnArticle(article) {
    const viewer = findViewerHandle();
    if (!viewer) return false;
    const author = findArticleHandle(article);
    return Boolean(author && author === viewer);
  }

  function isTimelineSurface() {
    const path = (location.pathname || '/').replace(/\/+$/, '').toLowerCase();
    if (!path || path === '/home') return true;
    if (/^\/(explore|notifications|messages|search)(\/|$)/.test(path)) {
      return true;
    }
    if (/^\/hashtag(\/|$)/.test(path)) return true;
    if (/^\/i\/(lists|communities|bookmarks|trends|topics)(\/|$)/.test(path)) {
      return true;
    }
    return false;
  }

  function getMenuItems(menu) {
    if (!menu) return [];
    return Array.from(menu.querySelectorAll('[role="menuitem"]')).filter(
      (item) => item.closest('[role="menu"]') === menu
    );
  }

  function findTweetMenu() {
    const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(
      (menu) => menu.querySelector('[data-testid="Dropdown"]')
    );
    let best = null;
    let bestScore = -1;
    for (const menu of menus) {
      const style = getComputedStyle(menu);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // X can leave a previously opened menu in the DOM off-screen.  Pick the
      // menu that actually intersects the viewport, not just the last node.
      const rect = menu.getBoundingClientRect();
      const overlapX = Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0)
      );
      const overlapY = Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
      );
      const score = overlapX * overlapY;
      if (score > bestScore) {
        best = menu;
        bestScore = score;
      }
    }
    return bestScore > 0 ? best : menus.length ? menus[menus.length - 1] : null;
  }

  function itemKey(item) {
    const label = normalizeLabel(item?.innerText || item?.textContent || '');
    const testId = String(item?.getAttribute('data-testid') || '').toLowerCase();
    if (testId === 'report') return 'report';
    if (testId === 'tweetengagements') return 'postActivity';
    for (const rule of ITEM_RULES) {
      if (rule.test(label)) return rule.key;
    }
    return '';
  }

  function hideItem(item, key, hidden) {
    item.classList.toggle(HIDDEN_CLASS, hidden);
    if (hidden) item.setAttribute(HIDDEN_KEY_ATTR, key);
    else item.removeAttribute(HIDDEN_KEY_ATTR);
  }

  function restoreItem(item) {
    if (!item.hasAttribute(HIDDEN_KEY_ATTR)) return;
    item.classList.remove(HIDDEN_CLASS);
    item.removeAttribute(HIDDEN_KEY_ATTR);
  }

  function menuLooksOwn(items) {
    return items.some((item) => {
      const label = normalizeLabel(item.innerText || item.textContent || '');
      return (
        /ポストを削除|ポストをピン留め|ピン留め|ポストを編集/.test(label) ||
        /delete post|pin to profile|edit post/.test(label)
      );
    });
  }

  function spacerLabel() {
    return typeof TBL.t === 'function'
      ? TBL.t('誤クリック防止', 'Misclick guard')
      : '誤クリック防止';
  }

  function stopSpacerEvent(event) {
    event.stopPropagation();
    if (event.type === 'click') event.preventDefault();
  }

  function createSpacer(firstItem) {
    const spacer = firstItem.cloneNode(true);
    spacer.classList.remove(HIDDEN_CLASS);
    spacer.removeAttribute(HIDDEN_KEY_ATTR);
    spacer.removeAttribute('data-testid');
    spacer.setAttribute(SPACER_ATTR, '1');
    spacer.setAttribute('role', 'menuitem');
    spacer.setAttribute('aria-disabled', 'true');
    spacer.setAttribute('tabindex', '-1');
    spacer.classList.add('tbl-tweet-menu-spacer');
    spacer.style.cursor = 'default';
    spacer.querySelectorAll('[data-testid]').forEach((node) => {
      node.removeAttribute('data-testid');
    });
    const icons = Array.from(spacer.querySelectorAll('svg'));
    if (icons.length) {
      const icon = icons[0];
      icons.slice(1).forEach((node) => node.remove());
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('fill', 'currentColor');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('focusable', 'false');
      icon.replaceChildren();
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', SPACER_ICON_PATH);
      path.setAttribute('fill', 'currentColor');
      icon.append(path);
    }
    const label = spacer.querySelector('span') || spacer.querySelector('[dir="ltr"]');
    if (label) label.textContent = spacerLabel();
    spacer.addEventListener('pointerdown', stopSpacerEvent, true);
    spacer.addEventListener('click', stopSpacerEvent, true);
    return spacer;
  }

  function ensureSpacer(dropdown, firstItem) {
    const existing = Array.from(
      dropdown.querySelectorAll(`[${SPACER_ATTR}="1"]`)
    );
    if (!state.settings.topSpacer || !firstItem) {
      existing.forEach((node) => node.remove());
      return;
    }
    let spacer = existing[0] || null;
    if (!spacer) spacer = createSpacer(firstItem);
    existing.slice(1).forEach((node) => node.remove());
    if (dropdown.firstElementChild !== spacer) {
      dropdown.insertBefore(spacer, dropdown.firstChild);
    }
  }

  function clearMenu(menu) {
    if (!menu) return;
    menu.querySelectorAll(`[${HIDDEN_KEY_ATTR}]`).forEach(restoreItem);
    menu.querySelectorAll(`[${SPACER_ATTR}="1"]`).forEach((node) => node.remove());
  }

  function clearAllMenus() {
    document.querySelectorAll('[role="menu"]').forEach(clearMenu);
  }

  function applyMenu(menu) {
    const dropdown = menu.querySelector('[data-testid="Dropdown"]');
    if (!dropdown) return false;
    const items = getMenuItems(menu);
    if (!items.length) return false;

    for (const item of items) {
      const key = itemKey(item);
      if (!key) {
        restoreItem(item);
        continue;
      }
      hideItem(item, key, state.settings[key] === true);
    }
    ensureSpacer(dropdown, items[0]);
    return true;
  }

  function clearGuard() {
    try {
      document.documentElement.removeAttribute(GUARD_ATTR);
    } catch {
      /* ignore */
    }
  }

  function stopObserver() {
    if (!state.observer) return;
    state.observer.disconnect();
    state.observer = null;
  }

  function finishPending() {
    if (state.guardTimer) {
      clearTimeout(state.guardTimer);
      state.guardTimer = 0;
    }
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      state.releaseTimer = 0;
    }
    state.pending = null;
    stopObserver();
    clearGuard();
  }

  function scheduleGuardRelease() {
    if (state.releaseTimer) clearTimeout(state.releaseTimer);
    state.releaseTimer = setTimeout(() => {
      state.releaseTimer = 0;
      clearGuard();
    }, 80);
  }

  function startObserver() {
    if (state.observer) return;
    const root = document.documentElement;
    if (!root) return;
    state.observer = new MutationObserver(() => {
      if (state.pending) maybeSanitize();
    });
    state.observer.observe(root, { childList: true, subtree: true });
  }

  function startGuard() {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute(GUARD_ATTR, '1');
    if (state.guardTimer) clearTimeout(state.guardTimer);
    startObserver();
    state.guardTimer = setTimeout(finishPending, 1500);
  }

  function maybeSanitize() {
    if (!state.pending) return false;
    const menu = findTweetMenu();
    if (!menu) return false;
    const items = getMenuItems(menu);
    if (!items.length) return false;
    if (menuLooksOwn(items)) {
      clearMenu(menu);
      finishPending();
      return false;
    }
    if (!applyMenu(menu)) return false;
    scheduleGuardRelease();
    return true;
  }

  function handleCaret(event) {
    if (event.type === 'pointerdown' && event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    const caret = target?.closest('[data-testid="caret"]');
    if (!caret) return;
    const article = caret.closest('article[data-testid="tweet"]');
    if (!article) return;

    if (!hasActiveSetting()) {
      clearAllMenus();
      finishPending();
      return;
    }
    if (!isTimelineSurface() || isOwnArticle(article)) {
      clearAllMenus();
      finishPending();
      return;
    }

    state.pending = { article };
    startGuard();
  }

  function boot() {
    readStoredSettings();
    document.addEventListener('pointerdown', handleCaret, true);
    document.addEventListener('click', handleCaret, true);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        state.settings = normalizeMenuSettings(
          changes.settings.newValue?.tweetMenu
        );
        if (!hasActiveSetting()) clearAllMenus();
      });
    } catch {
      /* extension context may have been invalidated */
    }
  }

  boot();
})();
