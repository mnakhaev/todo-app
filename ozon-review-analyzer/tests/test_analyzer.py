import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from analyzer import analyze, score_reviews  # noqa: E402
from fetcher import extract_next_page, extract_reviews, product_path, product_sku  # noqa: E402
from ozon_reviews import render_report  # noqa: E402


def ozon_review(uid, score, comment="", positive="", negative="", ts=1_700_000_000, purchased=True, name="Иван"):
    return {
        "uuid": uid,
        "author": {"firstName": name, "lastName": "П."},
        "content": {"score": score, "comment": comment, "positive": positive, "negative": negative, "photos": []},
        "publishedAt": ts,
        "isItemPurchased": purchased,
        "usefulness": {"useful": 1, "unuseful": 0},
    }


def ozon_page(reviews, next_page=None):
    state = {"reviews": reviews, "paging": {"total": len(reviews)}}
    if next_page:
        state["nextPage"] = next_page
    return {"widgetStates": {"webListReviews-123-default-1": json.dumps(state, ensure_ascii=False)}}


class FetcherParsing(unittest.TestCase):
    def test_product_path(self):
        url = "https://www.ozon.ru/product/chaynik-elektricheskiy-123456789/?asb=xyz&sh=1"
        self.assertEqual(product_path(url), "/product/chaynik-elektricheskiy-123456789/")
        self.assertEqual(product_sku(product_path(url)), "123456789")
        self.assertEqual(product_path("https://ozon.ru/product/chaynik-123456789/reviews/"), "/product/chaynik-123456789/")

    def test_extract_from_widget_state_string(self):
        page = ozon_page(
            [ozon_review("a", 5, "Отличный чайник"), ozon_review("b", 2, "Течёт через неделю", purchased=False)],
            next_page="/product/x-1/reviews/?page=2",
        )
        reviews = extract_reviews(page)
        self.assertEqual([r["id"] for r in reviews], ["a", "b"])
        self.assertEqual(reviews[0]["rating"], 5)
        self.assertEqual(reviews[0]["author"], "Иван П.")
        self.assertIs(reviews[1]["verified_purchase"], False)
        self.assertTrue(reviews[0]["date"].startswith("2023-11-14"))
        self.assertEqual(extract_next_page(page), "/product/x-1/reviews/?page=2")


def build_dataset():
    day = 86_400
    base = 1_700_000_000
    real = [
        ("Чайник закипает за 3 минуты, литр воды", "Быстро кипятит, удобная крышка", "Корпус сильно нагревается", 4),
        ("Пользуюсь месяц, пока без нареканий. Шумный немного", "Объём 1.7 л, стекло", "Шумный", 4),
        ("Через две недели появилась ржавчина на дне, вернула", "", "Ржавчина, брак", 1),
        ("Удобная крышка, но корпус нагревается", "Удобная крышка", "Корпус нагревается", 3),
        ("Кипятит быстро, крышка открывается одной рукой, подсветка красивая", "Быстро кипятит", "Нет", 5),
        ("Появился запах пластика, первые дни вода с привкусом", "Дизайн", "Запах пластика", 2),
        ("Удобная крышка, кнопка отключения работает чётко", "Удобная крышка", "Короткий шнур", 4),
        ("Шнур короткий, приходится ставить у розетки", "Быстро кипятит", "Короткий шнур", 3),
    ]
    # у каждой копии реального отзыва своя уникальная деталь, чтобы они не были дубликатами
    details = [
        "Брала на дачу вместо старого Tefal", "Стоит на кухне в офисе, пользуются человек десять",
        "Подарили родителям на годовщину свадьбы", "Кипячу воду для чая пять раз в день",
        "Заказывала в пункт выдачи возле дома, забрала через два дня", "Сравнивала с Polaris за ту же цену",
        "Муж сначала был против стеклянного корпуса", "Живём в Казани, вода жёсткая, накипь есть",
        "Использую в общежитии на третьем этаже", "Взяли по скидке во время распродажи осенью",
        "Работаю из дома, чайник включаю постоянно", "Дети пользуются сами, кнопка им удобна",
    ]
    reviews = [
        ozon_review(f"r{i}", sc, f"{c}. {details[i % len(details)]} ({i})", p, n, ts=base + i * 3 * day, name=f"Автор{i}")
        for i, (c, p, n, sc) in enumerate(real * 3)
    ]
    # Накрутка: одинаковые шаблонные 5★ в один день, без покупки
    fake_text = "Отличный товар, всем рекомендую! Качество на высоте, доставка быстрая, продавцу спасибо!!!"
    for i in range(12):
        reviews.append(ozon_review(f"f{i}", 5, fake_text, "Всё супер", "Нет", ts=base + 30 * day + i, purchased=False, name=f"Фейк{i}"))
    for i in range(6):
        reviews.append(ozon_review(f"s{i}", 5, "Супер", ts=base + 30 * day + 100 + i, purchased=False, name=f"Коротко{i}"))
    return extract_reviews(ozon_page(reviews))


class Analysis(unittest.TestCase):
    def setUp(self):
        self.reviews = build_dataset()

    def test_fake_detection(self):
        scored = {r["id"]: r for r in score_reviews(self.reviews)}
        fakes = [r for k, r in scored.items() if k.startswith(("f", "s"))]
        reals = [r for k, r in scored.items() if k.startswith("r")]
        self.assertTrue(all(r["fake_label"] == "fake" for r in fakes), [r["fake_reasons"] for r in fakes])
        self.assertLessEqual(sum(r["fake_label"] == "fake" for r in reals), 1)
        self.assertIn("duplicate", scored["f0"]["fake_reasons"])
        self.assertIn("unverified", scored["f0"]["fake_reasons"])

    def test_summary_and_themes(self):
        a = analyze(self.reviews)
        self.assertEqual(a["total_reviews"], 42)
        self.assertAlmostEqual(a["fake_share"], 18 / 42, delta=0.05)
        self.assertLess(a["ratings_without_fake"]["mean"], a["ratings_all"]["mean"])
        pros = " ".join(t["theme"] for t in a["themes"]["pros"])
        cons = " ".join(t["theme"] for t in a["themes"]["cons"])
        self.assertIn("крышк", pros)
        self.assertTrue("шнур" in cons or "нагрева" in cons, cons)
        report = render_report({"title": "Чайник"}, a, None, examples=5)
        self.assertIn("Вероятно фейковые", report)

    def test_empty(self):
        self.assertEqual(analyze([])["total_reviews"], 0)


if __name__ == "__main__":
    unittest.main()
