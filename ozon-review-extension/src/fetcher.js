/*
 * Сбор отзывов о товаре со страницы Ozon.
 *
 * Скрипт работает внутри открытой вкладки ozon.ru, поэтому запросы к внутреннему
 * API витрины (/api/entrypoint-api.bff/page/json/v2?url=...) идут с куками
 * пользователя и уже пройденной антибот-проверкой.
 *
 * Формат ответа Ozon меняется, поэтому парсер не привязан к конкретному виджету:
 * он рекурсивно ищет объекты, похожие на отзыв (оценка + текст + id).
 */
(function (root) {
  "use strict";

  const API_PATH = "/api/entrypoint-api.bff/page/json/v2";

  function productPath(urlOrPath) {
    const m = String(urlOrPath).match(/(\/product\/[^/?#]+)/);
    return m ? m[1].replace(/\/$/, "") + "/" : null;
  }

  function productSku(path) {
    const m = String(path || "").replace(/\/$/, "").match(/-(\d{5,})$/) || String(path || "").match(/\/(\d{5,})\/?$/);
    return m ? m[1] : null;
  }

  function reviewsPagePath(prodPath, page, sort = "published_at_desc") {
    return `${prodPath}reviews/?page=${page}&sort=${sort}`;
  }

  // ------------------------------------------------------------ нормализация

  function get(obj, ...paths) {
    for (const path of paths) {
      let cur = obj;
      let ok = true;
      for (const part of path.split(".")) {
        if (cur && typeof cur === "object" && part in cur) cur = cur[part];
        else { ok = false; break; }
      }
      const empty = cur === null || cur === undefined || cur === "" ||
        (Array.isArray(cur) && !cur.length) || (cur && typeof cur === "object" && !Array.isArray(cur) && !Object.keys(cur).length);
      if (ok && !empty) return cur;
    }
    return undefined;
  }

  function toIso(v) {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "number" || /^\d+$/.test(String(v))) {
      let ts = Number(v);
      if (ts < 1e12) ts *= 1000;
      const d = new Date(ts);
      return isNaN(d) ? null : d.toISOString();
    }
    const d = new Date(v);
    return isNaN(d) ? String(v) : d.toISOString();
  }

  function toBool(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return ["true", "1", "yes", "да"].includes(v.trim().toLowerCase());
    return null;
  }

  function looksLikeReview(d) {
    const c = d.content && typeof d.content === "object" ? d.content : {};
    const has = (o, keys) => keys.some((k) => k in o);
    return (
      (has(d, ["score", "rating"]) || has(c, ["score", "rating"])) &&
      (has(d, ["comment", "text", "positive", "negative"]) || has(c, ["comment", "text", "positive", "negative"])) &&
      has(d, ["uuid", "id", "reviewUuid", "reviewId"])
    );
  }

  function normalizeReview(d) {
    const author = d.author && typeof d.author === "object" ? d.author : {};
    const authorName = [author.firstName, author.lastName].filter(Boolean).join(" ") || author.name || d.authorName || "";
    const photos = get(d, "content.photos", "photos") || [];
    const videos = get(d, "content.videos", "videos") || [];
    let rating = get(d, "content.score", "score", "rating", "content.rating");
    rating = rating === undefined ? null : Math.round(Number(rating));
    if (!Number.isFinite(rating)) rating = null;
    return {
      id: String(get(d, "uuid", "reviewUuid", "id", "reviewId") ?? ""),
      rating,
      text: String(get(d, "content.comment", "comment", "content.text", "text") ?? ""),
      pros: String(get(d, "content.positive", "positive", "advantages") ?? ""),
      cons: String(get(d, "content.negative", "negative", "disadvantages") ?? ""),
      date: toIso(get(d, "publishedAt", "createdAt", "published_at", "created_at", "date")),
      author: String(authorName).trim(),
      author_id: String(get(d, "author.id", "author.uuid", "authorId") ?? ""),
      verified_purchase: toBool(get(d, "isItemPurchased", "isPurchased", "itemPurchased", "purchased", "isBuyer")),
      likes: Number(get(d, "usefulness.useful", "usefulness.likes", "likes", "useful") || 0),
      dislikes: Number(get(d, "usefulness.unuseful", "usefulness.dislikes", "dislikes") || 0),
      photos: Array.isArray(photos) ? photos.length : 0,
      videos: Array.isArray(videos) ? videos.length : 0,
      variant: String(get(d, "variantsInfo.title", "itemName", "variant", "sku", "itemId") ?? ""),
      seller_reply: Boolean(get(d, "comments", "answers", "sellerComment", "reply")),
    };
  }

  function extractReviews(obj) {
    const found = [];
    const walk = (node, depth) => {
      if (depth > 40 || node === null || node === undefined) return;
      if (typeof node === "string") {
        const s = node.trim();
        if (s.length > 20 && (s[0] === "{" || s[0] === "[") && (s.includes("score") || s.includes("rating"))) {
          try { walk(JSON.parse(s), depth + 1); } catch (_) { /* не JSON */ }
        }
        return;
      }
      if (Array.isArray(node)) { node.forEach((v) => walk(v, depth + 1)); return; }
      if (typeof node === "object") {
        if (looksLikeReview(node)) { found.push(normalizeReview(node)); return; }
        Object.values(node).forEach((v) => walk(v, depth + 1));
      }
    };
    walk(obj, 0);
    return found;
  }

  function extractNextPage(obj) {
    const stack = [obj];
    while (stack.length) {
      const node = stack.pop();
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if ((k === "nextPage" || k === "nextPageUrl") && typeof v === "string" && v) return v;
          stack.push(v);
        }
      } else if (typeof node === "string" && node[0] === "{" && node.includes("nextPage")) {
        try { stack.push(JSON.parse(node)); } catch (_) { /* не JSON */ }
      }
    }
    return null;
  }

  function extractTitle(obj) {
    // название товара обычно лежит в seo.title или в виджете webProductHeading
    const t = get(obj, "seo.title");
    if (t) return String(t).split(/ купить| - купить| – купить/)[0].trim();
    return null;
  }

  function dedupe(reviews) {
    const seen = new Set();
    return reviews.filter((r) => {
      const key = r.id || `${r.author}|${r.date}|${r.text.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ------------------------------------------------------- резервный способ: HTML

  /** Отзывы из data-state атрибутов (так Ozon встраивает данные виджетов в HTML). */
  function extractFromStateAttrs(root) {
    const out = [];
    const nodes = root.querySelectorAll ? root.querySelectorAll("[data-state]") : [];
    for (const el of nodes) {
      try { out.push(...extractReviews(JSON.parse(el.getAttribute("data-state")))); } catch (_) { /* не JSON */ }
    }
    return out;
  }

  function extractFromHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return extractFromStateAttrs(doc);
    } catch (_) {
      return [];
    }
  }

  // ------------------------------------------------------------------ сбор

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function apiUrl(base, innerPath) {
    return `${base}?url=${encodeURIComponent(innerPath)}`;
  }

  function relative(u) {
    try {
      const x = new URL(u, location.origin);
      return x.pathname + x.search;
    } catch (_) {
      return u;
    }
  }

  /** Ставит номер страницы в любой из известных параметров пагинации. */
  function withPage(innerPath, n) {
    const [p, q = ""] = innerPath.split("?");
    const sp = new URLSearchParams(q);
    let changed = false;
    for (const key of ["page", "layout_page_index", "reviewsPage"]) {
      if (sp.has(key)) { sp.set(key, String(n)); changed = true; }
    }
    if (!changed) return null;
    return `${p}?${sp.toString()}`;
  }

  /**
   * Запросы к API, которые уже сделала сама страница Ozon (видны в performance).
   * Если Ozon поменял формат адреса, здесь будет актуальный.
   */
  function observedReviewRequests() {
    let entries = [];
    try { entries = performance.getEntriesByType("resource").map((e) => e.name); } catch (_) { /* нет API */ }
    const out = [];
    for (const name of entries) {
      if (!/\.bff\//.test(name)) continue;
      let u;
      try { u = new URL(name, location.origin); } catch (_) { continue; }
      const inner = u.searchParams.get("url") || "";
      if (!/review|отзыв/i.test(decodeURIComponent(inner + u.search))) continue;
      out.push({ base: u.pathname, inner: inner || null, full: u.pathname + u.search });
    }
    return out;
  }

  /** Список способов получить первую страницу отзывов, от самого вероятного к запасным. */
  function strategies(prodPath) {
    const list = [];
    const seen = new Set();
    const add = (name, base, inner) => {
      const key = base + "|" + inner;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ name, base, inner });
    };
    for (const o of observedReviewRequests()) {
      if (o.inner) add("как делает сама страница", o.base, withPage(o.inner, 1) || o.inner);
    }
    const noSlash = prodPath.replace(/\/$/, "");
    add("reviews/?page", API_PATH, `${prodPath}reviews/?page=1&sort=published_at_desc`);
    add("reviews?page", API_PATH, `${noSlash}/reviews?page=1&sort=published_at_desc`);
    add("reviews/", API_PATH, `${prodPath}reviews/`);
    add("reviewshelfpaginator", API_PATH, `${prodPath}?layout_container=reviewshelfpaginator&layout_page_index=1`);
    add("composer reviews", "/api/composer-api.bff/page/json/v2", `${prodPath}reviews/?page=1`);
    add("страница товара", API_PATH, prodPath);
    return list;
  }

  async function requestJson(url, signal, log) {
    let resp = null;
    let text = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal });
        text = await resp.text();
      } catch (e) {
        if (signal && signal.aborted) throw e;
        resp = null;
      }
      // 404/400 — адрес неверный, повторять бессмысленно; 403/429/5xx/сеть — ждём и пробуем ещё раз
      if (resp && (resp.ok || resp.status === 404 || resp.status === 400)) break;
      await sleep(2000 * (attempt + 1));
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* не JSON */ }
    const entry = { url, status: resp ? resp.status : "network error", reviews: data ? extractReviews(data).length : 0 };
    if (log) log.push(entry);
    return { ok: Boolean(resp && resp.ok && data), status: entry.status, data, text };
  }

  /**
   * Скачивает все отзывы товара.
   * opts: { maxPages, delayMs, onProgress({page, total, added}), signal: AbortSignal }
   * Возвращает { reviews, title, stoppedReason, diagnostics }.
   */
  async function fetchAllReviews(prodPath, opts = {}) {
    const { maxPages = 1000, delayMs = 600, onProgress = () => {}, signal } = opts;
    const log = [];
    const all = [];
    const seen = new Set();
    let title = null;
    let lastBody = "";
    let stoppedReason = null;

    const addBatch = (batch) => {
      let added = 0;
      for (const r of batch) {
        const key = r.id || `${r.author}|${r.date}|${r.text.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(r);
        added++;
      }
      return added;
    };
    const diagnostics = () => ({
      page: location.href,
      attempts: log,
      observed: observedReviewRequests().map((o) => o.full),
      lastBody: lastBody.slice(0, 3000),
      userAgent: navigator.userAgent,
    });

    // 1. Подбираем рабочий способ получения первой страницы
    let chosen = null;
    let firstData = null;
    try {
      for (const s of strategies(prodPath)) {
        if (signal && signal.aborted) break;
        let r = await requestJson(apiUrl(s.base, s.inner), signal, log);
        lastBody = r.text || lastBody;
        // Ozon иногда отвечает редиректом внутри JSON
        const redirect = r.data && (r.data.redirectUrl || r.data.redirect || (r.data.location && String(r.data.location)));
        if (r.ok && !extractReviews(r.data).length && typeof redirect === "string") {
          const inner = relative(redirect);
          r = await requestJson(apiUrl(s.base, inner), signal, log);
          lastBody = r.text || lastBody;
          if (r.ok) s.inner = inner;
        }
        if (r.ok && !title) title = extractTitle(r.data);
        if (r.ok && extractReviews(r.data).length) {
          chosen = s;
          firstData = r.data;
          break;
        }
        await sleep(300);
      }
    } catch (e) {
      if (!(signal && signal.aborted)) throw e;
    }
    if (signal && signal.aborted) {
      return { reviews: all, title, stoppedReason: "cancelled", diagnostics: diagnostics() };
    }

    // 2. Ни один способ API не сработал — резервный: данные из HTML
    if (!chosen) {
      let html = [];
      html.push(...extractFromStateAttrs(document));
      for (const path of [`${prodPath}reviews/`, prodPath]) {
        try {
          const resp = await fetch(path, { credentials: "include", signal });
          const text = await resp.text();
          log.push({ url: path + " (HTML)", status: resp.status, reviews: extractFromHtml(text).length });
          html.push(...extractFromHtml(text));
        } catch (_) { /* пропускаем */ }
      }
      addBatch(html);
      onProgress({ page: 1, total: all.length, added: all.length });
      stoppedReason = all.length
        ? "API отзывов Ozon недоступно — показаны только отзывы, встроенные в страницу"
        : `Ozon не отдал отзывы ни одним из ${log.length} способов`;
      return { reviews: all, title, stoppedReason, diagnostics: diagnostics() };
    }

    // 3. Листаем страницы выбранным способом
    let data = firstData;
    let current = chosen.inner;
    let pageNo = 1;
    let emptyStreak = 0;
    const visited = new Set([current]);
    try {
      while (true) {
        const added = addBatch(extractReviews(data));
        onProgress({ page: pageNo, total: all.length, added });
        emptyStreak = added ? 0 : emptyStreak + 1;
        if (emptyStreak >= 3 || pageNo >= maxPages) break;

        let next = extractNextPage(data);
        next = next ? relative(next) : null;
        if (!next || visited.has(next)) next = withPage(current, pageNo + 1);
        if (!next || visited.has(next)) break;
        visited.add(next);

        if (signal && signal.aborted) { stoppedReason = "cancelled"; break; }
        await sleep(delayMs);
        const r = await requestJson(apiUrl(chosen.base, next), signal, log);
        if (!r.ok) {
          lastBody = r.text || lastBody;
          if (r.status !== 404) stoppedReason = `HTTP ${r.status} на странице ${pageNo + 1}`;
          break;
        }
        data = r.data;
        current = next;
        pageNo++;
      }
    } catch (e) {
      if (signal && signal.aborted) stoppedReason = "cancelled";
      else stoppedReason = String((e && e.message) || e);
    }
    return { reviews: dedupe(all), title, stoppedReason, diagnostics: diagnostics(), method: chosen.name };
  }

  const api = {
    productPath, productSku, reviewsPagePath, extractReviews, extractNextPage, normalizeReview,
    fetchAllReviews, dedupe, withPage, extractFromHtml,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OzonFetcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
