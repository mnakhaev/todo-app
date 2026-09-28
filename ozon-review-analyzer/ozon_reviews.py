#!/usr/bin/env python3
"""Анализ отзывов о товаре Ozon: доля вероятно фейковых отзывов, плюсы и минусы.

Примеры:
  python ozon_reviews.py "https://www.ozon.ru/product/nazvanie-123456789/"
  python ozon_reviews.py URL --report report.md --csv reviews.csv --save reviews.json
  python ozon_reviews.py --from-json reviews.json --llm     # повторный анализ без скачивания
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from analyzer import SIGNALS, analyze
from fetcher import DEFAULT_PROFILE_DIR, fetch_reviews

LABELS_RU = {"fake": "вероятно фейк", "doubtful": "сомнительный", "genuine": "похож на настоящий"}


def bar(share: float, width: int = 30) -> str:
    filled = round(share * width)
    return "█" * filled + "░" * (width - filled)


def render_report(product: dict, a: dict, llm: dict | None, examples: int) -> str:
    out: list[str] = []
    title = product.get("title") or product.get("url") or "товар"
    out.append(f"# Анализ отзывов: {title}")
    if product.get("url"):
        out.append(f"\n{product['url']}")
    n = a["total_reviews"]
    out.append(f"\nСобрано отзывов: **{n}**")
    if n == 0:
        out.append("\nОтзывы не найдены.")
        return "\n".join(out)

    ra, rg = a["ratings_all"], a["ratings_without_fake"]
    out.append("\n## Рейтинг\n")
    out.append(f"- Средний по всем отзывам: **{ra['mean']:.2f}**")
    if rg["mean"] is not None:
        out.append(f"- Без вероятно фейковых: **{rg['mean']:.2f}**")
    out.append("\n```")
    for star, cnt in ra["distribution"].items():
        share = cnt / ra["count"] if ra["count"] else 0
        out.append(f"{star}★ {bar(share)} {cnt:>5} ({share:.0%})")
    out.append("```")

    out.append("\n## Фейковые отзывы (эвристика)\n")
    out.append(f"- Вероятно фейковые: **{a['fake_share']:.1%}** ({a['labels'].get('fake', 0)} шт.)")
    out.append(f"- Сомнительные: **{a['doubtful_share']:.1%}** ({a['labels'].get('doubtful', 0)} шт.)")
    out.append(f"- Ожидаемая доля фейков (среднее по вероятностям): **{a['expected_fake_share']:.1%}**")
    if a["reasons"]:
        out.append("\nСработавшие признаки:\n")
        out.append("| Признак | Отзывов |\n|---|---|")
        for info in a["reasons"].values():
            out.append(f"| {info['description']} | {info['count']} |")
    if a["product_signals"]:
        out.append("\nПризнаки на уровне товара:\n")
        out.extend(f"- {s}" for s in a["product_signals"])

    if llm:
        out.append(f"\n## Оценка Claude ({llm['model']}, проанализировано {llm['reviews_sent']} отзывов)\n")
        out.append(f"- Доля накрученных отзывов по оценке модели: **{llm['fake_share_estimate']:.1%}**")
        if llm["fake_patterns"]:
            out.append("- Обнаруженные паттерны:")
            out.extend(f"  - {p}" for p in llm["fake_patterns"])
        for key, name in (("pros", "Плюсы"), ("cons", "Минусы")):
            out.append(f"\n### {name}\n")
            for t in llm[key] or []:
                out.append(f"- **{t['theme']}** — {t['mentions']} упом. _«{t['quote']}»_")
            if not llm[key]:
                out.append("- не выявлено")
        out.append(f"\n### Итог\n\n{llm['verdict']}")

    out.append("\n## Плюсы и минусы (частотный анализ, без фейковых отзывов)\n")
    for key, name in (("pros", "Плюсы"), ("cons", "Минусы")):
        out.append(f"\n### {name}\n")
        themes = a["themes"].get(key) or []
        if not themes:
            out.append("- недостаточно данных")
        for t in themes:
            ex = "" if t["example"].lower() == t["theme"].lower() else f"; напр.: _«{t['example']}»_"
            out.append(f"- **{t['theme']}** — {t['mentions']} отз. ({t['share']:.0%}){ex}")

    if examples:
        worst = sorted(a["reviews"], key=lambda r: r["fake_score"], reverse=True)[:examples]
        worst = [r for r in worst if r["fake_score"] >= 0.3]
        if worst:
            out.append(f"\n## Самые подозрительные отзывы (топ-{len(worst)})\n")
            for r in worst:
                txt = " / ".join(x for x in (r.get("pros"), r.get("cons"), r.get("text")) if x).replace("\n", " ")
                reasons = "; ".join(SIGNALS[c][1] for c in r["fake_reasons"])
                out.append(
                    f"- `{r['fake_score']:.2f}` {r.get('rating')}★ {(r.get('date') or '')[:10]} "
                    f"{r.get('author') or '—'}: «{txt[:200]}{'…' if len(txt) > 200 else ''}»  \n  _{reasons}_"
                )

    out.append(
        "\n---\n_Оценка вероятностная: признаки указывают на возможную накрутку, но не доказывают её. "
        "Смотрите причины у конкретных отзывов._"
    )
    return "\n".join(out)


def write_csv(path: Path, reviews: list[dict]) -> None:
    cols = [
        "id", "date", "rating", "author", "verified_purchase", "likes", "photos", "fake_score",
        "fake_label", "fake_reasons", "pros", "cons", "text",
    ]
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore", delimiter=";")
        w.writeheader()
        for r in reviews:
            w.writerow({**r, "fake_reasons": ", ".join(r["fake_reasons"]), "fake_label": LABELS_RU[r["fake_label"]]})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Анализ отзывов о товаре Ozon: фейки, плюсы, минусы.")
    ap.add_argument("url", nargs="?", help="ссылка на товар Ozon")
    ap.add_argument("--from-json", type=Path, help="не скачивать, а взять отзывы из файла, сохранённого через --save")
    ap.add_argument("--save", type=Path, help="сохранить скачанные отзывы в JSON")
    ap.add_argument("--report", type=Path, help="сохранить отчёт в Markdown")
    ap.add_argument("--csv", type=Path, help="сохранить отзывы с оценками подозрительности в CSV")
    ap.add_argument("--json-out", type=Path, help="сохранить полный результат анализа в JSON")
    ap.add_argument("--max-pages", type=int, default=500, help="максимум страниц отзывов (по умолчанию 500)")
    ap.add_argument("--delay", type=float, default=1.0, help="пауза между страницами, сек")
    ap.add_argument("--headless", action="store_true", help="скрытый браузер (Ozon чаще блокирует)")
    ap.add_argument("--profile-dir", type=Path, default=DEFAULT_PROFILE_DIR, help="папка профиля браузера (сохраняет cookies)")
    ap.add_argument("--debug-dir", type=Path, help="сохранять сырые ответы Ozon для отладки")
    ap.add_argument("--top", type=int, default=10, help="сколько тем плюсов/минусов показывать")
    ap.add_argument("--examples", type=int, default=10, help="сколько самых подозрительных отзывов показать")
    ap.add_argument("--llm", action="store_true", help="дополнительно проанализировать отзывы через Claude API")
    ap.add_argument("--llm-model", default=None, help="модель Claude (по умолчанию claude-opus-5)")
    ap.add_argument("--llm-max-reviews", type=int, default=800, help="сколько отзывов максимум отправлять в Claude")
    args = ap.parse_args(argv)

    if args.from_json:
        data = json.loads(args.from_json.read_text(encoding="utf-8"))
        product, reviews = data.get("product", {}), data["reviews"]
    elif args.url:
        product, reviews = fetch_reviews(
            args.url,
            max_pages=args.max_pages,
            headless=args.headless,
            profile_dir=args.profile_dir,
            delay_s=args.delay,
            debug_dir=args.debug_dir,
        )
    else:
        ap.error("укажите ссылку на товар или --from-json")

    if args.save:
        args.save.write_text(json.dumps({"product": product, "reviews": reviews}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Отзывы сохранены: {args.save}", file=sys.stderr)

    if not reviews:
        print(
            "Не удалось получить ни одного отзыва. Попробуйте запустить без --headless, "
            "пройти проверку в окне браузера и/или указать --debug-dir ./debug для диагностики.",
            file=sys.stderr,
        )
        return 1

    analysis = analyze(reviews, top_n=args.top)

    llm_result = None
    if args.llm:
        from llm import DEFAULT_MODEL, llm_analyze

        try:
            llm_result = llm_analyze(product, analysis, model=args.llm_model or DEFAULT_MODEL, max_reviews=args.llm_max_reviews)
        except Exception as e:  # отчёт по эвристике всё равно полезен
            print(f"⚠️  LLM-анализ не выполнен: {e}", file=sys.stderr)

    report = render_report(product, analysis, llm_result, args.examples)
    print(report)
    if args.report:
        args.report.write_text(report, encoding="utf-8")
        print(f"\nОтчёт сохранён: {args.report}", file=sys.stderr)
    if args.csv:
        write_csv(args.csv, analysis["reviews"])
        print(f"CSV сохранён: {args.csv}", file=sys.stderr)
    if args.json_out:
        args.json_out.write_text(
            json.dumps({"product": product, "analysis": analysis, "llm": llm_result}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
