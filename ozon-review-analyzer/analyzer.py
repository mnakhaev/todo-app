"""Эвристический анализ отзывов: признаки накрутки, доля подозрительных, плюсы/минусы.

Каждый отзыв проверяется набором независимых признаков. У признака есть вес —
«насколько сильно он повышает подозрение». Итоговая оценка считается как
noisy-OR: score = 1 - Π(1 - w_i). Так один слабый признак не делает отзыв
фейковым, а несколько совпавших — делают.

Пороги:
  score >= 0.50 — «вероятно фейк»
  0.30..0.50    — «сомнительный»
  < 0.30        — «похож на настоящий»

Это вероятностная оценка, а не доказательство: у каждого признака бывают
ложные срабатывания, поэтому в отчёте для каждого отзыва видны причины.
"""

from __future__ import annotations

import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

# ------------------------------------------------------------------ лексиконы

TEMPLATE_PHRASES = [
    r"всем рекомендую", r"рекомендую к покупке", r"советую к покупке", r"всем советую",
    r"качество на высоте", r"качество отличное", r"отличное качество", r"цена[- ]качество",
    r"соответствует описанию", r"соответствует заявленному", r"как на фото", r"как на картинке",
    r"быстрая доставка", r"доставка быстрая", r"пришло быстро", r"пришел быстро", r"пришёл быстро",
    r"продавцу спасибо", r"спасибо продавцу", r"буду заказывать ещё", r"буду заказывать еще",
    r"буду брать ещё", r"буду брать еще", r"лучший товар", r"не пожалела?", r"не пожалеете",
    r"товар супер", r"всё супер", r"все супер", r"всё отлично", r"все отлично", r"очень довольн",
    r"покупкой довольн", r"упакован(о|а)? (хорошо|отлично|надежно|надёжно)", r"шикарн", r"восторг",
    r"лучше не найти", r"берите не пожалеете", r"однозначно рекомендую", r"5 из 5", r"10 из 10",
]
TEMPLATE_RE = re.compile("|".join(TEMPLATE_PHRASES), re.IGNORECASE)

INCENTIVE_RE = re.compile(
    r"за баллы|отзыв за балл|баллы за отзыв|за отзыв|кешб[эе]к|кэшб[эе]к|получил[аи]? бесплатно|"
    r"бесплатно в обмен|по акции за отзыв|вернули деньги за отзыв|за вознаграждение",
    re.IGNORECASE,
)

HIDDEN_AUTHOR_RE = re.compile(r"скрыл|аноним|покупатель ozon|пользователь|^$", re.IGNORECASE)

POS_WORDS = {
    "отличн", "хорош", "супер", "класс", "прекрасн", "замечательн", "довол", "нрав", "рекоменд",
    "удобн", "качествен", "лучш", "идеальн", "шикарн", "восторг", "великолепн", "надежн", "надёжн",
    "приятн", "красив", "мягк", "быстр", "спасибо", "порадова", "понрав", "работает", "советую",
}
NEG_WORDS = {
    "плох", "ужас", "брак", "сломал", "слома", "не работ", "разочаров", "верн", "возврат", "кошмар",
    "отвратит", "дешев", "дешёв", "хлипк", "некачеств", "обман", "подделк", "фальшив", "не соответ",
    "не рекоменд", "не советую", "порван", "треснул", "запах", "воняет", "вонь", "мал", "велик",
    "жаль", "развалил", "отклеил", "протек", "царапин", "не пришл", "не то", "деньги на ветер",
}
NEGATION_POS_RE = re.compile(r"\bне\s+(отличн|хорош|рекоменд|советую|довол|нрав|удобн|качествен)", re.IGNORECASE)

STOPWORDS = set(
    """
    и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по только ее её мне
    было вот от меня еще ещё нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до
    вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их
    чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой
    совсем ним здесь этом один почти мой тем чтобы нее неё сейчас были куда зачем всех никогда можно при
    наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту
    моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между
    это очень весь вообще просто товар товара товаром товаре штука вещь вещи также которые который которая
    нет минусов минусы плюсы плюс достоинства недостатки пока выявлено нету обнаружено замечено нашла нашел
    нашёл заметил заметила вроде в целом целом ещё еще пару раз своих свои своей
    """.split()
)

