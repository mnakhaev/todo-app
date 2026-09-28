"""Необязательный углублённый анализ отзывов через Claude API (флаг --llm).

Эвристики хорошо ловят дубликаты, всплески и шаблоны, но плохо понимают смысл.
Claude получает отзывы вместе с эвристическими метками и возвращает:
  * сгруппированные плюсы и минусы с числом упоминаний и цитатами;
  * свою оценку доли фейковых отзывов и id отзывов, которые считает накрученными;
  * короткий итог для покупателя.

Нужен ключ: переменная окружения ANTHROPIC_API_KEY (или профиль `ant auth login`).
"""

from __future__ import annotations

import json
import sys

DEFAULT_MODEL = "claude-opus-5"

SYSTEM_PROMPT = """Ты аналитик отзывов маркетплейса Ozon. Тебе дают отзывы об одном товаре \
в формате JSON-строк. У каждого отзыва есть эвристическая метка подозрительности \
(heuristic_label: genuine / doubtful / fake) и причины (heuristic_reasons) — это подсказки, \
а не истина: перепроверь их по смыслу.

Признаки накрученного отзыва: общий текст без деталей использования, который подходит к любому \
товару; рекламный тон и шаблонные фразы; противоречие между оценкой и текстом; текст про другой \
товар; несколько отзывов с одинаковой структурой или лексикой; упоминание вознаграждения за отзыв; \
всплеск похожих 5★ в короткий период. Признаки настоящего отзыва: конкретика (размеры, сроки, \
сценарии использования, сравнение с другими товарами), взвешенные плюсы и минусы, фото.

Плюсы и минусы собирай только из отзывов, которые считаешь настоящими. Объединяй синонимичные \
формулировки в одну тему. mentions — сколько отзывов упоминают тему. Цитату бери дословно из отзыва. \
Пиши по-русски."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "fake_share_estimate": {
            "type": "number",
            "description": "Доля отзывов (0..1) из переданных, которые ты считаешь накрученными",
        },
        "fake_review_ids": {"type": "array", "items": {"type": "string"}},
        "fake_patterns": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Какие паттерны накрутки обнаружены",
        },
        "pros": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "theme": {"type": "string"},
                    "mentions": {"type": "integer"},
                    "quote": {"type": "string"},
                },
                "required": ["theme", "mentions", "quote"],
                "additionalProperties": False,
            },
        },
        "cons": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "theme": {"type": "string"},
                    "mentions": {"type": "integer"},
                    "quote": {"type": "string"},
                },
                "required": ["theme", "mentions", "quote"],
                "additionalProperties": False,
            },
        },
        "verdict": {"type": "string", "description": "Итог для покупателя в 3–5 предложениях"},
    },
    "required": ["fake_share_estimate", "fake_review_ids", "fake_patterns", "pros", "cons", "verdict"],
    "additionalProperties": False,
}


def _select(reviews: list[dict], limit: int) -> list[dict]:
    """Если отзывов больше лимита — берём все подозрительные + самые полезные/свежие настоящие."""
    if len(reviews) <= limit:
        return reviews
    flagged = [r for r in reviews if r["fake_label"] != "genuine"]
    genuine = [r for r in reviews if r["fake_label"] == "genuine"]
    genuine.sort(key=lambda r: (r.get("likes", 0), len(r.get("text", "")), r.get("date") or ""), reverse=True)
    take_flagged = flagged[: limit // 2]
    return take_flagged + genuine[: limit - len(take_flagged)]


def _compact(r: dict) -> dict:
    return {
        "id": r["id"],
        "rating": r.get("rating"),
        "date": (r.get("date") or "")[:10],
        "verified_purchase": r.get("verified_purchase"),
        "photos": r.get("photos", 0),
        "likes": r.get("likes", 0),
        "pros": r.get("pros", ""),
        "cons": r.get("cons", ""),
        "text": r.get("text", ""),
        "heuristic_label": r["fake_label"],
        "heuristic_reasons": r["fake_reasons"],
    }


def llm_analyze(product: dict, analysis: dict, *, model: str = DEFAULT_MODEL, max_reviews: int = 800) -> dict:
    try:
        import anthropic
    except ImportError as e:  # pragma: no cover
        raise SystemExit("Для --llm нужен пакет anthropic: pip install anthropic") from e

    reviews = analysis["reviews"]
    selected = _select(reviews, max_reviews)
    if len(selected) < len(reviews):
        print(
            f"ℹ️  В Claude отправлено {len(selected)} из {len(reviews)} отзывов "
            f"(лимит --llm-max-reviews={max_reviews}; все подозрительные — в приоритете).",
            file=sys.stderr,
        )

    lines = "\n".join(json.dumps(_compact(r), ensure_ascii=False) for r in selected)
    user = (
        f"Товар: {product.get('title') or product.get('url')}\n"
        f"Всего отзывов собрано: {analysis['total_reviews']}; передано тебе: {len(selected)}.\n"
        f"Эвристика: доля «fake» = {analysis['fake_share']:.1%}, «doubtful» = {analysis['doubtful_share']:.1%}.\n"
        f"Признаки на уровне товара: {json.dumps(analysis['product_signals'], ensure_ascii=False)}\n\n"
        f"Отзывы (по одному JSON на строку):\n{lines}"
    )

    client = anthropic.Anthropic()
    print(f"Отправляю отзывы в {model}…", file=sys.stderr)
    with client.beta.messages.stream(
        model=model,
        max_tokens=64000,
        system=SYSTEM_PROMPT,
        thinking={"type": "adaptive"},
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        extra_body={"fallbacks": "default"},
        messages=[{"role": "user", "content": user}],
    ) as stream:
        response = stream.get_final_message()

    if response.stop_reason == "refusal":
        raise RuntimeError("Claude отказался обрабатывать запрос (stop_reason=refusal).")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Ответ Claude обрезан по max_tokens — уменьшите --llm-max-reviews.")
    text = next(b.text for b in response.content if b.type == "text")
    result = json.loads(text)
    result["reviews_sent"] = len(selected)
    result["model"] = model
    return result
