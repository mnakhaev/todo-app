"""Сбор отзывов о товаре с Ozon.

Ozon закрыт антибот-защитой, поэтому обычные HTTP-запросы (requests/curl) почти
всегда получают 403. Здесь используется настоящий браузер (Playwright + Chromium):
страница отзывов открывается как у обычного пользователя, а затем из контекста
этой страницы вызывается внутренний JSON API витрины
(/api/entrypoint-api.bff/page/json/v2?url=...), который отдаёт отзывы постранично.

Структура ответа Ozon периодически меняется, поэтому парсер не привязан к
конкретному виджету: он рекурсивно ищет в ответе объекты, похожие на отзыв.
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

OZON_HOST = "https://www.ozon.ru"
API_PATH = "/api/entrypoint-api.bff/page/json/v2"
DEFAULT_PROFILE_DIR = Path.home() / ".ozon-review-analyzer" / "browser-profile"

ANTIBOT_MARKERS = ("antibot", "доступ ограничен", "access denied", "подтвердите, что вы не робот", "challenge")


# --------------------------------------------------------------------------- URL


def product_path(url: str) -> str:
    """Возвращает путь вида /product/<slug>-<sku>/ из любой ссылки на товар."""
    parsed = urlparse(url.strip())
    m = re.search(r"(/product/[^/?#]+)", parsed.path)
    if not m:
        # короткие ссылки вида ozon.ru/t/XXXX или просто SKU
        if re.fullmatch(r"\d{5,}", url.strip()):
            return f"/product/{url.strip()}/"
        raise ValueError(
            f"Не удалось распознать ссылку на товар: {url!r}. "
            "Ожидается ссылка вида https://www.ozon.ru/product/<название>-<sku>/"
        )
    return m.group(1).rstrip("/") + "/"


def product_sku(path: str) -> str | None:
    m = re.search(r"-(\d{5,})/?$", path.rstrip("/")) or re.search(r"/(\d{5,})/?$", path)
    return m.group(1) if m else None


def reviews_page_path(prod_path: str, page: int, sort: str = "published_at_desc") -> str:
    return f"{prod_path}reviews/?" + urlencode({"page": page, "sort": sort})


# ------------------------------------------------------------------- normalize


def _get(d: dict, *paths: str, default=None):
    """Первое непустое значение по списку путей вида 'content.score'."""
    for path in paths:
        cur: Any = d
        ok = True
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok and cur not in (None, "", [], {}):
            return cur
    return default


def _to_iso(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        ts = float(value)
        if ts > 1e12:  # миллисекунды
            ts /= 1000
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
        except ValueError:
            return value
    return None


def _to_bool(value: Any) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "да")
    return None


def _looks_like_review(d: dict) -> bool:
    content = d.get("content") if isinstance(d.get("content"), dict) else {}
    has_score = any(k in d for k in ("score", "rating")) or any(k in content for k in ("score", "rating"))
    has_text = any(k in d for k in ("comment", "text", "positive", "negative")) or any(
        k in content for k in ("comment", "text", "positive", "negative")
    )
    has_id = any(k in d for k in ("uuid", "id", "reviewUuid", "reviewId"))
    return has_score and has_text and has_id


def normalize_review(d: dict) -> dict:
    author = d.get("author") if isinstance(d.get("author"), dict) else {}
    author_name = " ".join(
        str(x) for x in (author.get("firstName"), author.get("lastName")) if x
    ) or author.get("name") or d.get("authorName") or ""
    photos = _get(d, "content.photos", "photos", default=[]) or []
    videos = _get(d, "content.videos", "videos", default=[]) or []
    rating = _get(d, "content.score", "score", "rating", "content.rating")
    try:
        rating = int(round(float(rating))) if rating is not None else None
    except (TypeError, ValueError):
        rating = None
    return {
        "id": str(_get(d, "uuid", "reviewUuid", "id", "reviewId", default="")),
        "rating": rating,
        "text": str(_get(d, "content.comment", "comment", "content.text", "text", default="") or ""),
        "pros": str(_get(d, "content.positive", "positive", "advantages", default="") or ""),
        "cons": str(_get(d, "content.negative", "negative", "disadvantages", default="") or ""),
        "date": _to_iso(_get(d, "publishedAt", "createdAt", "published_at", "created_at", "date")),
        "author": author_name.strip(),
        "author_id": str(_get(d, "author.id", "author.uuid", "authorId", default="") or ""),
        "verified_purchase": _to_bool(
            _get(d, "isItemPurchased", "isPurchased", "itemPurchased", "purchased", "isBuyer")
        ),
        "likes": int(_get(d, "usefulness.useful", "usefulness.likes", "likes", "useful", default=0) or 0),
        "dislikes": int(_get(d, "usefulness.unuseful", "usefulness.dislikes", "dislikes", default=0) or 0),
        "photos": len(photos) if isinstance(photos, list) else 0,
        "videos": len(videos) if isinstance(videos, list) else 0,
        "variant": str(_get(d, "variantsInfo.title", "itemName", "variant", "sku", "itemId", default="") or ""),
        "seller_reply": bool(_get(d, "comments", "answers", "sellerComment", "reply")),
    }


def extract_reviews(obj: Any) -> list[dict]:
    """Рекурсивно находит отзывы в JSON-ответе Ozon (widgetStates содержат JSON-строки)."""
    found: list[dict] = []

    def walk(node: Any, depth: int = 0) -> None:
        if depth > 40:
            return
        if isinstance(node, str):
            s = node.strip()
            if len(s) > 20 and s[0] in "{[" and ("score" in s or "rating" in s):
                try:
                    walk(json.loads(s), depth + 1)
                except ValueError:
                    pass
            return
        if isinstance(node, dict):
            if _looks_like_review(node):
                found.append(normalize_review(node))
                return
            for v in node.values():
                walk(v, depth + 1)
        elif isinstance(node, list):
            for v in node:
                walk(v, depth + 1)

    walk(obj)
    return found


def extract_next_page(obj: Any) -> str | None:
    """Ищет ссылку на следующую страницу (ключ nextPage) в ответе."""
    stack = [obj]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            for k, v in node.items():
                if k in ("nextPage", "nextPageUrl") and isinstance(v, str) and v:
                    return v
                stack.append(v)
        elif isinstance(node, list):
            stack.extend(node)
        elif isinstance(node, str) and node[:1] == "{" and "nextPage" in node:
            try:
                stack.append(json.loads(node))
            except ValueError:
                pass
    return None


def extract_from_html(html: str) -> list[dict]:
    """Запасной вариант: отзывы из data-state атрибутов отрендеренной страницы."""
    import html as html_lib

    reviews: list[dict] = []
    for m in re.finditer(r"data-state='([^']+)'", html):
        try:
            reviews.extend(extract_reviews(json.loads(html_lib.unescape(m.group(1)))))
        except ValueError:
            continue
    return reviews


def dedupe(reviews: Iterable[dict]) -> list[dict]:
    seen: set[str] = set()
    out = []
    for r in reviews:
        key = r["id"] or f"{r['author']}|{r['date']}|{r['text'][:80]}"
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


# --------------------------------------------------------------------- browser


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _wait_antibot(page, timeout_s: int) -> None:
    """Ждёт, пока пройдёт антибот-проверка (в видимом браузере можно пройти её вручную)."""
    deadline = time.time() + timeout_s
    warned = False
    while time.time() < deadline:
        try:
            title = (page.title() or "").lower()
            body = (page.inner_text("body", timeout=3000) or "")[:2000].lower()
        except Exception:
            title, body = "", ""
        if not any(m in title or m in body for m in ANTIBOT_MARKERS) and body:
            return
        if not warned:
            _log("… Ozon показывает антибот-проверку. Если открыто окно браузера — пройдите её вручную.")
            warned = True
        page.wait_for_timeout(2000)
    raise RuntimeError(
        "Не удалось пройти антибот-проверку Ozon. Запустите без --headless и пройдите проверку в окне браузера."
    )


FETCH_JS = """
async (url) => {
  const r = await fetch(url, {credentials: 'include', headers: {'Accept': 'application/json'}});
  return {status: r.status, body: await r.text()};
}
"""


def fetch_reviews(
    url: str,
    *,
    max_pages: int = 500,
    headless: bool = False,
    profile_dir: Path = DEFAULT_PROFILE_DIR,
    delay_s: float = 1.0,
    antibot_timeout_s: int = 180,
    debug_dir: Path | None = None,
) -> tuple[dict, list[dict]]:
    """Возвращает (информация о товаре, список нормализованных отзывов)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:  # pragma: no cover
        raise SystemExit(
            "Нужен Playwright: pip install playwright && python -m playwright install chromium"
        ) from e

    prod_path = product_path(url)
    info: dict[str, Any] = {"url": OZON_HOST + prod_path, "sku": product_sku(prod_path), "title": None}
    reviews: list[dict] = []
    profile_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            str(profile_dir),
            headless=headless,
            locale="ru-RU",
            viewport={"width": 1366, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        _log(f"Открываю {OZON_HOST}{prod_path}reviews/")
        page.goto(f"{OZON_HOST}{prod_path}reviews/", wait_until="domcontentloaded", timeout=90_000)
        _wait_antibot(page, antibot_timeout_s)
        page.wait_for_timeout(1500)
        try:
            info["title"] = page.locator("h1").first.inner_text(timeout=5000).strip()
        except Exception:
            info["title"] = (page.title() or "").split(" купить")[0].strip() or None

        html_reviews = extract_from_html(page.content())

        next_path: str | None = reviews_page_path(prod_path, 1)
        seen_ids: set[str] = set()
        empty_streak = 0
        for page_no in range(1, max_pages + 1):
            if not next_path:
                break
            api_url = f"{API_PATH}?" + urlencode({"url": next_path})
            resp = page.evaluate(FETCH_JS, api_url)
            if resp["status"] in (403, 429):
                _log(f"Страница {page_no}: HTTP {resp['status']}, жду и пробую ещё раз…")
                page.reload(wait_until="domcontentloaded")
                _wait_antibot(page, antibot_timeout_s)
                page.wait_for_timeout(5000)
                resp = page.evaluate(FETCH_JS, api_url)
            if resp["status"] != 200:
                _log(f"Страница {page_no}: HTTP {resp['status']}, останавливаюсь.")
                break
            try:
                data = json.loads(resp["body"])
            except ValueError:
                _log(f"Страница {page_no}: ответ не JSON, останавливаюсь.")
                break
            if debug_dir:
                debug_dir.mkdir(parents=True, exist_ok=True)
                (debug_dir / f"page_{page_no:04d}.json").write_text(resp["body"], encoding="utf-8")

            batch = extract_reviews(data)
            new = [r for r in batch if r["id"] not in seen_ids]
            seen_ids.update(r["id"] for r in batch)
            reviews.extend(new)
            _log(f"Страница {page_no}: +{len(new)} отзывов (всего {len(reviews)})")

            empty_streak = empty_streak + 1 if not new else 0
            if empty_streak >= 2:
                break
            nxt = extract_next_page(data)
            if nxt:
                parsed = urlparse(nxt)
                nxt = urlunparse(("", "", parsed.path, "", parsed.query, ""))
                # защита от зацикливания: если nextPage не меняет номер страницы
                if nxt == next_path:
                    nxt = None
            if not nxt:
                q = parse_qs(urlparse(next_path).query)
                cur = int(q.get("page", [page_no])[0])
                nxt = reviews_page_path(prod_path, cur + 1) if new else None
            next_path = nxt
            page.wait_for_timeout(int(delay_s * 1000))

        ctx.close()

    if not reviews and html_reviews:
        reviews = html_reviews
    return info, dedupe(reviews)
