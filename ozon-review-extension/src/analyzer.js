/*
 * Эвристический анализ отзывов Ozon: признаки накрутки, доля подозрительных,
 * итоговый вердикт, плюсы и минусы.
 *
 * Каждый отзыв проверяется набором независимых признаков. У признака есть вес;
 * итоговая оценка считается как noisy-OR: score = 1 - Π(1 - w_i).
 *   score >= 0.50 — «вероятно фейк», 0.30..0.50 — «сомнительный», иначе — «похож на настоящий».
 */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- лексиконы

  const TEMPLATE_PHRASES = [
    "всем рекомендую", "рекомендую к покупке", "советую к покупке", "всем советую",
    "качество на высоте", "качество отличное", "отличное качество", "цена[- ]качество",
    "соответствует описанию", "соответствует заявленному", "как на фото", "как на картинке",
    "быстрая доставка", "доставка быстрая", "пришло быстро", "пришел быстро", "пришёл быстро",
    "продавцу спасибо", "спасибо продавцу", "буду заказывать ещё", "буду заказывать еще",
    "буду брать ещё", "буду брать еще", "лучший товар", "не пожалела?", "не пожалеете",
    "товар супер", "всё супер", "все супер", "всё отлично", "все отлично", "очень довольн",
    "покупкой довольн", "упакован[оа]? (?:хорошо|отлично|надежно|надёжно)", "шикарн", "восторг",
    "лучше не найти", "берите не пожалеете", "однозначно рекомендую", "5 из 5", "10 из 10",
  ];
  const TEMPLATE_RE = new RegExp(TEMPLATE_PHRASES.join("|"), "gi");

  const INCENTIVE_RE = new RegExp(
    "за баллы|отзыв за балл|баллы за отзыв|за отзыв|кешб[эе]к|кэшб[эе]к|получил[аи]? бесплатно|" +
      "бесплатно в обмен|по акции за отзыв|вернули деньги за отзыв|за вознаграждение",
    "i"
  );

  const HIDDEN_AUTHOR_RE = /скрыл|аноним|покупатель ozon|пользователь|^$/i;

  const POS_WORDS = [
    "отличн", "хорош", "супер", "класс", "прекрасн", "замечательн", "довол", "нрав", "рекоменд",
    "удобн", "качествен", "лучш", "идеальн", "шикарн", "восторг", "великолепн", "надежн", "надёжн",
    "приятн", "красив", "мягк", "быстр", "спасибо", "порадова", "понрав", "работает", "советую",
    "вкусн", "свеж", "хруст", "аромат",
  ];
  const NEG_WORDS = [
    "плох", "ужас", "брак", "сломал", "слома", "не работ", "разочаров", "верн", "возврат", "кошмар",
    "отвратит", "дешев", "дешёв", "хлипк", "некачеств", "обман", "подделк", "фальшив", "не соответ",
    "не рекоменд", "не советую", "порван", "треснул", "запах", "воняет", "вонь", "мал", "велик",
    "жаль", "развалил", "отклеил", "протек", "царапин", "не пришл", "не то", "деньги на ветер",
    "невкусн", "просроч", "горьк", "прогорк", "черств", "чёрств", "пересол", "мало ",
  ];
  const NEGATION_POS_RE = /(?<![\p{L}])не\s+(отличн|хорош|рекоменд|советую|довол|нрав|удобн|качествен|вкусн)/giu;

  const STOPWORDS = new Set(
    `и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по только ее её мне
    было вот от меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до
    вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их
    чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой
    совсем ним здесь этом один почти мой тем чтобы нее неё сейчас были куда зачем всех никогда можно при
    наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту
    моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между
    это очень весь вообще просто товар товара товаром товаре штука вещь вещи также которые который которая
    нет минусов минусы плюсы плюс достоинства недостатки пока выявлено нету обнаружено замечено нашла нашел
    нашёл заметил заметила вроде целом пару своих свои своей`.split(/\s+/)
  );

  const NO_CONS_RE = new RegExp(
    "^\\s*(нет|нету|нет? выявлен\\S*|не обнаружен\\S*|не нашл?[аи]?|не заметил[аи]?|пока нет|" +
      "пока не выявлен\\S*|отсутствуют|их нет|-+|—|\\.+|0|нет недостатков|минусов нет)[\\s\\p{P}]*$",
    "iu"
  );

  const WORD_RE = /[a-zа-яё0-9]+/gi;
  const EMOJI_RE = /[\u{1F300}-\u{1FAFF}☀-➿]/gu;

  const SIGNALS = {
    duplicate: [0.45, "почти дословно совпадает с другим отзывом"],
    same_author: [0.3, "у автора несколько отзывов на этот товар"],
    unverified: [0.25, "нет отметки о покупке товара"],
    short_generic: [0.25, "5★ и очень короткий текст без конкретики"],
    template: [0.2, "набор шаблонных рекламных фраз"],
    burst: [0.2, "опубликован во всплеске 5★-отзывов за один день"],
    incentive: [0.2, "отзыв за вознаграждение (баллы/кешбэк)"],
    mismatch: [0.2, "оценка противоречит тексту"],
    no_cons_superlatives: [0.15, "только похвала, минусов «нет», без деталей"],
    emotional: [0.1, "избыток восклицаний/капса/эмодзи"],
    hidden_author: [0.05, "автор скрыт / безымянный"],
  };

  // ---------------------------------------------------------------- утилиты

  const words = (s) => (String(s || "").match(WORD_RE) || []).map((w) => w.toLowerCase().replace(/ё/g, "е"));
  const fullText = (r) => [r.pros, r.cons, r.text].filter((p) => p && p.trim()).join("\n");
  const countMatches = (re, s) => (String(s || "").match(re) || []).length;

  const SUFFIXES = [
    "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ее", "ие", "ые", "ое", "ей",
    "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ов", "ев",
    "ах", "ях", "ия", "ья", "ть", "ла", "ло", "ли", "ет", "ут", "ют", "ит", "ат", "ят",
    "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й",
  ];
  function stem(word) {
    const w = word.toLowerCase().replace(/ё/g, "е");
    if (w.length <= 4) return w;
    for (const suf of SUFFIXES) {
      if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
    }
    return w;
  }

  function countSub(t, sub) {
    let n = 0, i = 0;
    while ((i = t.indexOf(sub, i)) !== -1) { n++; i += sub.length; }
    return n;
  }

  function sentiment(text) {
    const t = String(text || "").toLowerCase().replace(/ё/g, "е");
    if (!t.trim()) return 0;
    let pos = POS_WORDS.reduce((a, w) => a + countSub(t, w.replace(/ё/g, "е")), 0);
    let neg = NEG_WORDS.reduce((a, w) => a + countSub(t, w.replace(/ё/g, "е")), 0);
    const negated = countMatches(NEGATION_POS_RE, t);
    neg += 2 * negated;
    pos -= negated;
    const total = pos + neg;
    return total <= 0 ? 0 : (pos - neg) / total;
  }

  function shingles(ws, k = 3) {
    if (ws.length < k) return new Set(ws.length ? [ws.join(" ")] : []);
    const s = new Set();
    for (let i = 0; i <= ws.length - k; i++) s.add(ws.slice(i, i + k).join(" "));
    return s;
  }

  const parseDate = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d) ? null : d;
  };
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

  class Counter extends Map {
    inc(k, n = 1) { this.set(k, (this.get(k) || 0) + n); }
    mostCommon(n = Infinity) { return [...this.entries()].sort((a, b) => b[1] - a[1]).slice(0, n); }
  }

  // ---------------------------------------------------------- признаки

  function detectDuplicates(reviews, threshold = 0.6) {
    const sh = [];
    const index = new Map();
    reviews.forEach((r, i) => {
      const ws = words(fullText(r));
      const s = ws.length >= 6 ? shingles(ws) : new Set();
      sh.push(s);
      for (const g of s) {
        if (!index.has(g)) index.set(g, []);
        index.get(g).push(i);
      }
    });

    const exact = new Map();
    const dup = new Map();
    reviews.forEach((r, i) => {
      const norm = words(fullText(r)).join(" ");
      if (norm.split(" ").length >= 4) {
        if (exact.has(norm)) {
          const j = exact.get(norm);
          dup.set(i, j);
          if (!dup.has(j)) dup.set(j, i);
          return;
        }
        exact.set(norm, i);
      }
      if (!sh[i].size) return;
      const cand = new Counter();
      for (const g of sh[i]) {
        const bucket = index.get(g);
        if (bucket.length > 50) continue; // слишком частая фраза — не информативна
        for (const j of bucket) if (j !== i) cand.inc(j);
      }
      for (const [j, inter] of cand.mostCommon(5)) {
        const union = sh[i].size + sh[j].size - inter;
        if (union && inter / union >= threshold) {
          dup.set(i, j);
          break;
        }
      }
    });
    return dup;
  }

  function burstDays(reviews) {
    const perDay = new Counter();
    for (const r of reviews) {
      const d = parseDate(r.date);
      if (d && r.rating === 5) perDay.inc(dayKey(d));
    }
    if (perDay.size < 3) return new Set();
    const counts = [...perDay.values()];
    const med = median(counts);
    const mad = median(counts.map((c) => Math.abs(c - med))) || 1;
    const limit = Math.max(5, med + 5 * mad, 4 * med);
    return new Set([...perDay].filter(([, c]) => c >= limit).map(([d]) => d));
  }

  function scoreReviews(reviews) {
    const dups = detectDuplicates(reviews);
    const bursts = burstDays(reviews);
    const authorKey = (r) => r.author_id || (r.author && !HIDDEN_AUTHOR_RE.test(r.author) ? r.author : "");
    const authors = new Counter();
    for (const r of reviews) { const k = authorKey(r); if (k) authors.inc(k); }
    const hasVerifiedField = reviews.some((r) => r.verified_purchase !== null && r.verified_purchase !== undefined);

    return reviews.map((r, i) => {
      const text = fullText(r);
      const ws = words(text);
      const rating = r.rating;
      const reasons = [];

      if (dups.has(i)) reasons.push("duplicate");
      const ak = authorKey(r);
      if (ak && authors.get(ak) >= 2) reasons.push("same_author");
      if (hasVerifiedField && r.verified_purchase === false) reasons.push("unverified");
      if (rating === 5 && ws.length < 8 && !(r.photos > 0)) reasons.push("short_generic");
      const tmpl = countMatches(TEMPLATE_RE, text);
      if (tmpl >= 2 && (rating || 0) >= 4 && tmpl * 6 >= ws.length * 0.5) reasons.push("template");
      const d = parseDate(r.date);
      if (d && rating === 5 && bursts.has(dayKey(d))) reasons.push("burst");
      if (INCENTIVE_RE.test(text)) reasons.push("incentive");
      const sent = sentiment(r.text);
      if (rating != null && words(r.text).length >= 5) {
        if ((rating >= 5 && sent <= -0.5) || (rating <= 2 && sent >= 0.6)) reasons.push("mismatch");
      }
      const cons = (r.cons || "").trim();
      if (rating === 5 && (!cons || NO_CONS_RE.test(cons)) && tmpl >= 1 && !/\d/.test(text) && ws.length < 40) {
        reasons.push("no_cons_superlatives");
      }
      const raw = r.text || "";
      const letters = raw.match(/\p{L}/gu) || [];
      const caps = letters.length >= 20 ? letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length / letters.length : 0;
      if (countSub(raw, "!") >= 4 || caps > 0.5 || countMatches(EMOJI_RE, raw) >= 4) reasons.push("emotional");
      if (!r.author || HIDDEN_AUTHOR_RE.test(r.author)) reasons.push("hidden_author");

      const score = 1 - reasons.reduce((p, c) => p * (1 - SIGNALS[c][0]), 1);
      const label = score >= 0.5 ? "fake" : score >= 0.3 ? "doubtful" : "genuine";
      return { ...r, fake_score: round(score), fake_label: label, fake_reasons: reasons, sentiment: round(sent, 2) };
    });
  }

  // ------------------------------------------------------ сводка по товару

  function ratingStats(reviews) {
    const ratings = reviews.map((r) => r.rating).filter((x) => x);
    const dist = {};
    for (let k = 5; k >= 1; k--) dist[k] = ratings.filter((x) => x === k).length;
    return { count: ratings.length, mean: ratings.length ? round(mean(ratings), 2) : null, distribution: dist };
  }

  function productSignals(scored) {
    const notes = [];
    const n = scored.length;
    if (!n) return notes;
    const st = ratingStats(scored);
    const dist = st.distribution;
    const five = dist[5], one = dist[1], mid = dist[2] + dist[3] + dist[4];
    const pct = (x) => `${Math.round(x * 100)}%`;

    if (n >= 30 && five / n > 0.9 && mid / n < 0.05) {
      notes.push({ weight: 2, text: `Почти нет средних оценок: ${pct(five / n)} пятёрок и лишь ${pct(mid / n)} оценок 2–4★ — нетипично для естественного распределения.` });
    }
    if (n >= 30 && five / n > 0.6 && one / n > 0.15 && mid / n < 0.12) {
      notes.push({ weight: 2, text: "Поляризация: много 5★ и 1★, мало средних — частый признак накрутки поверх реального недовольства." });
    }

    const genuine = scored.filter((r) => r.fake_label === "genuine" && r.rating);
    if (genuine.length >= 10 && st.mean != null) {
      const gm = mean(genuine.map((r) => r.rating));
      if (st.mean - gm >= 0.3) {
        notes.push({ weight: 2, text: `Без подозрительных отзывов средний рейтинг падает с ${st.mean.toFixed(2)} до ${gm.toFixed(2)}.` });
      }
    }

    const ver = scored.filter((r) => r.verified_purchase === true && r.rating).map((r) => r.rating);
    const unver = scored.filter((r) => r.verified_purchase === false && r.rating).map((r) => r.rating);
    if (ver.length >= 10 && unver.length >= 10) {
      const dv = mean(ver), du = mean(unver);
      if (du - dv >= 0.4) {
        notes.push({ weight: 2, text: `Отзывы без подтверждённой покупки заметно выше по оценке (${du.toFixed(2)}), чем с покупкой (${dv.toFixed(2)}).` });
      }
    }

    const dated = scored.filter((r) => parseDate(r.date) && r.rating).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (dated.length >= 40) {
      const q = Math.floor(dated.length / 4);
      const early = mean(dated.slice(0, q).map((r) => r.rating));
      const late = mean(dated.slice(-q).map((r) => r.rating));
      if (early - late >= 0.5) {
        notes.push({ weight: 1, text: `Первые отзывы заметно лучше последних (${early.toFixed(2)} → ${late.toFixed(2)}): возможен «разгон» карточки или ухудшение качества партий.` });
      }
    }

    const bursts = [...burstDays(scored)].sort();
    if (bursts.length) {
      notes.push({ weight: 2, text: `Всплески 5★-отзывов в дни: ${bursts.slice(0, 8).join(", ")}${bursts.length > 8 ? "…" : ""}` });
    }

    const inc = scored.filter((r) => r.fake_reasons.includes("incentive")).length;
    if (inc / n >= 0.1) {
      notes.push({ weight: 1, text: `${pct(inc / n)} отзывов прямо упоминают вознаграждение (баллы/кешбэк) — такие отзывы систематически завышены.` });
    }

    const variants = new Set(scored.map((r) => r.variant).filter(Boolean));
    if (variants.size > 1) {
      notes.push({ weight: 0, text: `Отзывы собраны с ${variants.size} вариантов товара (цвет/вкус/размер) — часть может относиться не к выбранному варианту.` });
    }
    return notes;
  }

  // ---------------------------------------------------------- плюсы/минусы

  function fragments(text) {
    const parts = String(text || "").split(/[\n;!?]+|(?<!\d)\.|\.(?!\d)|,\s+(?=[а-яё])| но | однако | а также /i);
    return parts
      .filter((p) => p !== undefined)
      .map((p) => p.replace(/^[\s\-—•*,]+|[\s\-—•*,]+$/g, ""))
      .filter((p) => {
        const n = words(p).length;
        return (n >= 2 && n <= 14) || (n === 1 && p.length > 4);
      });
  }

  function extractThemes(reviews, topN = 8) {
    const buckets = { pros: [], cons: [] };
    reviews.forEach((r, idx) => {
      const rating = r.rating || 0;
      const pros = r.pros || "", cons = r.cons || "", text = r.text || "";
      if (pros.trim()) buckets.pros.push([idx, fragments(pros)]);
      if (cons.trim() && !NO_CONS_RE.test(cons)) buckets.cons.push([idx, fragments(cons)]);
      if (text.trim()) {
        const fr = fragments(text);
        if (rating >= 4) buckets.pros.push([idx, fr.filter((f) => sentiment(f) > 0)]);
        else if (rating && rating <= 2) buckets.cons.push([idx, fr]);
        else {
          buckets.pros.push([idx, fr.filter((f) => sentiment(f) > 0)]);
          buckets.cons.push([idx, fr.filter((f) => sentiment(f) < 0)]);
        }
      }
    });

    const result = {};
    for (const [kind, items] of Object.entries(buckets)) {
      const reviewsWith = new Map();
      const examples = new Map();
      const surface = new Map();
      const add = (map, key, val) => { if (!map.has(key)) map.set(key, new Counter()); map.get(key).inc(val); };
      for (const [idx, frags] of items) {
        for (const f of frags) {
          const ws = words(f).filter((w) => !STOPWORDS.has(w) && w.length > 2 && !/^\d+$/.test(w));
          const stems = ws.map(stem);
          const terms = ws.map((w, i) => [stems[i], w]);
          for (let i = 0; i + 1 < ws.length; i++) terms.push([`${stems[i]} ${stems[i + 1]}`, `${ws[i]} ${ws[i + 1]}`]);
          for (const [key, surf] of terms) {
            if (!reviewsWith.has(key)) reviewsWith.set(key, new Set());
            reviewsWith.get(key).add(idx);
            add(surface, key, surf);
            add(examples, key, f);
          }
        }
      }
      const nReviews = new Set(items.map(([i]) => i)).size || 1;
      const ranked = [...reviewsWith.keys()].sort(
        (a, b) => reviewsWith.get(b).size * (b.includes(" ") ? 1.3 : 1) - reviewsWith.get(a).size * (a.includes(" ") ? 1.3 : 1)
      );
      const chosen = [];
      const chosenSets = [];
      for (const term of ranked) {
        const set = reviewsWith.get(term);
        const cnt = set.size;
        if (cnt < 2) break;
        if (chosenSets.some((cs) => [...set].filter((x) => cs.has(x)).length >= 0.7 * cnt)) continue;
        const exCounter = examples.get(term);
        const ex = exCounter
          .mostCommon(8)
          .map(([f]) => f)
          .sort((a, b) => Math.abs(words(a).length - 4) - Math.abs(words(b).length - 4) || exCounter.get(b) - exCounter.get(a))[0];
        const keyword = surface.get(term).mostCommon(1)[0][0];
        const label = words(ex).length <= 8 ? ex : keyword;
        chosen.push({
          theme: label.charAt(0).toUpperCase() + label.slice(1),
          keyword,
          mentions: cnt,
          share: round(cnt / nReviews),
          example: ex,
        });
        chosenSets.push(set);
        if (chosen.length >= topN) break;
      }
      result[kind] = chosen.sort((a, b) => b.mentions - a.mentions);
    }
    return result;
  }

  // ------------------------------------------------------------- динамика

  function monthly(scored) {
    const m = new Map();
    for (const r of scored) {
      const d = parseDate(r.date);
      if (!d || !r.rating) continue;
      const k = d.toISOString().slice(0, 7);
      if (!m.has(k)) m.set(k, { month: k, count: 0, five: 0, fake: 0, sum: 0 });
      const e = m.get(k);
      e.count++; e.sum += r.rating;
      if (r.rating === 5) e.five++;
      if (r.fake_label === "fake") e.fake++;
    }
    return [...m.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map((e) => ({ ...e, mean: round(e.sum / e.count, 2) }));
  }

  // --------------------------------------------------------------- вердикт

  function verdict(a) {
    if (!a.total_reviews) return { level: "unknown", score: 0, title: "Нет данных", text: "Отзывы не найдены." };
    const signalWeight = a.product_signals.reduce((s, x) => s + x.weight, 0);
    let score = a.fake_share * 100 * 1.4 + a.doubtful_share * 100 * 0.4 + signalWeight * 6;
    if (a.total_reviews < 15) score *= 0.7; // мало данных — меньше уверенности
    score = Math.max(0, Math.min(100, Math.round(score)));
    if (score >= 50) {
      return { level: "high", score, title: "Высокий риск накрутки", text: "Значительная часть отзывов выглядит искусственной. Ориентируйтесь на рейтинг без подозрительных отзывов и на отзывы с фото и деталями." };
    }
    if (score >= 25) {
      return { level: "medium", score, title: "Есть признаки накрутки", text: "Часть отзывов подозрительна, но основная масса похожа на настоящие. Обратите внимание на минусы из настоящих отзывов." };
    }
    return { level: "low", score, title: "Отзывы выглядят естественно", text: "Явных признаков массовой накрутки не найдено." };
  }

  function analyze(reviews, topN = 8) {
    const scored = scoreReviews(reviews);
    const n = scored.length;
    const labels = { fake: 0, doubtful: 0, genuine: 0 };
    const reasonCounts = new Counter();
    for (const r of scored) {
      labels[r.fake_label]++;
      r.fake_reasons.forEach((c) => reasonCounts.inc(c));
    }
    const notFake = scored.filter((r) => r.fake_label !== "fake");
    const result = {
      total_reviews: n,
      ratings_all: ratingStats(scored),
      ratings_without_fake: ratingStats(notFake),
      fake_share: n ? round(labels.fake / n) : 0,
      doubtful_share: n ? round(labels.doubtful / n) : 0,
      expected_fake_share: n ? round(mean(scored.map((r) => r.fake_score))) : 0,
      labels,
      verified_share: (() => {
        const known = scored.filter((r) => r.verified_purchase === true || r.verified_purchase === false);
        return known.length ? round(known.filter((r) => r.verified_purchase).length / known.length) : null;
      })(),
      with_photos_share: n ? round(scored.filter((r) => r.photos > 0).length / n) : 0,
      reasons: reasonCounts.mostCommon().map(([code, count]) => ({ code, count, description: SIGNALS[code][1] })),
      product_signals: productSignals(scored),
      themes: extractThemes(notFake, topN),
      monthly: monthly(scored),
      reviews: scored,
    };
    result.verdict = verdict(result);
    return result;
  }

  const api = { analyze, scoreReviews, extractThemes, sentiment, stem, words, SIGNALS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OzonAnalyzer = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
