/*
 * Контент-скрипт: кнопка «Анализ отзывов» на странице товара Ozon и панель с результатами.
 * Интерфейс живёт в Shadow DOM, чтобы стили Ozon и расширения не мешали друг другу.
 */
(function () {
  "use strict";
  if (window.__ozonReviewAnalyzer) return;
  window.__ozonReviewAnalyzer = true;

  const { analyze, SIGNALS } = window.OzonAnalyzer;
  const { productPath, productSku, fetchAllReviews } = window.OzonFetcher;

  const CACHE_PREFIX = "ora:";
  const LABEL_RU = { fake: "вероятно фейк", doubtful: "сомнительный", genuine: "похож на настоящий" };

  // ------------------------------------------------------------------- DOM

  const host = document.createElement("div");
  host.id = "ozon-review-analyzer-root";
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483646; inset: auto 0 0 auto;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL("src/panel.css")}">
    <button class="fab" hidden title="Проанализировать отзывы о товаре">
      <span class="fab-icon">★</span><span>Анализ отзывов</span>
    </button>
    <aside class="panel" hidden aria-label="Анализ отзывов">
      <header>
        <div class="h-title">Анализ отзывов</div>
        <button class="icon close" title="Закрыть">✕</button>
      </header>
      <div class="body"></div>
    </aside>`;
  const fab = shadow.querySelector(".fab");
  const panel = shadow.querySelector(".panel");
  const body = shadow.querySelector(".body");
  shadow.querySelector(".close").addEventListener("click", () => (panel.hidden = true));
  fab.addEventListener("click", () => openPanel(false));

  function mount() {
    if (!document.body) return setTimeout(mount, 200);
    document.body.appendChild(host);
  }
  mount();

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
  const fmt = (x) => (x == null ? "—" : x.toFixed(2));
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
  };

  // ------------------------------------------------------------- состояние

  let state = { path: null, running: false, controller: null };

  function currentProduct() {
    return productPath(location.pathname);
  }

  function onUrlChange() {
    const path = currentProduct();
    fab.hidden = !path;
    if (path !== state.path) {
      if (state.controller) state.controller.abort();
      state = { path, running: false, controller: null };
      if (!panel.hidden) path ? openPanel(false) : (panel.hidden = true);
    }
  }
  // Ozon — SPA: при переходе между товарами страница не перезагружается
  setInterval(onUrlChange, 800);
  onUrlChange();

  async function cacheGet(sku) {
    try {
      const r = await chrome.storage.local.get(CACHE_PREFIX + sku);
      return r[CACHE_PREFIX + sku] || null;
    } catch (_) { return null; }
  }
  async function cacheSet(sku, value) {
    try { await chrome.storage.local.set({ [CACHE_PREFIX + sku]: value }); } catch (_) { /* квота — не критично */ }
  }

  async function openPanel(forceRun) {
    const path = currentProduct();
    if (!path) return;
    panel.hidden = false;
    if (state.running) return;
    const sku = productSku(path) || path;
    const cached = forceRun ? null : await cacheGet(sku);
    if (cached && cached.reviews && cached.reviews.length) {
      renderResult(cached, true);
    } else if (forceRun) {
      run();
    } else {
      renderIntro();
    }
  }

  // ---------------------------------------------------------------- экраны

  function renderIntro() {
    body.innerHTML = `
      <p class="muted">Расширение скачает <b>все</b> отзывы о товаре, проверит каждый на признаки накрутки
      и покажет вердикт, статистику, плюсы и минусы.</p>
      <p class="muted small">Для товаров с тысячами отзывов это займёт 1–3 минуты. Вкладку можно не трогать.</p>
      <button class="primary run">Начать анализ</button>`;
    body.querySelector(".run").addEventListener("click", run);
  }

  function renderProgress(info) {
    body.innerHTML = `
      <div class="progress">
        <div class="spinner"></div>
        <div>
          <div class="p-main">Собрано отзывов: <b>${info.total}</b></div>
          <div class="muted small">страница ${info.page}</div>
        </div>
      </div>
      <div class="bar indeterminate"><span></span></div>
      <button class="secondary cancel">Остановить и проанализировать собранное</button>`;
    body.querySelector(".cancel").addEventListener("click", () => state.controller && state.controller.abort());
  }

  async function run() {
    const path = currentProduct();
    if (!path || state.running) return;
    const controller = new AbortController();
    state.running = true;
    state.controller = controller;
    renderProgress({ total: 0, page: 1 });
    let result;
    try {
      result = await fetchAllReviews(path, {
        signal: controller.signal,
        onProgress: (p) => state.controller === controller && renderProgress(p),
      });
    } catch (e) {
      result = { reviews: [], title: null, stoppedReason: String(e && e.message || e) };
    }
    if (state.controller !== controller) return; // пользователь ушёл на другой товар
    state.running = false;
    state.controller = null;

    const title = result.title || (document.querySelector("h1") || {}).textContent || document.title;
    const payload = {
      product: { title: (title || "").trim(), url: location.origin + path, sku: productSku(path) },
      reviews: result.reviews,
      fetchedAt: new Date().toISOString(),
      stoppedReason: result.stoppedReason,
    };
    if (!payload.reviews.length) {
      body.innerHTML = `
        <div class="error">
          <b>Не удалось получить отзывы.</b>
          <p>${esc(result.stoppedReason || "Ozon не вернул ни одного отзыва.")}</p>
          <p class="small">Обновите страницу (если Ozon показывал проверку «Вы не робот» — пройдите её) и попробуйте снова.
          Если ошибка повторяется, возможно, Ozon изменил формат данных.</p>
        </div>
        <button class="primary run">Попробовать снова</button>`;
      body.querySelector(".run").addEventListener("click", run);
      return;
    }
    await cacheSet(payload.product.sku || path, payload);
    renderResult(payload, false);
  }

  // -------------------------------------------------------------- результат

  function starBars(a) {
    const rows = [5, 4, 3, 2, 1].map((star) => {
      const rs = a.reviews.filter((r) => r.rating === star);
      const c = { fake: 0, doubtful: 0, genuine: 0 };
      rs.forEach((r) => c[r.fake_label]++);
      const total = a.ratings_all.count || 1;
      const seg = (k) => (c[k] ? `<span class="seg ${k}" style="width:${(c[k] / total) * 100}%" title="${LABEL_RU[k]}: ${c[k]}"></span>` : "");
      return `<div class="srow"><span class="star">${star}★</span>
        <span class="track">${seg("genuine")}${seg("doubtful")}${seg("fake")}</span>
        <span class="num">${rs.length}</span></div>`;
    });
    return `<div class="stars">${rows.join("")}</div>
      <div class="legend"><span><i class="genuine"></i>похожи на настоящие</span><span><i class="doubtful"></i>сомнительные</span><span><i class="fake"></i>вероятно фейк</span></div>`;
  }

  function monthlyChart(a) {
    const months = a.monthly.slice(-24);
    if (months.length < 2) return "";
    const max = Math.max(...months.map((m) => m.count));
    const cols = months.map((m) => {
      const h = (m.count / max) * 100;
      const fh = m.count ? (m.fake / m.count) * h : 0;
      return `<div class="mcol" title="${m.month}: ${m.count} ${plural(m.count, "отзыв", "отзыва", "отзывов")}, из них вероятно фейк ${m.fake}, средняя оценка ${m.mean}">
        <div class="mbar" style="height:${h}%"><div class="mfake" style="height:${h ? (fh / h) * 100 : 0}%"></div></div>
      </div>`;
    });
    return `<section><h3>Отзывы по месяцам</h3>
      <div class="mchart">${cols.join("")}</div>
      <div class="maxis"><span>${months[0].month}</span><span>${months[months.length - 1].month}</span></div>
      <div class="legend"><span><i class="neutral"></i>все отзывы</span><span><i class="fake"></i>вероятно фейк</span></div>
    </section>`;
  }

  function themesList(list, kind) {
    if (!list || !list.length) return `<p class="muted small">Недостаточно данных</p>`;
    return `<ul class="themes ${kind}">${list
      .map((t) => `<li><span class="t-name">${esc(t.theme)}</span><span class="t-count">${t.mentions}</span>
        ${t.example.toLowerCase() !== t.theme.toLowerCase() ? `<div class="t-ex">«${esc(t.example)}»</div>` : ""}</li>`)
      .join("")}</ul>`;
  }

  // одинаковые тексты показываем одной карточкой с пометкой «×N»
  function groupSame(list) {
    const groups = new Map();
    for (const r of list) {
      const key = [r.pros, r.cons, r.text].join(" ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const k = key || `id:${r.id}`;
      if (!groups.has(k)) groups.set(k, { ...r, same: 0 });
      groups.get(k).same++;
    }
    return [...groups.values()];
  }

  function reviewItem(r) {
    const txt = [r.pros && `<b>Достоинства:</b> ${esc(r.pros)}`, r.cons && `<b>Недостатки:</b> ${esc(r.cons)}`, r.text && esc(r.text)]
      .filter(Boolean)
      .join("<br>");
    return `<li class="rev ${r.fake_label}">
      <div class="r-head"><span class="r-score" title="Вероятность накрутки">${Math.round(r.fake_score * 100)}%</span>
        <span>${r.rating ?? "—"}★</span><span class="muted">${(r.date || "").slice(0, 10)}</span>
        <span class="muted r-author">${esc(r.author || "—")}</span>
        ${r.same > 1 ? `<span class="tag dup" title="Столько отзывов с таким же текстом">×${r.same} одинаковых</span>` : ""}
        ${r.verified_purchase === true ? `<span class="tag ok">куплен</span>` : r.verified_purchase === false ? `<span class="tag">без покупки</span>` : ""}</div>
      <div class="r-text">${txt || "<i class='muted'>без текста</i>"}</div>
      <div class="r-reasons">${r.fake_reasons.map((c) => `<span class="chip">${esc(SIGNALS[c][1])}</span>`).join("")}</div>
    </li>`;
  }

  function renderResult(payload, fromCache) {
    const a = analyze(payload.reviews);
    const v = a.verdict;
    const suspiciousAll = a.reviews.filter((r) => r.fake_label !== "genuine").sort((x, y) => y.fake_score - x.fake_score);
    const suspicious = groupSame(suspiciousAll);
    const n = a.total_reviews;
    const ratingDrop = a.ratings_all.mean != null && a.ratings_without_fake.mean != null ? a.ratings_all.mean - a.ratings_without_fake.mean : 0;

    body.innerHTML = `
      ${fromCache ? `<div class="cached muted small">Результат от ${new Date(payload.fetchedAt).toLocaleString("ru-RU")} · <a href="#" class="rerun">обновить</a></div>` : ""}
      ${payload.stoppedReason ? `<div class="warn small">Сбор остановлен (${esc(payload.stoppedReason === "cancelled" ? "по вашей команде" : payload.stoppedReason)}) — анализ по ${n} ${plural(n, "отзыву", "отзывам", "отзывам")}.</div>` : ""}

      <section class="verdict ${v.level}">
        <div class="v-top">
          <div class="v-title">${esc(v.title)}</div>
          <div class="v-score"><b>${v.score}</b><span>/100</span></div>
        </div>
        <div class="gauge"><span style="left:${v.score}%"></span></div>
        <div class="v-scale"><span>естественно</span><span>накрутка</span></div>
        <p>${esc(v.text)}</p>
      </section>

      <div class="tiles">
        <div class="tile"><div class="t-val">${n}</div><div class="t-lbl">${plural(n, "отзыв", "отзыва", "отзывов")}</div></div>
        <div class="tile fake"><div class="t-val">${pct(a.fake_share)}</div><div class="t-lbl">вероятно фейк</div></div>
        <div class="tile doubtful"><div class="t-val">${pct(a.doubtful_share)}</div><div class="t-lbl">сомнительные</div></div>
        <div class="tile"><div class="t-val">${fmt(a.ratings_all.mean)} → ${fmt(a.ratings_without_fake.mean)}</div>
          <div class="t-lbl">рейтинг без фейков${ratingDrop >= 0.05 ? ` (−${ratingDrop.toFixed(2)})` : ""}</div></div>
        ${a.verified_share != null ? `<div class="tile"><div class="t-val">${pct(a.verified_share)}</div><div class="t-lbl">с подтверждённой покупкой</div></div>` : ""}
        <div class="tile"><div class="t-val">${pct(a.with_photos_share)}</div><div class="t-lbl">с фото</div></div>
      </div>

      <section><h3>Оценки</h3>${starBars(a)}</section>

      ${a.product_signals.length ? `<section><h3>Признаки на уровне товара</h3><ul class="signals">${a.product_signals.map((s) => `<li>${esc(s.text)}</li>`).join("")}</ul></section>` : ""}

      ${a.reasons.length ? `<section><h3>Сработавшие признаки</h3><table class="reasons">${a.reasons
        .map((r) => `<tr><td>${esc(r.description)}</td><td class="num">${r.count}</td><td class="num muted">${pct(r.count / n)}</td></tr>`)
        .join("")}</table></section>` : ""}

      ${monthlyChart(a)}

      <section class="pc">
        <div><h3 class="pros-h">Плюсы</h3>${themesList(a.themes.pros, "pros")}</div>
        <div><h3 class="cons-h">Минусы</h3>${themesList(a.themes.cons, "cons")}</div>
      </section>
      <p class="muted small">Плюсы и минусы собраны только из отзывов, не похожих на фейковые. Число — сколько отзывов упоминают тему.</p>

      ${suspicious.length ? `<section><h3>Подозрительные отзывы (${suspiciousAll.length})</h3>
        <ul class="revs">${suspicious.slice(0, 15).map(reviewItem).join("")}</ul>
        ${suspicious.length > 15 ? `<button class="secondary more">Показать все ${suspicious.length}</button>` : ""}
      </section>` : ""}

      <div class="actions">
        <button class="secondary rerun-btn">Пересчитать заново</button>
        <button class="secondary export">Скачать отзывы (JSON)</button>
      </div>
      <p class="muted small foot">Оценка вероятностная: признаки указывают на возможную накрутку, но не доказывают её.</p>`;

    const rerun = (e) => { e.preventDefault(); run(); };
    body.querySelectorAll(".rerun, .rerun-btn").forEach((el) => el.addEventListener("click", rerun));
    const more = body.querySelector(".more");
    if (more) {
      more.addEventListener("click", () => {
        body.querySelector(".revs").innerHTML = suspicious.map(reviewItem).join("");
        more.remove();
      });
    }
    body.querySelector(".export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify({ product: payload.product, reviews: payload.reviews }, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ozon-reviews-${payload.product.sku || "product"}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    body.scrollTop = 0;
  }

  // ------------------------------------------------------- команды из попапа

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "ora:status") {
      sendResponse({ isProduct: Boolean(currentProduct()), running: state.running });
    } else if (msg && msg.type === "ora:open") {
      openPanel(Boolean(msg.run));
      sendResponse({ ok: true });
    }
  });
})();