NO_CONS_RE = re.compile(
    r"^\s*(нет|нету|не(т)? выявлен\w*|не обнаружен\w*|не нашл?[аи]?|не заметил[аи]?|пока нет|"
    r"пока не выявлен\w*|отсутствуют|их нет|-+|—|\.+|0|нет недостатков|минусов нет)\W*$",
    re.IGNORECASE,
)

WORD_RE = re.compile(r"[a-zа-яё0-9]+", re.IGNORECASE)
EMOJI_RE = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


# -------------------------------------------------------------------- утилиты


def full_text(r: dict) -> str:
    parts = [r.get("pros") or "", r.get("cons") or "", r.get("text") or ""]
    return "\n".join(p for p in parts if p.strip())


def words(s: str) -> list[str]:
    return [w.lower().replace("ё", "е") for w in WORD_RE.findall(s)]


def stem(word: str) -> str:
    """Очень грубый стеммер для русского: срезает типичные окончания."""
    w = word.lower().replace("ё", "е")
    if len(w) <= 4:
        return w
    for suf in (
        "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ее", "ие", "ые", "ое", "ей",
        "ий", "ый", "ой", "ем", "им", "ым", "ом", "их", "ых", "ую", "юю", "ая", "яя", "ов", "ев",
        "ах", "ях", "ия", "ья", "ть", "ла", "ло", "ли", "ет", "ут", "ют", "ит", "ат", "ят",
        "а", "я", "о", "е", "ы", "и", "у", "ю", "ь", "й",
    ):
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: -len(suf)]
    return w


def sentiment(text: str) -> float:
    """Грубая лексиконная тональность в [-1, 1]."""
    t = text.lower().replace("ё", "е")
    if not t.strip():
        return 0.0
    pos = sum(t.count(w) for w in POS_WORDS)
    neg = sum(t.count(w) for w in NEG_WORDS)
    neg += 2 * len(NEGATION_POS_RE.findall(t))
    pos -= len(NEGATION_POS_RE.findall(t))
    total = pos + neg
    return 0.0 if total <= 0 else (pos - neg) / total


def shingles(ws: list[str], k: int = 3) -> set[tuple[str, ...]]:
    if len(ws) < k:
        return {tuple(ws)} if ws else set()
    return {tuple(ws[i : i + k]) for i in range(len(ws) - k + 1)}


