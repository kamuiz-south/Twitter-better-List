/*
 * Twitter Better List - MAIN world bridge
 *
 * X の Web クライアントが内部で利用している GraphQL を監視し、
 * リスト追加/削除ダイアログのデータを ISOLATED world に渡します。
 *
 * - 有料 API は一切使いません（Web クライアント自身の通信を利用）
 * - 認証情報はページ内の fetch から一時的に借用するだけで、外部送信しません
 */
(() => {
  'use strict';

  if (window.__TBL_MAIN_WORLD__) return;
  window.__TBL_MAIN_WORLD__ = true;

  const SOURCE_MAIN = 'tbl-main';
  const SOURCE_ISOLATED = 'tbl-isolated';

  // 新 UI (x-web / Relay)
  const LIST_QUERY_ID = 'e6ctxxIXAn1ZlKNLy2X1gA';
  const LIST_QUERY_OP = 'listAddMemberSlotQuery';
  // 現行の responsive-web UI。リスト選択ダイアログはこちらを使う。
  const OWNERSHIPS_QUERY_ID = 'yj0QWid7dFucshVURQTWrA';
  const OWNERSHIPS_QUERY_OP = 'ListOwnerships';
  // /<user>/lists の一覧ページ。自分のリストを最大 100 件まとめて返す。
  const LISTS_PAGE_QUERY_OP = 'ListsManagementPageTimeline';

  const ADD_MUTATION_ID = 'JZQyz-W3Ehcl4DCXMYCaLg';
  const ADD_MUTATION_OP = 'setListMembershipAddMutation';
  const REMOVE_MUTATION_ID = 'yI4F-0PJwTaQ6tTZp4_Ihg';
  const REMOVE_MUTATION_OP = 'setListMembershipRemoveMutation';

  const LIST_QUERY_OPS = new Set([
    LIST_QUERY_OP,
    OWNERSHIPS_QUERY_OP,
    LISTS_PAGE_QUERY_OP,
  ]);

  // X Web が利用している公開 bearer。ページから取得できなかった場合のフォールバック。
  const FALLBACK_BEARER =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const AUTH_HEADER_NAMES = [
    'authorization',
    'x-csrf-token',
    'x-twitter-auth-type',
    'x-twitter-active-user',
    'x-twitter-client-language',
    'x-client-transaction-id',
    'x-client-uuid',
    'x-twitter-client-version',
    'x-twitter-active-user',
  ];

  const state = {
    viewerId: readViewerIdFromCookie(),
    authHeaders: null,
    listRequestTemplate: null,
    requestTemplates: {}, // { [operationName]: template }
    lastListQuery: null,
    lastEmitAt: 0,
  };

  const originalFetch = window.fetch;
  const XHR = window.XMLHttpRequest;

  /* ------------------------------------------------------------------ */
  /* utilities                                                          */
  /* ------------------------------------------------------------------ */

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function emit(type, payload) {
    try {
      window.postMessage(
        { __tbl: true, source: SOURCE_MAIN, type, payload },
        '*'
      );
    } catch {
      /* ignore */
    }
  }

  function readCookie(name) {
    try {
      const prefix = `${name}=`;
      const parts = document.cookie.split(';');
      for (const raw of parts) {
        const part = raw.trim();
        if (part.startsWith(prefix)) {
          return decodeURIComponent(part.slice(prefix.length));
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function readViewerIdFromCookie() {
    try {
      // twid=u%3D1234567890  (URL encoded)
      const twid = readCookie('twid');
      if (!twid) return null;
      const decoded = decodeURIComponent(twid);
      const match = decoded.match(/(?:^|&)u=(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function getFiber(el) {
    try {
      const key = Object.keys(el).find(
        (name) =>
          name.startsWith('__reactFiber$') ||
          name.startsWith('__reactInternalInstance$')
      );
      return key ? el[key] : null;
    } catch {
      return null;
    }
  }

  /*
   * The isolated content script cannot read React fiber expando properties.
   * The MAIN world can, so use the account switcher here as a second viewer
   * source when the twid cookie is unavailable.
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
          for (const user of [
            props.currentUser,
            props.loggedInUser,
            props.activeUser,
            props.delegateUser,
            props.user,
          ]) {
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

  function numericListId(value) {
    if (value == null) return null;
    const text = String(value);
    if (/^\d+$/.test(text)) return text;
    try {
      const decoded = atob(text);
      const match = decoded.match(/(\d{5,})/);
      if (match) return match[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  function listMetaFromFiber(el) {
    let fiber = getFiber(el);
    let depth = 0;
    let fallback = null;
    while (fiber && depth < 40) {
      const props = fiber.memoizedProps || fiber.pendingProps;
      if (props && typeof props === 'object') {
        const list = props.list;
        const id =
          numericListId(props.listId) ||
          numericListId(list?.id_str) ||
          numericListId(list?.rest_id) ||
          numericListId(list?.id);
        const name =
          typeof props.name === 'string'
            ? props.name
            : typeof list?.name === 'string'
              ? list.name
              : '';
        if (id && name) {
          const rawCreatedAt =
            list?.createdAt ?? list?.created_at ?? props.createdAt ?? null;
          const createdAt = Number(rawCreatedAt);
          const meta = {
            id,
            name,
            ownerId:
              extractOwnerId(list) ||
              (props.ownerId != null ? String(props.ownerId) : null),
            memberCount:
              typeof props.memberCount === 'number'
                ? props.memberCount
                : typeof list?.member_count === 'number'
                  ? list.member_count
                  : null,
            createdAt:
              Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
          };
          if (!fallback) fallback = meta;
          // Intermediate components may pass a reduced list without an owner.
          // Keep walking to the full object so the lists page can distinguish
          // lists created by other users.
          if (meta.ownerId) return meta;
        }
      }
      fiber = fiber.return;
      depth += 1;
    }
    return fallback;
  }

  function scanPageListMeta() {
    const items = [];
    const seen = new Set();
    const cells = Array.from(
      document.querySelectorAll('[data-testid="listCell"]')
    );
    cells.forEach((cell, index) => {
      const meta =
        listMetaFromFiber(cell) ||
        listMetaFromFiber(cell.closest('[data-testid="cellInnerDiv"]')) ||
        null;
      if (!meta || seen.has(meta.id)) return;
      seen.add(meta.id);
      items.push({ ...meta, index });
    });
    return items;
  }

  function safeJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function getUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return input;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch {
      /* ignore */
    }
    return null;
  }

  function isGraphQLUrl(url) {
    if (!url) return false;
    return (
      url.pathname === '/graphql' ||
      url.pathname === '/i/api/graphql' ||
      url.pathname.startsWith('/graphql/') ||
      url.pathname.startsWith('/i/api/graphql/')
    );
  }

  function getOperationInfo(url) {
    if (!url) return { queryId: null, operationName: null };
    let queryId = null;
    let operationName = null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'i' && parts[1] === 'api' && parts[2] === 'graphql') {
      queryId = parts[3] || null;
      operationName = parts[4] || null;
    } else if (parts[0] === 'graphql') {
      queryId = parts[1] || null;
      operationName = parts[2] || null;
    }

    if (!operationName) {
      operationName =
        url.searchParams.get('operationName') ||
        url.searchParams.get('op') ||
        null;
    }
    if (!queryId) {
      queryId = url.searchParams.get('queryId') || url.searchParams.get('id') || null;
    }

    // 末尾が operation 名だけの形式にも一応対応
    if (!operationName && parts.length > 0) {
      const last = parts[parts.length - 1];
      if (/^[A-Za-z][A-Za-z0-9_]*$/.test(last) && last !== 'graphql') {
        operationName = last;
      }
    }

    return { queryId, operationName };
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    try {
      new Headers(headers).forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
    } catch {
      /* ignore */
    }
    return out;
  }

  function pickAuthHeaders(headers) {
    const lower = headersToObject(headers);
    const out = {};
    for (const name of AUTH_HEADER_NAMES) {
      if (lower[name]) out[name] = lower[name];
    }
    return out;
  }

  function captureAuth(headers) {
    const picked = pickAuthHeaders(headers);
    if (Object.keys(picked).length === 0) return;
    state.authHeaders = { ...(state.authHeaders || {}), ...picked };
    if (!state.viewerId) {
      state.viewerId = readViewerIdFromCookie();
    }
  }

  function parseRequestBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') {
      const trimmed = body.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return safeJson(trimmed);
      }
      try {
        const params = new URLSearchParams(trimmed);
        const variables = params.get('variables');
        return variables ? safeJson(variables) : null;
      } catch {
        return null;
      }
    }
    if (body instanceof URLSearchParams) {
      const variables = body.get('variables');
      return variables ? safeJson(variables) : null;
    }
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const variables = body.get('variables');
      return typeof variables === 'string' ? safeJson(variables) : null;
    }
    return null;
  }

  function getVariablesFromUrl(url) {
    if (!url) return null;
    const raw = url.searchParams.get('variables');
    return raw ? safeJson(raw) : null;
  }

  function getVariables(body) {
    if (!body) return null;
    if (body.variables && typeof body.variables === 'object') return body.variables;
    if (body.variable && typeof body.variable === 'object') return body.variable;
    return null;
  }

  function normalizeHeadersForReplay() {
    const headers = new Headers();
    const captured = state.authHeaders || {};
    for (const [key, value] of Object.entries(captured)) {
      if (value) headers.set(key, value);
    }
    if (!headers.has('authorization')) {
      headers.set('authorization', `Bearer ${FALLBACK_BEARER}`);
    }
    const ct0 = readCookie('ct0');
    if (ct0) headers.set('x-csrf-token', ct0);
    if (!headers.has('x-twitter-auth-type')) {
      headers.set('x-twitter-auth-type', 'OAuth2Session');
    }
    if (!headers.has('x-twitter-active-user')) {
      headers.set('x-twitter-active-user', 'yes');
    }
    if (!headers.has('x-twitter-client-language')) {
      const lang = (document.documentElement.getAttribute('lang') || 'en')
        .split('-')[0]
        .toLowerCase();
      headers.set('x-twitter-client-language', lang || 'en');
    }
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return headers;
  }

  /* ------------------------------------------------------------------ */
  /* GraphQL response helpers                                           */
  /* ------------------------------------------------------------------ */

  function walkObject(root, visitor, maxDepth = 12) {
    const seen = new WeakSet();
    const stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);
      if (visitor(value, depth) === false) continue;
      if (depth >= maxDepth) continue;
      if (Array.isArray(value)) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
      } else {
        for (const key of Object.keys(value)) {
          stack.push({ value: value[key], depth: depth + 1 });
        }
      }
    }
  }

  function findListsSlice(root) {
    let found = null;
    walkObject(root, (value) => {
      if (found) return false;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (value.ownerships_slice && typeof value.ownerships_slice === 'object') {
        found = value.ownerships_slice;
        return false;
      }
      return;
    });
    if (found) return found;

    // alias などで ownerships_slice が消えている場合のフォールバック
    walkObject(root, (value) => {
      if (found) return false;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (
        Array.isArray(value.items) &&
        value.slice_info &&
        typeof value.slice_info === 'object'
      ) {
        found = value;
        return false;
      }
      return;
    });
    return found;
  }

  // responsive-web の ListOwnerships は
  // data.user.result.timeline.timeline.instructions[].entries[] を返す。
  function findOwnershipTimeline(root) {
    let found = null;
    walkObject(root, (value) => {
      if (found) return false;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (Array.isArray(value.instructions) && value.instructions.length > 0) {
        const hasTimelineEntry = value.instructions.some(
          (instruction) =>
            instruction &&
            Array.isArray(instruction.entries) &&
            instruction.entries.some(
              (entry) =>
                entry &&
                entry.content &&
                (entry.content.itemContent ||
                  entry.content.cursorType ||
                  entry.content.__typename === 'TimelineTimelineCursor')
            )
        );
        if (hasTimelineEntry) {
          found = value;
          return false;
        }
      }
      return;
    });
    return found;
  }

  // /<user>/lists は TimelineTimelineModule の中にリストを並べる。
  // 「新しいリストを見つける」と「自分のリスト」が別モジュールなので、
  // 一覧ページ用のタイムラインだけを別に検出する。
  function findListsManagementTimeline(root) {
    let found = null;
    walkObject(root, (value) => {
      if (found) return false;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      if (!Array.isArray(value.instructions)) return;
      const hasModule = value.instructions.some(
        (instruction) =>
          instruction &&
          Array.isArray(instruction.entries) &&
          instruction.entries.some((entry) => {
            const content = entry && entry.content;
            if (
              !content ||
              content.__typename !== 'TimelineTimelineModule' ||
              !Array.isArray(content.items)
            ) {
              return false;
            }
            const header = String(content.header?.text || '').trim();
            const owned =
              content.clientEventInfo?.component ===
                'suggest_owned_subscribed_list' ||
              /^(自分のリスト|Your lists?)$/i.test(header);
            return (
              owned &&
              content.items.some(
                (item) =>
                  item?.item?.itemContent?.list ||
                  item?.itemContent?.list
              )
            );
          })
      );
      if (hasModule) {
        found = value;
        return false;
      }
      return;
    });
    return found;
  }

  function normalizeListsManagementTimeline(timeline) {
    const items = [];
    if (!timeline || !Array.isArray(timeline.instructions)) {
      return { items, nextCursor: null };
    }
    for (const instruction of timeline.instructions) {
      if (!instruction || !Array.isArray(instruction.entries)) continue;
      for (const entry of instruction.entries) {
        const content = entry && entry.content;
        if (
          !content ||
          content.__typename !== 'TimelineTimelineModule' ||
          !Array.isArray(content.items)
        ) {
          continue;
        }
        const header = String(content.header?.text || '');
        const component = content.clientEventInfo?.component;
        const owned =
          component === 'suggest_owned_subscribed_list' ||
          /^(自分のリスト|Your lists?)$/i.test(header.trim());
        if (!owned) continue;

        for (const moduleItem of content.items) {
          const list =
            moduleItem?.item?.itemContent?.list ||
            moduleItem?.itemContent?.list ||
            moduleItem?.item?.value?.list ||
            null;
          const normalized = normalizeList(list);
          if (normalized) items.push(normalized);
        }
      }
    }
    return { items, nextCursor: null, terminated: true };
  }

  function normalizeTimeline(timeline) {
    const items = [];
    let nextCursor = null;
    let terminated = false;
    if (!timeline || !Array.isArray(timeline.instructions)) {
      return { items, nextCursor, terminated };
    }
    for (const instruction of timeline.instructions) {
      if (!instruction) continue;
      const instructionType =
        instruction.__typename || instruction.type || instruction.typename || '';
      if (
        /TimelineTerminateTimeline/i.test(String(instructionType)) &&
        !/top/i.test(String(instruction.direction || ''))
      ) {
        terminated = true;
        continue;
      }
      if (!Array.isArray(instruction.entries)) continue;
      for (const entry of instruction.entries) {
        const content = entry && entry.content;
        if (!content || typeof content !== 'object') continue;
        if (
          content.__typename === 'TimelineTimelineCursor' ||
          content.cursorType
        ) {
          if (content.cursorType === 'Bottom' && content.value != null) {
            nextCursor = String(content.value);
          }
          continue;
        }
        const list =
          content.itemContent?.list ||
          content.itemContent?.value?.list ||
          null;
        if (!list || typeof list !== 'object') continue;
        const normalized = normalizeList(list);
        if (normalized) items.push(normalized);
      }
    }
    return { items, nextCursor, terminated };
  }

  function extractOwnerId(list) {
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

  function normalizeList(list) {
    if (!list || typeof list !== 'object') return null;
    const id =
      list.id_str != null
        ? String(list.id_str)
        : list.rest_id != null
          ? String(list.rest_id)
          : list.id != null
            ? String(list.id)
            : null;
    if (!id) return null;
    const createdAt =
      typeof list.created_at === 'number'
        ? list.created_at
        : Number.isFinite(Number(list.created_at)) && list.created_at !== ''
          ? Number(list.created_at)
          : null;
    return {
      id,
      name: typeof list.name === 'string' ? list.name : '',
      // Lists on the viewer's own page can be owned by other users (followed
      // lists).  Keep the owner separately so the page can apply its default
      // tag without confusing it with the list's member state.
      ownerId: extractOwnerId(list),
      accessibility: list.accessibility || null,
      mode: typeof list.mode === 'string' ? list.mode : null,
      memberCount:
        typeof list.member_count === 'number' ? list.member_count : null,
      isMember: typeof list.is_member === 'boolean' ? list.is_member : null,
      createdAt,
      bannerUrl: extractBannerUrl(list),
    };
  }

  function extractBannerUrl(list) {
    try {
      return (
        list.custom_banner_media_results?.result?.media?.media_info?.image
          ?.original_img_url ||
        list.default_banner_media_results?.result?.media?.media_info?.image
          ?.original_img_url ||
        list.default_banner_media?.media_info?.image?.original_img_url ||
        list.default_banner_media?.media_info?.original_img_url ||
        list.default_banner_media_results?.result?.media?.media_info
          ?.original_img_url ||
        null
      );
    } catch {
      return null;
    }
  }

  function normalizeSlice(slice) {
    if (!slice || typeof slice !== 'object') {
      return { items: [], nextCursor: null };
    }
    const rawItems = Array.isArray(slice.items) ? slice.items : [];
    const items = [];
    for (const raw of rawItems) {
      const list = raw && typeof raw === 'object' ? raw.list || raw : raw;
      const normalized = normalizeList(list);
      if (normalized) items.push(normalized);
    }
    const nextCursor =
      slice.slice_info?.next_cursor ??
      slice.next_cursor ??
      null;
    return {
      items,
      nextCursor: nextCursor == null ? null : String(nextCursor),
      terminated: false,
    };
  }

  function readTargetUserId(variables) {
    if (!variables) return null;
    return (
      variables.isListMemberTargetUserId ??
      variables.is_list_member_target_user_id ??
      variables.targetUserId ??
      variables.target_user_id ??
      variables.userId ??
      variables.user_id ??
      null
    );
  }

  function readViewerId(variables, operationName = null) {
    if (!variables) return null;
    const direct =
      variables.viewerId ??
      variables.viewer_id ??
      variables.viewerUserId ??
      variables.viewer_user_id ??
      null;
    if (direct != null) return direct;
    // ListOwnerships だけは userId が閲覧者自身。listAddMemberSlotQuery
    // などでは userId が「追加対象」なので、閲覧者として使ってはいけない。
    if (operationName === OWNERSHIPS_QUERY_OP) {
      return variables.userId ?? variables.user_id ?? null;
    }
    return null;
  }

  function handleListQuery(data, requestInfo) {
    const listsPageTimeline = findListsManagementTimeline(data);
    const ownershipTimeline = listsPageTimeline
      ? null
      : findOwnershipTimeline(data);
    const slice =
      listsPageTimeline || ownershipTimeline ? null : findListsSlice(data);
    if (!slice && !ownershipTimeline && !listsPageTimeline) return;

    const normalized = listsPageTimeline
      ? normalizeListsManagementTimeline(listsPageTimeline)
      : ownershipTimeline
        ? normalizeTimeline(ownershipTimeline)
        : normalizeSlice(slice);
    const variables = requestInfo.variables || {};
    const userId = readTargetUserId(variables);
    const viewerId =
      readViewerIdFromCookie() ||
      readViewerId(variables, requestInfo.operationName) ||
      state.viewerId ||
      null;

    if (viewerId) state.viewerId = viewerId;

    const payload = {
      userId,
      viewerId,
      cursor: variables.cursor ?? null,
      requestedCount:
        typeof variables.count === 'number' ? variables.count : null,
      items: normalized.items,
      nextCursor: normalized.nextCursor,
      terminated: Boolean(normalized.terminated),
      ended: Boolean(
        listsPageTimeline || normalized.terminated || normalized.nextCursor == null
      ),
      source: listsPageTimeline
        ? LISTS_PAGE_QUERY_OP
        : ownershipTimeline
          ? OWNERSHIPS_QUERY_OP
          : LIST_QUERY_OP,
      // ListsManagementPageTimeline は count=100 で自分のリストを一括返す。
      // レスポンス全体がそのまま現在のリスト一覧になる。
      complete: Boolean(listsPageTimeline),
      requestUrl: requestInfo.url,
      receivedAt: Date.now(),
    };

    state.lastListQuery = payload;
    state.lastEmitAt = Date.now();
    emit('list-query', payload);
  }

  function handleMutation(data, requestInfo) {
    const operation = requestInfo.operationName;
    const variables = requestInfo.variables || {};
    const listId = variables.listId ?? variables.list_id ?? null;
    const userId = variables.userId ?? variables.user_id ?? null;
    let success = false;
    let typename = null;

    try {
      const add = data?.data?.list_member_add_v4;
      const remove = data?.data?.list_member_remove_v3 ?? data?.list_member_remove_v3;
      if (add) {
        typename = add.__typename || null;
        success = typename === 'AddListMemberSuccessResult';
      } else if (remove) {
        typename = remove.__typename || null;
        success = true;
      } else {
        // Relay の data が直接入っている場合
        const root = data?.data || data;
        if (root?.list_member_add_v4) {
          typename = root.list_member_add_v4.__typename || null;
          success = typename === 'AddListMemberSuccessResult';
        } else if (root?.list_member_remove_v3) {
          typename = root.list_member_remove_v3.__typename || null;
          success = true;
        }
      }
    } catch {
      /* ignore */
    }

    emit('list-mutation', {
      operation,
      listId: listId == null ? null : String(listId),
      userId: userId == null ? null : String(userId),
      success,
      typename,
      receivedAt: Date.now(),
    });
  }

  function handleGraphQLResponse(requestInfo, json) {
    if (!json || typeof json !== 'object') return;
    const op = requestInfo.operationName;

    if (LIST_QUERY_OPS.has(op)) {
      handleListQuery(json, requestInfo);
      return;
    }
    if (op === ADD_MUTATION_OP || op === REMOVE_MUTATION_OP) {
      handleMutation(json, requestInfo);
      return;
    }

    // operation 名が取れなかった場合でも、レスポンス形状からリストクエリを検出する
    if (!op) {
      if (
        findListsManagementTimeline(json) ||
        findOwnershipTimeline(json) ||
        findListsSlice(json)
      ) {
        handleListQuery(json, requestInfo);
      }
    }
  }

  function rememberListRequest(requestInfo) {
    if (!LIST_QUERY_OPS.has(requestInfo.operationName)) return;
    const template = {
      url: requestInfo.url,
      method: requestInfo.method,
      headers: requestInfo.headers,
      body: requestInfo.body,
      variables: requestInfo.variables,
      operationName: requestInfo.operationName,
      queryId: requestInfo.queryId,
    };
    // 一覧ページ用のクエリは add/remove ダイアログの再取得には使わない。
    if (requestInfo.operationName !== LISTS_PAGE_QUERY_OP) {
      state.listRequestTemplate = template;
    }
    state.requestTemplates[requestInfo.operationName] = template;
    if (requestInfo.variables) {
      const viewerId =
        readViewerIdFromCookie() ||
        readViewerId(requestInfo.variables, requestInfo.operationName) ||
        state.viewerId;
      if (viewerId) state.viewerId = viewerId;
    }
  }

  /* ------------------------------------------------------------------ */
  /* fetch hook                                                         */
  /* ------------------------------------------------------------------ */

  async function readRequestBody(input, init) {
    try {
      if (init && init.body != null) {
        if (typeof init.body === 'string') return init.body;
        if (init.body instanceof URLSearchParams) return init.body.toString();
        if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
          const params = new URLSearchParams();
          init.body.forEach((value, key) => params.set(key, String(value)));
          return params.toString();
        }
      }
      if (input && typeof input === 'object' && typeof input.clone === 'function') {
        return await input.clone().text();
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /*
   * X asks ListOwnerships for 20 rows per page.  A viewer with a complete
   * cache usually has more than 20 lists, so the dialog needs 2-3 round trips
   * even though the extension is not fetching anything else.  Ask the native
   * endpoint for a full page in one request; X still renders and owns the
   * rows, checkboxes and Save mutation.
   */
  const LIST_OWNERSHIPS_PAGE_SIZE = 100;

  function boostListOwnershipsUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl), location.href);
      if (getOperationInfo(url).operationName !== OWNERSHIPS_QUERY_OP) {
        return rawUrl;
      }
      const variables = getVariablesFromUrl(url);
      if (!variables || typeof variables !== 'object') return rawUrl;
      const count = Number(variables.count);
      if (Number.isFinite(count) && count >= LIST_OWNERSHIPS_PAGE_SIZE) {
        return rawUrl;
      }
      variables.count = LIST_OWNERSHIPS_PAGE_SIZE;
      url.searchParams.set('variables', JSON.stringify(variables));
      return url.toString();
    } catch {
      return rawUrl;
    }
  }

  function boostListOwnershipsPageSize(input, init, requestInfo) {
    if (!requestInfo || requestInfo.operationName !== OWNERSHIPS_QUERY_OP) {
      return null;
    }

    if (requestInfo.method === 'GET') {
      const raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input?.url || null;
      const boosted = boostListOwnershipsUrl(raw);
      if (!boosted || boosted === raw) return null;
      // X sometimes passes a Request object rather than a URL string.
      if (input && typeof input === 'object' && !(input instanceof URL)) {
        try {
          return { input: new Request(boosted, input), init };
        } catch {
          return null;
        }
      }
      return { input: boosted, init };
    }

    // POST/JSON is the fallback shape used by some X builds.
    if (!init || typeof init.body !== 'string') return null;
    try {
      const body = safeJson(init.body);
      const variables = getVariables(body);
      if (!variables || typeof variables !== 'object') return null;
      const count = Number(variables.count);
      if (Number.isFinite(count) && count >= LIST_OWNERSHIPS_PAGE_SIZE) {
        return null;
      }
      variables.count = LIST_OWNERSHIPS_PAGE_SIZE;
      return {
        input,
        init: { ...init, body: JSON.stringify({ ...body, variables }) },
      };
    } catch {
      return null;
    }
  }

  function buildRequestInfo(url, method, headers, bodyText, variablesFromUrl) {
    const opInfo = getOperationInfo(url);
    const parsedBody = safeJson(bodyText);
    const variables =
      getVariables(parsedBody) ||
      variablesFromUrl ||
      null;
    return {
      url: url ? url.href : '',
      method,
      headers: headersToObject(headers),
      body: bodyText,
      variables,
      queryId: opInfo.queryId,
      operationName: opInfo.operationName,
    };
  }

  window.fetch = async function tblFetch(input, init) {
    let requestInfo = null;
    try {
      const url = getUrl(input);
      if (isGraphQLUrl(url)) {
        const method = String(
          (init && init.method) || (input && input.method) || 'GET'
        ).toUpperCase();
        const headers = new Headers(
          (init && init.headers) || (input && input.headers) || undefined
        );
        captureAuth(headers);
        const variablesFromUrl = getVariablesFromUrl(url);
        const bodyText = method === 'GET' ? null : await readRequestBody(input, init);
        requestInfo = buildRequestInfo(
          url,
          method,
          headers,
          bodyText,
          variablesFromUrl
        );
        rememberListRequest(requestInfo);
      }
    } catch {
      /* ignore */
    }

    const boosted = boostListOwnershipsPageSize(input, init, requestInfo);
    const response = boosted
      ? await originalFetch.call(this, boosted.input, boosted.init)
      : await originalFetch.apply(this, arguments);

    if (requestInfo) {
      try {
        response
          .clone()
          .json()
          .then((json) => handleGraphQLResponse(requestInfo, json))
          .catch(() => {});
      } catch {
        /* ignore */
      }
    }

    return response;
  };

  /* ------------------------------------------------------------------ */
  /* XHR hook (保険)                                                     */
  /* ------------------------------------------------------------------ */

  if (XHR && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function tblXhrOpen(method, url, ...rest) {
      let nextUrl = url;
      try {
        // Some X builds use XHR for GraphQL.  Boost the native list dialog
        // request here as well so it also loads 100 rows per page.
        nextUrl = boostListOwnershipsUrl(String(url || ''));
        this.__tblRequest = {
          method: String(method || 'GET').toUpperCase(),
          url: String(nextUrl || ''),
        };
      } catch {
        /* ignore */
      }
      return originalOpen.call(this, method, nextUrl, ...rest);
    };

    XHR.prototype.send = function tblXhrSend(body) {
      try {
        const meta = this.__tblRequest;
        if (meta) {
          const url = new URL(meta.url, location.href);
          if (isGraphQLUrl(url)) {
            const headers = new Headers();
            // setRequestHeader はフックできないため、取得できる範囲で構築
            const authHeaders = state.authHeaders || {};
            for (const [key, value] of Object.entries(authHeaders)) {
              headers.set(key, value);
            }
            const variablesFromUrl = getVariablesFromUrl(url);
            const bodyText = typeof body === 'string' ? body : null;
            const requestInfo = buildRequestInfo(
              url,
              meta.method,
              headers,
              bodyText,
              variablesFromUrl
            );
            rememberListRequest(requestInfo);
            this.addEventListener('load', () => {
              try {
                const text = this.responseType === 'json'
                  ? JSON.stringify(this.response)
                  : this.responseText;
                const json = safeJson(text);
                if (json) handleGraphQLResponse(requestInfo, json);
              } catch {
                /* ignore */
              }
            });
          }
        }
      } catch {
        /* ignore */
      }
      return originalSend.call(this, body);
    };
  }

  /* ------------------------------------------------------------------ */
  /* background fetch-all                                              */
  /* ------------------------------------------------------------------ */

  function buildQueryUrl(template, operationName) {
    const queryId =
      operationName === OWNERSHIPS_QUERY_OP
        ? OWNERSHIPS_QUERY_ID
        : LIST_QUERY_ID;
    const url = new URL(
      template?.url || `/i/api/graphql/${queryId}/${operationName || LIST_QUERY_OP}`,
      location.origin
    );
    if (!url.pathname.includes('/graphql')) {
      url.pathname = `/i/api/graphql/${queryId}/${operationName || LIST_QUERY_OP}`;
    }
    return url;
  }

  function buildQueryBody(template, variables) {
    const base = safeJson(template?.body);
    if (base && typeof base === 'object') {
      return JSON.stringify({ ...base, variables });
    }
    return JSON.stringify({ variables });
  }

  function buildQueryVariables(template, { operationName, userId, viewerId, cursor }) {
    const base =
      template?.variables && typeof template.variables === 'object'
        ? template.variables
        : {};
    if (operationName === OWNERSHIPS_QUERY_OP) {
      // ListOwnerships: userId = 閲覧者 / isListMemberTargetUserId = 対象ユーザー
      const variables = {
        ...base,
        userId: viewerId,
        isListMemberTargetUserId: userId,
        count:
          typeof base.count === 'number' && base.count > 0 ? base.count : 100,
      };
      if (cursor) variables.cursor = cursor;
      else delete variables.cursor;
      return variables;
    }
    return { ...base, cursor: cursor ?? null, userId, viewerId };
  }

  async function requestListPage({ userId, viewerId, cursor }) {
    const template =
      state.requestTemplates[OWNERSHIPS_QUERY_OP] ||
      state.requestTemplates[LIST_QUERY_OP] ||
      state.listRequestTemplate;
    const operationName =
      template?.operationName ||
      (template && template.url && template.url.includes(OWNERSHIPS_QUERY_OP)
        ? OWNERSHIPS_QUERY_OP
        : LIST_QUERY_OP);
    const method = (
      template?.method ||
      (operationName === OWNERSHIPS_QUERY_OP ? 'GET' : 'POST')
    ).toUpperCase();
    const url = buildQueryUrl(template, operationName);
    const headers = normalizeHeadersForReplay();
    const variables = buildQueryVariables(template, {
      operationName,
      userId,
      viewerId,
      cursor,
    });

    let response;
    if (method === 'GET') {
      url.searchParams.set('variables', JSON.stringify(variables));
      response = await originalFetch.call(window, url.href, {
        method: 'GET',
        headers,
        credentials: 'include',
      });
    } else {
      response = await originalFetch.call(window, url.href, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: buildQueryBody(template, variables),
      });
    }

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        json?.errors?.map((e) => e.message).filter(Boolean).join(' / ') ||
        `HTTP ${response.status}`;
      throw new Error(message);
    }
    if (!json) throw new Error('Empty response');
    // ListOwnerships は部分的な DecodeException を errors に含むことがあるが、
    // data が取れていれば続行する。
    if (Array.isArray(json.errors) && json.errors.length > 0 && !json.data) {
      throw new Error(
        json.errors.map((e) => e.message).filter(Boolean).join(' / ')
      );
    }
    return {
      json,
      requestedCount:
        typeof variables.count === 'number' && variables.count > 0
          ? variables.count
          : null,
    };
  }

  async function fetchAllLists({ requestId, userId, viewerId, maxPages = 100 }) {
    const targetUserId = userId || null;
    const viewer = viewerId || state.viewerId || readViewerIdFromCookie();
    if (!targetUserId) {
      emit('lists-result', {
        requestId,
        ok: false,
        error: 'userId が取得できませんでした',
        items: [],
      });
      return;
    }
    if (!viewer) {
      emit('lists-result', {
        requestId,
        ok: false,
        error: 'ログイン情報を取得できませんでした',
        items: [],
      });
      return;
    }

    const items = [];
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    let nextCursor = null;

    try {
      do {
        const { json } = await requestListPage({
          userId: targetUserId,
          viewerId: viewer,
          cursor,
        });
        const timeline = findOwnershipTimeline(json);
        const slice = timeline ? null : findListsSlice(json);
        if (!slice && !timeline) {
          throw new Error('リストデータが見つかりませんでした');
        }
        const normalized = timeline
          ? normalizeTimeline(timeline)
          : normalizeSlice(slice);
        let added = 0;
        for (const item of normalized.items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            items.push(item);
            added += 1;
          }
        }
        nextCursor = normalized.terminated ? null : normalized.nextCursor;
        cursor = nextCursor;
        pages += 1;
        emit('lists-progress', {
          requestId,
          loaded: items.length,
          pages,
          cursor,
          done: !cursor || added === 0,
        });
        /*
         * Do not treat a short first page as the end.  X can return fewer
         * than the requested `count` while still supplying a Bottom cursor
         * (for example count=100 but a 20-item page).  Doing so used to mark a
         * partial cache as complete and made the extension re-fetch on every
         * open.  The Bottom cursor / an empty next page is the reliable end.
         */
        if (added === 0) {
          nextCursor = null;
          break;
        }
        if (cursor) await sleep(150 + Math.floor(Math.random() * 200));
      } while (cursor && pages < maxPages);
    } catch (error) {
      emit('lists-result', {
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        items,
        pages,
      });
      return;
    }

    emit('lists-result', {
      requestId,
      ok: true,
      items,
      pages,
      viewerId: viewer,
      userId: targetUserId,
      truncated: Boolean(nextCursor),
    });
  }

  /* ------------------------------------------------------------------ */
  /* isolated world bridge                                              */
  /* ------------------------------------------------------------------ */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__tbl !== true || data.source !== SOURCE_ISOLATED) return;

    try {
      if (data.type === 'hello') {
        const domViewer = readViewerIdFromAccountSwitcher();
        if (domViewer) state.viewerId = domViewer;
        const viewerId =
          domViewer || readViewerIdFromCookie() || state.viewerId || null;
        emit('state', {
          viewerId,
          viewerTrusted: Boolean(viewerId),
          hasAuth: Boolean(state.authHeaders || readCookie('ct0')),
          operation: state.lastListQuery ? LIST_QUERY_OP : null,
        });
        if (state.lastListQuery) {
          emit('list-query', state.lastListQuery);
        }
        return;
      }

      if (data.type === 'read-list-page') {
        emit('list-page-meta', {
          requestId: data.payload?.requestId || null,
          items: scanPageListMeta(),
        });
        return;
      }

      if (data.type === 'fetch-all-lists') {
        const payload = data.payload || {};
        fetchAllLists(payload);
        return;
      }

      if (data.type === 'ping') {
        emit('pong', { at: Date.now() });
      }
    } catch (error) {
      emit('bridge-error', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // ページ側の初期化が終わったことを知らせる
  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        const domViewer = readViewerIdFromAccountSwitcher();
        state.viewerId =
          domViewer || state.viewerId || readViewerIdFromCookie();
        emit('state', {
          viewerId: state.viewerId,
          viewerTrusted: Boolean(state.viewerId),
          hasAuth: Boolean(state.authHeaders || readCookie('ct0')),
        });
      },
      { once: true }
    );
  } else {
    const domViewer = readViewerIdFromAccountSwitcher();
    state.viewerId =
      domViewer || state.viewerId || readViewerIdFromCookie();
    emit('state', {
      viewerId: state.viewerId,
      viewerTrusted: Boolean(state.viewerId),
      hasAuth: Boolean(state.authHeaders || readCookie('ct0')),
    });
  }
})();
