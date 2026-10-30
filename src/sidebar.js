/*
 * Twitter Better List - sidebar expansion
 *
 * 左サイドバー最下部の「More」に格納されている項目を、
 * 投稿ボタンの上に展開して表示します。
 *
 * 項目の抽出は X の実際のメニューを一瞬開いて DOM から読み取ります。
 * 表示行は X の標準ナビゲーション行を複製して作るため、幅・高さ・
 * ホバー・アイコン位置が標準ボタンと揃います。
 *
 * クリック時は元のメニュー項目をクリックするため、X 側の
 * SPA ナビゲーション / モーダル / 外部リンクの挙動をそのまま利用できます。
 * Control Panel for Twitter (CPT) が非表示にしている項目は、
 * 計算済みスタイルを確認して一覧から除外します。
 */
(() => {
  'use strict';

  if (window.__TBL_SIDEBAR__) return;
  window.__TBL_SIDEBAR__ = true;

  const TBL = window.__TBL__ || {};
  const t = TBL.t || ((ja, en) => ja);
  const log = TBL.log || (() => {});
  const sleep = TBL.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const state = {
    section: null,
    items: [],
    moreButton: null,
    hiddenMore: null,
    lastSignature: '',
    extracting: false,
    menuWasOpen: false,
    refreshTimer: null,
    resizeTimer: null,
    lastCollapsed: null,
    observer: null,
    disabled: false,
  };

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  /*
   * Visibility check used for CPT coexistence.
   * CPT hides menu rows with `display: none !important`; it does not remove
   * them.  We deliberately ignore opacity because the extraction popup is
   * made transparent by our own CSS while it is open.
   */
  function isDisplayed(el) {
    if (!el || !el.isConnected) return false;
    if (el.hidden) return false;
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const style = getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse'
      ) {
        return false;
      }
      if (node.hidden) return false;
      if (node !== el && node.getAttribute('aria-hidden') === 'true') return false;
      if (node === document.body) break;
      node = node.parentElement;
      depth += 1;
    }
    if (typeof el.checkVisibility === 'function') {
      try {
        if (
          !el.checkVisibility({
            checkOpacity: false,
            checkVisibilityCSS: true,
          })
        ) {
          return false;
        }
      } catch {
        /* ignore */
      }
    }
    return el.getClientRects().length > 0;
  }

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

  function getDestFromFiber(el) {
    let fiber = getFiber(el);
    let depth = 0;
    while (fiber && depth < 30) {
      const props = fiber.memoizedProps;
      if (
        props &&
        typeof props === 'object' &&
        props.dest &&
        typeof props.dest === 'object'
      ) {
        return props.dest;
      }
      fiber = fiber.return;
      depth += 1;
    }
    return null;
  }

  function getMoreButton() {
    const candidates = Array.from(
      document.querySelectorAll(
        'button[data-testid="AppTabBar_More_Menu"], button[aria-haspopup="menu"]'
      )
    );
    return (
      candidates.find((btn) => {
        if (btn.getAttribute('data-testid') === 'AppTabBar_More_Menu') {
          return true;
        }
        const label =
          `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.trim();
        return /More|もっと|その他|More menu items/i.test(label);
      }) || null
    );
  }

  function getSidebarNav(moreButton) {
    return (
      moreButton?.closest('nav') ||
      document.querySelector('header nav') ||
      document.querySelector('nav[aria-label]') ||
      null
    );
  }

  function getPostButton() {
    return (
      document.querySelector('#sidebar-compose-post') ||
      document.querySelector('a[data-testid="SideNav_NewTweet_Button"]') ||
      document.querySelector('a[href="/compose/post"]') ||
      Array.from(document.querySelectorAll('button, a')).find((el) =>
        /^(Post|ポスト|ツイート)$/i.test(
          (el.getAttribute('aria-label') || el.textContent || '').trim()
        )
      ) ||
      null
    );
  }

  function getMoreContainer(moreButton) {
    if (!moreButton) return null;
    return (
      moreButton.closest('div[data-testid="AppTabBar_More_Menu"]') ||
      moreButton.closest('li') ||
      moreButton
    );
  }

  function setMoreHidden(hidden) {
    const more = getMoreButton();
    if (!more) return;
    const container = getMoreContainer(more);
    if (!container) return;
    state.moreButton = more;
    state.hiddenMore = container;
    if (hidden) {
      container.setAttribute('data-tbl-hidden-more', '1');
    } else {
      container.removeAttribute('data-tbl-hidden-more');
      container.style.display = '';
    }
  }

  function normalizeLabel(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\d+\+?$/, '')
      .trim();
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ */
  /* extract menu items                                                 */
  /* ------------------------------------------------------------------ */

  function waitFor(predicate, timeout = 1500, interval = 40) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        try {
          const value = predicate();
          if (value) {
            resolve(value);
            return;
          }
        } catch {
          /* ignore */
        }
        if (Date.now() - started >= timeout) {
          resolve(null);
          return;
        }
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function findMenu() {
    return (
      document.querySelector('[role="menu"]') ||
      document.querySelector('[data-tbl-menu]') ||
      null
    );
  }

  async function openMenuForExtraction() {
    const more = getMoreButton();
    if (!more) return null;
    state.moreButton = more;

    const existing = findMenu();
    if (existing) {
      state.menuWasOpen = true;
      return existing;
    }

    state.menuWasOpen = false;
    // 既にサイドバー展開済みなら More は CSS で display:none のまま
    // クリックする。メニューは 0,0 に描画されるが、抽出中は透明なので
    // 見えず、ナビゲーションの高さも動かない。
    if (state.section?.isConnected || state.items.length > 0) {
      document.documentElement.setAttribute('data-tbl-sidebar', '1');
    }
    document.body.setAttribute('data-tbl-extracting', '1');
    try {
      more.click();
    } catch {
      /* ignore */
    }
    return await waitFor(findMenu, 1800);
  }

  async function closeMenu() {
    if (state.menuWasOpen) {
      state.menuWasOpen = false;
      document.body.removeAttribute('data-tbl-extracting');
      return;
    }
    try {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch {
      /* ignore */
    }
    await sleep(50);
    // Escape が効かない場合の保険
    if (findMenu()) {
      try {
        state.moreButton?.click();
      } catch {
        /* ignore */
      }
    }
    document.body.removeAttribute('data-tbl-extracting');
  }

  function extractItem(node, index) {
    if (!node) return null;
    if (node.getAttribute('role') === 'separator') return null;
    if (node.getAttribute('aria-hidden') === 'true') return null;
    if (!isDisplayed(node)) return null;

    const text = normalizeLabel(node.textContent || '');
    const dest = getDestFromFiber(node);
    const label =
      (typeof dest?.label === 'string' && dest.label.trim()) ||
      text ||
      '';
    if (!label) return null;

    const anchor = node.matches('a[href]')
      ? node
      : node.querySelector('a[href]');
    let href = anchor?.href || '';
    if (!href && dest?.href) {
      try {
        href = new URL(dest.href, location.origin).href;
      } catch {
        href = dest.href;
      }
    }
    if (!href && dest?.to) {
      try {
        let path = dest.to;
        if (dest.params) {
          for (const [key, value] of Object.entries(dest.params)) {
            path = path.replace(
              new RegExp(`\\$${escapeRegExp(key)}`, 'g'),
              String(value)
            );
          }
        }
        href = new URL(path, location.origin).href;
      } catch {
        /* ignore */
      }
    }

    const external =
      Boolean(dest?.external) ||
      (Boolean(href) &&
        !href.startsWith(location.origin) &&
        !href.startsWith('/'));

    const icon = node.querySelector('svg');
    const badge =
      dest && Number.isFinite(dest.badgeCount) && dest.badgeCount > 0
        ? dest.badgeCount >= 20
          ? '20+'
          : String(dest.badgeCount)
        : null;

    return {
      key: dest?.id || `${label}-${index}`,
      label,
      href,
      external,
      icon: icon ? icon.cloneNode(true) : null,
      badge,
      dest,
    };
  }

  async function extractItems() {
    if (state.extracting) return state.items;
    state.extracting = true;
    try {
      const menu = await openMenuForExtraction();
      if (!menu) return state.items;

      const allNodes = Array.from(
        menu.querySelectorAll('[role="menuitem"], a[href], button')
      ).filter(
        (node) =>
          !node.closest('[role="menuitem"]') ||
          node.getAttribute('role') === 'menuitem'
      );

      const items = [];
      allNodes.forEach((node, index) => {
        const item = extractItem(node, index);
        if (!item) return;
        if (
          items.some(
            (existing) =>
              existing.label === item.label && existing.href === item.href
          )
        ) {
          return;
        }
        items.push(item);
      });

      if (items.length > 0) {
        state.items = items;
        state.lastSignature = items
          .map((item) => `${item.label}|${item.href}|${item.key}`)
          .join('::');
      }
      return state.items;
    } finally {
      await closeMenu();
      state.extracting = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* native activation                                                  */
  /* ------------------------------------------------------------------ */

  function findNativeMenuItem(item) {
    const menu = findMenu();
    if (!menu) return null;
    const nodes = Array.from(
      menu.querySelectorAll('[role="menuitem"], a[href], button')
    ).filter(
      (node) =>
        !node.closest('[role="menuitem"]') ||
        node.getAttribute('role') === 'menuitem'
    );
    const normalized = normalizeLabel(item.label);
    let match = nodes.find(
      (node) =>
        isDisplayed(node) &&
        normalizeLabel(node.textContent || '') === normalized
    );
    if (!match && item.href) {
      match = nodes.find((node) => {
        if (!isDisplayed(node)) return false;
        const anchor = node.matches('a[href]')
          ? node
          : node.querySelector('a[href]');
        return anchor?.href === item.href;
      });
    }
    return match || null;
  }

  async function activateItem(item) {
    if (!item) return;
    if (item.external && item.href) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
      return;
    }

    const more = getMoreButton();
    if (!more) {
      if (item.href) location.href = item.href;
      return;
    }

    let menu = findMenu();
    if (!menu) {
      state.menuWasOpen = false;
      if (state.section?.isConnected || state.items.length > 0) {
        document.documentElement.setAttribute('data-tbl-sidebar', '1');
      }
      document.body.setAttribute('data-tbl-extracting', '1');
      more.click();
      menu = await waitFor(findMenu, 1800);
    } else {
      state.menuWasOpen = true;
    }

    const nativeItem = menu ? findNativeMenuItem(item) : null;
    if (nativeItem) {
      try {
        nativeItem.click();
      } catch {
        /* ignore */
      }
      // メニューが閉じない場合は Escape
      setTimeout(() => {
        document.body.removeAttribute('data-tbl-extracting');
        if (findMenu()) closeMenu();
        else state.menuWasOpen = false;
      }, 160);
      return;
    }

    document.body.removeAttribute('data-tbl-extracting');
    state.menuWasOpen = false;
    if (item.href) location.href = item.href;
    else log('native menu item not found', item.label);
  }

  /* ------------------------------------------------------------------ */
  /* render                                                             */
  /* ------------------------------------------------------------------ */

  function isCollapsed(nav) {
    try {
      const rect = nav?.getBoundingClientRect();
      if (!rect) return false;
      return rect.width > 0 && rect.width < 120;
    } catch {
      return false;
    }
  }

  function syncSectionWidth(section, nav) {
    if (!section || !nav) return;
    /*
     * Use the nav's content width (clientWidth), not its border box, so a
     * vertical scrollbar gutter cannot make our rows wider than X's rows.
     */
    const rect = nav.getBoundingClientRect();
    const width = nav.clientWidth || rect.width;
    if (!Number.isFinite(width) || width <= 0) return;
    section.style.width = `${Math.round(width * 100) / 100}px`;
    section.style.maxWidth = '100%';
    section.style.alignSelf = 'flex-start';
  }

  function updateCollapsed(section, nav) {
    const collapsed = isCollapsed(nav);
    const changed = state.lastCollapsed !== collapsed;
    state.lastCollapsed = collapsed;
    syncSectionWidth(section, nav);
    section.classList.toggle('is-collapsed', collapsed);
    section.querySelectorAll('.tbl-sidebar-item').forEach((item) => {
      const label = item.dataset.tblLabel || '';
      if (collapsed) item.setAttribute('title', label);
      else item.removeAttribute('title');
    });
    fitSectionHeight(section);

    /*
     * Native labels only exist while X's sidebar is expanded.  When the
     * sidebar transitions from collapsed to expanded, copy fresh metrics
     * after React has mounted them instead of relying on the startup values.
     */
    if (changed && !collapsed && section.isConnected) {
      syncLabelMetrics(section, nav);
      setTimeout(() => {
        if (
          state.section === section &&
          section.isConnected &&
          !section.classList.contains('is-collapsed')
        ) {
          syncLabelMetrics(section, nav);
        }
      }, 400);
    }
  }

  function fitSectionHeight(section) {
    if (!section) return;
    // 外側のサイドバーだけをスクロールさせる。以前のバージョンで付けた
    // inline の高さ制限が残っていても取り除く。
    section.style.removeProperty('max-height');
    section.style.removeProperty('overflow-y');
    section.style.removeProperty('overflow-x');
  }

  function directChildOf(el, ancestor) {
    let node = el;
    while (node?.parentElement && node.parentElement !== ancestor) {
      node = node.parentElement;
    }
    return node?.parentElement === ancestor ? node : null;
  }

  function findSharedColumn(nav, post) {
    let node = nav?.parentElement;
    while (node && node !== document.body) {
      if (post && node.contains(post)) return node;
      node = node.parentElement;
    }
    return nav?.parentElement || null;
  }

  function insertSection(section, nav) {
    const post = getPostButton();
    const column = findSharedColumn(nav, post);
    if (!column) return false;
    const postChild = post ? directChildOf(post, column) : null;
    if (postChild) column.insertBefore(section, postChild);
    else column.appendChild(section);
    return true;
  }

  function makeSvgFallback() {
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg'
    );
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path'
    );
    path.setAttribute(
      'd',
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z'
    );
    svg.appendChild(path);
    return svg;
  }

  function createNavItem(item, template) {
    let el;
    if (template) {
      el = template.cloneNode(true);
    } else {
      el = document.createElement('a');
      const pill = document.createElement('div');
      const iconHost = document.createElement('div');
      pill.appendChild(iconHost);
      el.appendChild(pill);
    }

    for (const attr of [
      'id',
      'data-testid',
      'aria-describedby',
      'aria-controls',
      'aria-expanded',
      'aria-haspopup',
      'aria-selected',
      'aria-current',
      'data-tbl',
    ]) {
      el.removeAttribute(attr);
    }
    el.removeAttribute('target');
    el.removeAttribute('rel');
    el.classList.add('tbl-sidebar-item');
    el.setAttribute('data-tbl-sidebar-item', '1');
    el.dataset.tblLabel = item.label;
    el.dataset.tblKey = item.key;
    el.setAttribute('aria-label', item.label);

    if (item.href) {
      el.setAttribute('href', item.href);
      if (item.external) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    } else {
      el.removeAttribute('href');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
    }

    let pill = el.firstElementChild;
    if (!pill) {
      pill = document.createElement('div');
      el.appendChild(pill);
    }
    let iconHost = Array.from(pill.children).find((child) =>
      child.querySelector('svg')
    );
    if (!iconHost) {
      iconHost = document.createElement('div');
      pill.prepend(iconHost);
    }
    for (const child of Array.from(pill.children)) {
      if (child !== iconHost) child.remove();
    }

    let svg = iconHost.querySelector('svg');
    if (!svg) {
      svg = makeSvgFallback();
      iconHost.appendChild(svg);
    }
    if (item.icon) {
      const navSvg = svg.cloneNode(false);
      for (const child of Array.from(item.icon.childNodes)) {
        navSvg.appendChild(child.cloneNode(true));
      }
      iconHost.replaceChild(navSvg, svg);
    }

    const label = document.createElement('div');
    label.className = 'tbl-sidebar-label';
    label.setAttribute('dir', 'ltr');
    label.textContent = item.label;
    pill.appendChild(label);

    for (const child of Array.from(el.children)) {
      if (child !== pill) child.remove();
    }

    if (item.badge) {
      const badge = document.createElement('span');
      badge.className = 'tbl-sidebar-badge';
      badge.textContent = item.badge;
      el.appendChild(badge);
    }

    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      activateItem(item);
    });
    el.addEventListener('keydown', (event) => {
      if (
        !item.href &&
        (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')
      ) {
        event.preventDefault();
        activateItem(item);
      }
    });

    return el;
  }

  /*
   * X only renders the visible text of sidebar rows when the sidebar is wide.
   * Our cloned rows use a plain label element, so copy the metrics of a real
   * native label whenever one is available.  This keeps the expanded "More"
   * section (font size, weight, line height, spacing) identical to Home /
   * Explore / etc. instead of relying on hard-coded approximations.
   */
  function findNativeSidebarLabel(nav, active = false) {
    if (!nav) return null;
    const links = Array.from(nav.querySelectorAll('a[href]'));
    for (const link of links) {
      if (link.closest('.tbl-sidebar-section')) continue;
      const linkActive =
        link.getAttribute('aria-current') === 'page' ||
        link.getAttribute('aria-selected') === 'true';
      const candidates = Array.from(link.querySelectorAll('div, span'));
      const label = candidates.find((el) => {
        if (el.closest('svg') || el.querySelector('svg')) return false;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 80) return false;
        const style = getComputedStyle(el);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          el.getClientRects().length > 0
        );
      });
      if (!label) continue;
      /*
       * X does not always put aria-current on the native row.  Its active row
       * is bold, so use the computed weight as a second signal.  Choosing a
       * non-bold row as the base prevents Home's active weight from being
       * copied to every expanded More row.
       */
      const weight = Number(getComputedStyle(label).fontWeight) || 400;
      const labelActive = linkActive || weight >= 650;
      if (labelActive !== Boolean(active)) continue;
      return label;
    }
    return null;
  }

  function syncLabelMetrics(section, nav) {
    try {
      // Prefer a normal (non-current) row for the base metrics.  The active
      // row may be bold, which must not be copied to every More item.
      const normalLabel = findNativeSidebarLabel(nav, false);
      const activeLabel = findNativeSidebarLabel(nav, true);
      const nativeLabel = normalLabel || activeLabel;
      if (!nativeLabel) return;
      const reference = getComputedStyle(nativeLabel);

      /*
       * X nests the visible text in a span, and CPT's "normal text font style
       * in navigation bar" option targets exactly that span:
       *
       *   nav div[dir] span { font-size: 15px; font-weight: normal }
       *
       * The outer div stays at 20px, so reading the outer div made the More
       * labels 20px while the native labels were 15px.  Read the deepest text
       * span instead, and only use the outer div for margins/direction.
       */
      const textLabel =
        Array.from(nativeLabel.querySelectorAll('span, div')).find((el) => {
          if (el.children.length > 0) return false;
          if (el.querySelector('svg')) return false;
          return Boolean((el.textContent || '').trim());
        }) || nativeLabel;
      const textReference = getComputedStyle(textLabel);

      /*
       * Follow a smaller native size (CPT / accessibility), but never let a
       * third-party stylesheet enlarge More beyond X's normal 20px maximum.
       */
      const parsedSize = Number.parseFloat(textReference.fontSize);
      const fontSize = Math.min(
        20,
        Math.max(12, Number.isFinite(parsedSize) ? parsedSize : 20)
      );
      const parsedLine =
        Number.parseFloat(textReference.lineHeight) ||
        Number.parseFloat(reference.lineHeight);
      const lineHeight = Math.min(
        24,
        Math.max(
          fontSize,
          Number.isFinite(parsedLine) ? parsedLine : fontSize * 1.2
        )
      );
      const props = [
        'marginTop',
        'marginBottom',
        'marginLeft',
        'marginRight',
        'paddingLeft',
        'paddingRight',
      ];
      const dir = nativeLabel.getAttribute('dir');
      section.querySelectorAll('.tbl-sidebar-label').forEach((label) => {
        for (const prop of props) {
          if (reference[prop]) label.style[prop] = reference[prop];
        }
        /*
         * font-weight is intentionally left to CSS (!important): the active
         * row changes via aria-current without re-running this function.
         */
        label.style.setProperty('font-size', `${fontSize}px`, 'important');
        label.style.setProperty('line-height', `${lineHeight}px`, 'important');
        if (dir) label.setAttribute('dir', dir);
      });
    } catch {
      /* ignore */
    }
  }

  function syncNavMetrics(section, nav) {
    try {
      const native =
        nav.querySelector(':scope > a[href]') ||
        nav.querySelector('a[href]');
      if (!native) return;
      const nativePill = native.firstElementChild;
      const itemStyle = getComputedStyle(native);
      const pillStyle = nativePill ? getComputedStyle(nativePill) : null;
      const itemProps = [
        'paddingTop',
        'paddingBottom',
        'paddingLeft',
        'paddingRight',
        'height',
        'minHeight',
      ];
      const pillProps = [
        'paddingTop',
        'paddingBottom',
        'paddingLeft',
        'paddingRight',
        'height',
      ];
      section.querySelectorAll('.tbl-sidebar-item').forEach((el) => {
        for (const prop of itemProps) {
          if (itemStyle[prop]) el.style[prop] = itemStyle[prop];
        }
        const pill = el.firstElementChild;
        if (pill && pillStyle) {
          for (const prop of pillProps) {
            if (pillStyle[prop]) pill.style[prop] = pillStyle[prop];
          }
        }
      });
      syncLabelMetrics(section, nav);
      syncSectionWidth(section, nav);
      fitSectionHeight(section);
    } catch {
      /* ignore */
    }
  }

  function buildSection(items, nav) {
    const section = document.createElement('div');
    section.className = 'tbl-sidebar-section';
    section.dataset.tbl = 'sidebar';
    section.setAttribute('role', 'navigation');
    section.setAttribute('aria-label', t('その他のメニュー', 'More'));

    const template =
      nav.querySelector(':scope > a[href]') || nav.querySelector('a[href]');

    for (const item of items) {
      section.appendChild(createNavItem(item, template));
    }

    updateCollapsed(section, nav);
    syncNavMetrics(section, nav);
    return section;
  }

  function applyActiveState(section) {
    if (!section) return;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    section.querySelectorAll('.tbl-sidebar-item').forEach((el) => {
      if (el.tagName !== 'A' || !el.getAttribute('href')) return;
      try {
        const url = new URL(el.getAttribute('href'), location.origin);
        const active = url.pathname.replace(/\/+$/, '') === path;
        if (active) el.setAttribute('aria-current', 'page');
        else el.removeAttribute('aria-current');
      } catch {
        /* ignore */
      }
    });
  }

  function mountSection(items, nav, more) {
    if (!items || items.length === 0) return false;
    const section = buildSection(items, nav);
    const old = state.section;
    const column = findSharedColumn(nav, getPostButton());
    if (old?.isConnected && column && old.parentElement === column) {
      try {
        old.__tblResizeObserver?.disconnect();
      } catch {
        /* ignore */
      }
      old.replaceWith(section);
    } else {
      if (old) {
        try {
          old.__tblResizeObserver?.disconnect();
        } catch {
          /* ignore */
        }
        old.remove();
      }
      if (!insertSection(section, nav)) return false;
    }

    state.section = section;
    state.moreButton = more;
    state.items = items;
    document.documentElement.setAttribute('data-tbl-sidebar', '1');
    setMoreHidden(true);
    applyActiveState(section);
    updateCollapsed(section, nav);
    syncNavMetrics(section, nav);

    // サイドバーの幅が変わったら折りたたみ表示を更新
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        updateCollapsed(section, nav);
        syncNavMetrics(section, nav);
      });
      ro.observe(nav);
      section.__tblResizeObserver = ro;
    }
    return true;
  }

  async function rebuild(force = false) {
    if (state.disabled) {
      removeSection();
      return;
    }
    const more = getMoreButton();
    if (!more) {
      // X の再描画中に More が一時的に消えることがある。ここで section を
      // 消すと復帰時にメニューを開き直すため、そのまま待つ。
      return;
    }
    const nav = getSidebarNav(more);
    if (!nav) return;

    // 既に構築済みで、More ボタンが同じなら再抽出しない
    if (
      !force &&
      state.section?.isConnected &&
      state.moreButton === more &&
      state.items.length > 0
    ) {
      document.documentElement.setAttribute('data-tbl-sidebar', '1');
      setMoreHidden(true);
      updateCollapsed(state.section, nav);
      syncNavMetrics(state.section, nav);
      applyActiveState(state.section);
      return;
    }

    // キャッシュ済みの項目がある場合、X がサイドバーを再描画しただけで
    // メニューを開き直さない。CPT 設定変更 (force) のときだけ再抽出する。
    if (!force && state.items.length > 0 && mountSection(state.items, nav, more)) {
      return;
    }

    state.moreButton = more;
    const items = await extractItems();
    if (!items || items.length === 0) {
      log('no more-menu items');
      if (state.section?.isConnected) {
        document.documentElement.setAttribute('data-tbl-sidebar', '1');
        setMoreHidden(true);
      }
      return;
    }

    mountSection(items, nav, more);
  }

  function removeSection() {
    if (state.section) {
      try {
        state.section.__tblResizeObserver?.disconnect();
      } catch {
        /* ignore */
      }
      state.section.remove();
      state.section = null;
    }
    state.lastCollapsed = null;
    document.documentElement.removeAttribute('data-tbl-sidebar');
    setMoreHidden(false);
  }

  function scheduleRefresh(force = false) {
    if (state.refreshTimer) clearTimeout(state.refreshTimer);
    const delay = !force && state.items.length > 0 ? 120 : 350;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      rebuild(force).catch((error) => log('sidebar rebuild failed', error));
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  function watchOtherExtensions() {
    // Control Panel for Twitter sends this after applying its settings.
    // Re-extracting then makes CPT's hidden menu items disappear from our
    // section as well (CPT is the source of truth).
    window.addEventListener('message', (event) => {
      const type = event.data?.type;
      if (type === 'cpftConfigChange' || type === 'cpft-config-change') {
        scheduleRefresh(true);
      }
    });
  }

  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(() => {
      if (state.disabled) return;
      // タイムラインの更新で DOM が頻繁に変わっても、ここではレイアウトを
      // 読まない。セクションが生きている間は More を CSS で隠すだけ。
      if (state.section?.isConnected) {
        document.documentElement.setAttribute('data-tbl-sidebar', '1');
        return;
      }
      scheduleRefresh(false);
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    window.addEventListener('resize', () => {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(() => scheduleRefresh(false), 300);
    });

    // ルート変更で active 表示を更新。More の中身は頻繁に変わらないので再抽出しない。
    setInterval(() => {
      if (state.disabled) return;
      if (state.section) {
        applyActiveState(state.section);
        updateCollapsed(state.section, getSidebarNav(getMoreButton()));
      }
      if (!state.section?.isConnected) scheduleRefresh(false);
    }, 1000);
  }

  function watchSettings() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.settings) return;
        const settings = changes.settings.newValue || {};
        state.disabled = settings.sidebarEnabled === false;
        if (state.disabled) removeSection();
        else scheduleRefresh(false);
      });
    } catch {
      /* ignore */
    }
  }

  async function boot() {
    try {
      const stored = await new Promise((resolve) => {
        chrome.storage.local.get(['settings'], (result) =>
          resolve(result.settings || {})
        );
      });
      state.disabled = stored.sidebarEnabled === false;
    } catch {
      /* ignore */
    }

    watchSettings();
    watchOtherExtensions();
    startObserver();

    // サイドバーが描画されるまで待つ
    const started = Date.now();
    const timer = setInterval(() => {
      const more = getMoreButton();
      if (more || Date.now() - started > 15000) {
        clearInterval(timer);
        scheduleRefresh(true);
      }
    }, 400);

    // 遅れて出てくる場合の保険
    setTimeout(() => scheduleRefresh(false), 5000);
  }

  boot();
})();