def parse_date(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


# --------------------------------------------------------------- признаки


SIGNALS = {
    # код: (вес, человекочитаемое описание)
    "duplicate": (0.45, "почти дословно совпадает с другим отзывом"),
    "unverified": (0.25, "нет отметки о покупке товара"),
    "short_generic": (0.25, "5★ и очень короткий текст без конкретики"),
    "template": (0.20, "набор шаблонных рекламных фраз"),
    "burst": (0.20, "опубликован во всплеске 5★-отзывов за один день"),
    "incentive": (0.20, "отзыв за вознаграждение (баллы/кешбэк)"),
    "mismatch": (0.20, "оценка противоречит тексту"),
    "no_cons_superlatives": (0.15, "только превосходные степени, минусов «нет»"),
    "emotional": (0.10, "избыток восклицаний/капса/эмодзи"),
    "hidden_author": (0.05, "автор скрыт / безымянный"),
    "same_author": (0.30, "у автора несколько отзывов на этот товар"),
}


def _detect_duplicates(reviews: list[dict], threshold: float = 0.6) -> dict[int, int]:
    """Возвращает {индекс отзыва: индекс похожего отзыва}. Использует индекс шинглов, чтобы не сравнивать всё со всем."""
    sh = []
    index: dict[tuple, list[int]] = defaultdict(list)
    for i, r in enumerate(reviews):
        ws = words(full_text(r))
        s = shingles(ws) if len(ws) >= 6 else set()
        sh.append(s)
        for g in s:
            index[g].append(i)

    exact: dict[str, int] = {}
    dup: dict[int, int] = {}
    for i, r in enumerate(reviews):
        norm = " ".join(words(full_text(r)))
        if len(norm.split()) >= 4:
            if norm in exact:
                dup[i] = exact[norm]
                dup.setdefault(exact[norm], i)
                continue
            exact[norm] = i
        if not sh[i]:
            continue
        cand = Counter()
        for g in sh[i]:
            bucket = index[g]
            if len(bucket) > 50:  # слишком частая фраза — не информативна
                continue
            for j in bucket:
                if j != i:
                    cand[j] += 1
        for j, inter in cand.most_common(5):
            union = len(sh[i]) + len(sh[j]) - inter
            if union and inter / union >= threshold:
                dup[i] = j
                break
    return dup


def _burst_days(reviews: list[dict]) -> set[str]:
    """Дни, в которые 5★-отзывов аномально много относительно типичного дня."""
    per_day = Counter()
    for r in reviews:
        d = parse_date(r.get("date"))
        if d and r.get("rating") == 5:
            per_day[d.date().isoformat()] += 1
    if len(per_day) < 3:
        return set()
    counts = list(per_day.values())
    med = statistics.median(counts)
    mad = statistics.median([abs(c - med) for c in counts]) or 1
    limit = max(5, med + 5 * mad, 4 * med)
    return {day for day, c in per_day.items() if c >= limit}


def score_reviews(reviews: list[dict]) -> list[dict]:
    """Добавляет к каждому отзыву поля fake_score, fake_label, fake_reasons."""
    dups = _detect_duplicates(reviews)
    bursts = _burst_days(reviews)

    authors = Counter(
        r["author_id"] or r["author"]
        for r in reviews
        if (r.get("author_id") or (r.get("author") and not HIDDEN_AUTHOR_RE.search(r["author"])))
    )
    has_verified_field = any(r.get("verified_purchase") is not None for r in reviews)

    out = []
    for i, r in enumerate(reviews):
        text = full_text(r)
        ws = words(text)
        rating = r.get("rating")
        reasons: list[str] = []

        if i in dups:
            reasons.append("duplicate")
        if has_verified_field and r.get("verified_purchase") is False:
            reasons.append("unverified")
        if rating == 5 and len(ws) < 8 and r.get("photos", 0) == 0:
            reasons.append("short_generic")
        tmpl = len(TEMPLATE_RE.findall(text))
        if tmpl >= 2 and (rating or 0) >= 4 and tmpl * 6 >= len(ws) * 0.5:
            reasons.append("template")
        d = parse_date(r.get("date"))
        if d and rating == 5 and d.date().isoformat() in bursts:
            reasons.append("burst")
        if INCENTIVE_RE.search(text):
            reasons.append("incentive")
        sent = sentiment(r.get("text") or "")
        if rating is not None and len(words(r.get("text") or "")) >= 5:
            if (rating >= 5 and sent <= -0.5) or (rating <= 2 and sent >= 0.6):
                reasons.append("mismatch")
        cons = (r.get("cons") or "").strip()
        if rating == 5 and (not cons or NO_CONS_RE.match(cons)) and tmpl >= 1 and not re.search(r"\d", text):
            if len(ws) < 40:
                reasons.append("no_cons_superlatives")
        raw = r.get("text") or ""
        letters = [c for c in raw if c.isalpha()]
        caps_ratio = sum(c.isupper() for c in letters) / len(letters) if len(letters) >= 20 else 0
        if raw.count("!") >= 4 or caps_ratio > 0.5 or len(EMOJI_RE.findall(raw)) >= 4:
            reasons.append("emotional")
        if not r.get("author") or HIDDEN_AUTHOR_RE.search(r.get("author", "")):
            reasons.append("hidden_author")
        akey = r.get("author_id") or r.get("author")
        if akey and authors.get(akey, 0) >= 2:
            reasons.append("same_author")

        score = 1 - math.prod(1 - SIGNALS[c][0] for c in reasons)
        label = "fake" if score >= 0.5 else "doubtful" if score >= 0.3 else "genuine"
        out.append({**r, "fake_score": round(score, 3), "fake_label": label, "fake_reasons": reasons, "sentiment": round(sent, 2)})
    return out


# ------------------------------------------------------ сводка по товару


def _rating_stats(reviews: list[dict]) -> dict:
    ratings = [r["rating"] for r in reviews if r.get("rating")]
    if not ratings:
        return {"count": 0, "mean": None, "distribution": {}}
    dist = Counter(ratings)
    return {
        "count": len(ratings),
        "mean": round(statistics.mean(ratings), 2),
        "distribution": {k: dist.get(k, 0) for k in range(5, 0, -1)},
    }


def product_signals(scored: list[dict]) -> list[str]:
    """Признаки накрутки на уровне всего товара (а не отдельного отзыва)."""
    notes = []
    n = len(scored)
    if n == 0:
        return notes
    st = _rating_stats(scored)
    dist = st["distribution"]
    five, one = dist.get(5, 0), dist.get(1, 0)
    mid = dist.get(2, 0) + dist.get(3, 0) + dist.get(4, 0)
    if n >= 30 and five / n > 0.9 and mid / n < 0.05:
        notes.append(f"Почти нет средних оценок: {five / n:.0%} пятёрок и лишь {mid / n:.0%} оценок 2–4★ — нетипично для естественного распределения.")
    if n >= 30 and five / n > 0.6 and one / n > 0.15 and mid / n < 0.12:
        notes.append("Поляризованное распределение (много 5★ и 1★, мало средних) — частый признак накрутки поверх реального недовольства.")

    genuine = [r for r in scored if r["fake_label"] == "genuine"]
    if len(genuine) >= 10 and st["mean"] is not None:
        gm = statistics.mean(r["rating"] for r in genuine if r.get("rating"))
        if st["mean"] - gm >= 0.3:
            notes.append(f"Без подозрительных отзывов средний рейтинг падает с {st['mean']:.2f} до {gm:.2f}.")

    ver = [r["rating"] for r in scored if r.get("verified_purchase") is True and r.get("rating")]
    unver = [r["rating"] for r in scored if r.get("verified_purchase") is False and r.get("rating")]
    if len(ver) >= 10 and len(unver) >= 10:
        dv, du = statistics.mean(ver), statistics.mean(unver)
        if du - dv >= 0.4:
            notes.append(f"Отзывы без подтверждённой покупки заметно выше по оценке ({du:.2f}), чем с покупкой ({dv:.2f}).")

    # Динамика: ранние отзывы значительно лучше поздних
    dated = sorted((r for r in scored if parse_date(r.get("date")) and r.get("rating")), key=lambda r: r["date"])
    if len(dated) >= 40:
        q = len(dated) // 4
        early = statistics.mean(r["rating"] for r in dated[:q])
        late = statistics.mean(r["rating"] for r in dated[-q:])
        if early - late >= 0.5:
            notes.append(f"Первые отзывы заметно лучше последних ({early:.2f} → {late:.2f}): возможен «разгон» карточки или ухудшение качества партий.")

    bursts = _burst_days(scored)
    if bursts:
        notes.append("Всплески 5★-отзывов в дни: " + ", ".join(sorted(bursts)[:10]) + ("…" if len(bursts) > 10 else ""))

    inc = sum("incentive" in r["fake_reasons"] for r in scored)
    if inc / n >= 0.1:
        notes.append(f"{inc / n:.0%} отзывов прямо упоминают вознаграждение (баллы/кешбэк) — такие отзывы систематически завышены.")

    variants = Counter(r.get("variant") for r in scored if r.get("variant"))
    if len(variants) > 1:
        notes.append(f"Отзывы собраны с {len(variants)} вариантов товара (цвет/размер/модель) — часть может относиться не к выбранному варианту.")
    return notes


# ------------------------------------------------------------- плюсы/минусы


def _fragments(text: str) -> list[str]:
    parts = re.split(r"[\n;!?]+|(?<!\d)\.|\.(?!\d)|,\s+(?=[а-яё])| но | однако | а также ", text, flags=re.IGNORECASE)
    return [p.strip(" -—•*,") for p in parts if 2 <= len(words(p)) <= 14 or (len(words(p)) == 1 and len(p) > 4)]


def extract_themes(reviews: list[dict], top_n: int = 10) -> dict[str, list[dict]]:
    """Частотные темы в достоинствах и недостатках (без учёта подозрительных отзывов).

    Источники плюсов: поле «Достоинства» + комментарии к оценкам 4–5★.
    Источники минусов: поле «Недостатки» + комментарии к оценкам 1–2★.
    """
    buckets = {"pros": [], "cons": []}
    for r in reviews:
        rating = r.get("rating") or 0
        pros, cons, text = r.get("pros") or "", r.get("cons") or "", r.get("text") or ""
        if pros.strip():
            buckets["pros"].append((r, _fragments(pros)))
        if cons.strip() and not NO_CONS_RE.match(cons):
            buckets["cons"].append((r, _fragments(cons)))
        if text.strip():
            if rating >= 4:
                buckets["pros"].append((r, [f for f in _fragments(text) if sentiment(f) > 0]))
            elif rating and rating <= 2:
                buckets["cons"].append((r, _fragments(text)))
            # 3★ — смешанные: раскладываем фрагменты по тональности
            else:
                fr = _fragments(text)
                buckets["pros"].append((r, [f for f in fr if sentiment(f) > 0]))
                buckets["cons"].append((r, [f for f in fr if sentiment(f) < 0]))

    result = {}
    for kind, items in buckets.items():
        reviews_with: dict[str, set[int]] = defaultdict(set)
        examples: dict[str, Counter] = defaultdict(Counter)
        surface: dict[str, Counter] = defaultdict(Counter)
        for r, frags in items:
            idx = id(r)
            for f in frags:
                ws = [w for w in words(f) if w not in STOPWORDS and len(w) > 2 and not w.isdigit()]
                stems = [stem(w) for w in ws]
                terms = [(s, w) for w, s in zip(ws, stems)]
                terms += [(f"{s1} {s2}", f"{w1} {w2}") for w1, s1, w2, s2 in zip(ws, stems, ws[1:], stems[1:])]
                for key, surf in terms:
                    reviews_with[key].add(idx)
                    surface[key][surf] += 1
                    examples[key][f] += 1

        n_reviews = len({id(r) for r, _ in items}) or 1
        # биграммы чуть предпочтительнее одиночных слов — они понятнее («короткий шнур» vs «шнур»)
        ranked = sorted(reviews_with, key=lambda k: len(reviews_with[k]) * (1.3 if " " in k else 1.0), reverse=True)
        chosen: list[dict] = []
        chosen_sets: list[set[int]] = []
        for term in ranked:
            cnt = len(reviews_with[term])
            if cnt < 2:
                break
            # пропускаем тему, если она почти целиком про те же отзывы, что уже выбранная
            if any(len(reviews_with[term] & cs) >= 0.7 * cnt for cs in chosen_sets):
                continue
            ex = min(
                (f for f, _ in examples[term].most_common(8)),
                key=lambda f: (abs(len(words(f)) - 4), -examples[term][f]),
            )
            label = ex if len(words(ex)) <= 8 else surface[term].most_common(1)[0][0]
            chosen.append({
                "theme": label[:1].upper() + label[1:],
                "keyword": surface[term].most_common(1)[0][0],
                "mentions": cnt,
                "share": round(cnt / n_reviews, 3),
                "example": ex,
            })
            chosen_sets.append(reviews_with[term])
            if len(chosen) >= top_n:
                break
        result[kind] = sorted(chosen, key=lambda t: -t["mentions"])
    return result


# ------------------------------------------------------------------- итог


def analyze(reviews: list[dict], top_n: int = 10) -> dict[str, Any]:
    scored = score_reviews(reviews)
    n = len(scored)
    labels = Counter(r["fake_label"] for r in scored)
    reason_counts = Counter(c for r in scored for c in r["fake_reasons"])
    genuine = [r for r in scored if r["fake_label"] != "fake"]
    return {
        "total_reviews": n,
        "ratings_all": _rating_stats(scored),
        "ratings_without_fake": _rating_stats(genuine),
        "fake_share": round(labels.get("fake", 0) / n, 3) if n else 0.0,
        "doubtful_share": round(labels.get("doubtful", 0) / n, 3) if n else 0.0,
        "expected_fake_share": round(statistics.mean(r["fake_score"] for r in scored), 3) if n else 0.0,
        "labels": dict(labels),
        "reasons": {c: {"count": k, "description": SIGNALS[c][1]} for c, k in reason_counts.most_common()},
        "product_signals": product_signals(scored),
        "themes": extract_themes(genuine, top_n=top_n),
        "reviews": scored,
    }
