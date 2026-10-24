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

  // ------------------------------------------------------------------ сбор

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Скачивает все отзывы товара.
   * opts: { maxPages, delayMs, onProgress({page, total, added}), signal: AbortSignal }
   */
  async function fetchAllReviews(prodPath, opts = {}) {
    const { maxPages = 1000, delayMs = 600, onProgress = () => {}, signal } = opts;
    const all = [];
    const seen = new Set();
    let title = null;
    let next = reviewsPagePath(prodPath, 1);
    let emptyStreak = 0;
    let stoppedReason = null;

    for (let page = 1; page <= maxPages && next; page++) {
      if (signal && signal.aborted) { stoppedReason = "cancelled"; break; }
      const url = `${API_PATH}?url=${encodeURIComponent(next)}`;
      let resp = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          resp = await fetch(url, { credentials: "include", headers: { Accept: "application/json" }, signal });
        } catch (e) {
          if (signal && signal.aborted) break;
          resp = null;
        }
        if (resp && resp.ok) break;
        await sleep(2000 * (attempt + 1)); // 403/429/сеть — ждём и пробуем ещё раз
      }
      if (signal && signal.aborted) { stoppedReason = "cancelled"; break; }
      if (!resp || !resp.ok) { stoppedReason = `HTTP ${resp ? resp.status : "network error"} на странице ${page}`; break; }

      let data;
      try { data = await resp.json(); } catch (_) { stoppedReason = `ответ не JSON на странице ${page}`; break; }
      if (!title) title = extractTitle(data);

      const batch = extractReviews(data);
      let added = 0;
      for (const r of batch) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        all.push(r);
        added++;
      }
      onProgress({ page, total: all.length, added });

      emptyStreak = added ? 0 : emptyStreak + 1;
      if (emptyStreak >= 2) break;

      let nxt = extractNextPage(data);
      if (nxt) {
        try {
          const u = new URL(nxt, location.origin);
          nxt = u.pathname + u.search;
        } catch (_) { /* оставляем как есть */ }
        if (nxt === next) nxt = null; // защита от зацикливания
      }
      if (!nxt) {
        const cur = Number(new URLSearchParams(next.split("?")[1] || "").get("page") || page);
        nxt = added ? reviewsPagePath(prodPath, cur + 1) : null;
      }
      next = nxt;
      await sleep(delayMs);
    }
    return { reviews: dedupe(all), title, stoppedReason };
  }

  const api = { productPath, productSku, reviewsPagePath, extractReviews, extractNextPage, normalizeReview, fetchAllReviews, dedupe };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OzonFetcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
