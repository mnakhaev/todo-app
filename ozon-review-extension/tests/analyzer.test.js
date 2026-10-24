// Запуск: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze, scoreReviews } = require("../src/analyzer.js");
const { extractReviews, extractNextPage, productPath, productSku } = require("../src/fetcher.js");

function ozonReview(uid, score, comment = "", positive = "", negative = "", ts = 1_700_000_000, purchased = true, name = "Иван") {
  return {
    uuid: uid,
    author: { firstName: name, lastName: "П." },
    content: { score, comment, positive, negative, photos: [] },
    publishedAt: ts,
    isItemPurchased: purchased,
    usefulness: { useful: 1, unuseful: 0 },
  };
}

function ozonPage(reviews, nextPage) {
  const state = { reviews, paging: { total: reviews.length } };
  if (nextPage) state.nextPage = nextPage;
  return { widgetStates: { "webListReviews-123-default-1": JSON.stringify(state) } };
}

function buildDataset() {
  const day = 86_400;
  const base = 1_700_000_000;
  const real = [
    ["Хрустит отлично, арахиса много, остроты хватает даже детям", "Хрустящий, много арахиса", "Маленькая упаковка", 5],
    ["Брали к рису, вкус насыщенный, но масла многовато", "Насыщенный вкус", "Много масла", 4],
    ["Перчик оказался не острый совсем, хотя написано слабая острота", "Хрустящий", "Совсем не острый", 3],
    ["Банка пришла с подтёками масла, внутри всё нормально", "Вкусный", "Подтёки масла", 4],
    ["Через неделю после вскрытия стал мягким, хруст пропал", "", "Быстро теряет хруст", 2],
    ["Слишком солёный на мой вкус, есть неприятная горечь", "Упаковка удобная", "Пересолен", 2],
    ["Отличная закуска к пиву, много арахиса и кунжута", "Много арахиса", "Маленькая упаковка", 5],
    ["Пересолен, но к лапше подходит хорошо", "К лапше подходит", "Пересолен", 3],
  ];
  const details = [
    "Покупала второй раз в пункте выдачи у дома", "Ели вдвоём за один вечер", "Сравнивала с Лаоганьма",
    "Брали на пробу по акции", "Муж не любит острое, но этот ест", "Заказ пришёл за три дня в Казань",
    "Добавляю в салаты и к пельменям", "Банка 120 грамм заканчивается быстро", "Дети едят прямо ложкой",
    "Хранила в холодильнике, как написано", "Пробовала в ресторане похожий соус", "Беру уже третью банку подряд",
  ];
  const reviews = [];
  for (let i = 0; i < real.length * 3; i++) {
    const [c, p, n, sc] = real[i % real.length];
    reviews.push(ozonReview(`r${i}`, sc, `${c}. ${details[i % details.length]} (${i})`, p, n, base + i * 3 * day, true, `Автор${i}`));
  }
  const fakeText = "Отличный товар, всем рекомендую! Качество на высоте, доставка быстрая, продавцу спасибо!!!";
  for (let i = 0; i < 12; i++) reviews.push(ozonReview(`f${i}`, 5, fakeText, "Всё супер", "Нет", base + 30 * day + i, false, `Фейк${i}`));
  for (let i = 0; i < 6; i++) reviews.push(ozonReview(`s${i}`, 5, "Супер", "", "", base + 30 * day + 100 + i, false, `Коротко${i}`));
  return extractReviews(ozonPage(reviews));
}

test("product path and sku", () => {
  const url = "https://www.ozon.ru/product/snek-hrustyashchiy-perchik-3204277670/?at=xyz&sh=1";
  assert.equal(productPath(url), "/product/snek-hrustyashchiy-perchik-3204277670/");
  assert.equal(productSku(productPath(url)), "3204277670");
  assert.equal(productPath("/product/x-123456/reviews/"), "/product/x-123456/");
  assert.equal(productPath("/category/sneki/"), null);
});

test("reviews are extracted from widgetStates JSON strings", () => {
  const page = ozonPage([ozonReview("a", 5, "Отличный"), ozonReview("b", 2, "Невкусно", "", "", 1_700_000_000, false)], "/product/x-1/reviews/?page=2");
  const rs = extractReviews(page);
  assert.deepEqual(rs.map((r) => r.id), ["a", "b"]);
  assert.equal(rs[0].author, "Иван П.");
  assert.equal(rs[1].verified_purchase, false);
  assert.ok(rs[0].date.startsWith("2023-11-14"));
  assert.equal(extractNextPage(page), "/product/x-1/reviews/?page=2");
});

test("fake reviews are detected, real ones are not", () => {
  const scored = Object.fromEntries(scoreReviews(buildDataset()).map((r) => [r.id, r]));
  const fakes = Object.values(scored).filter((r) => /^[fs]/.test(r.id));
  const reals = Object.values(scored).filter((r) => r.id.startsWith("r"));
  assert.ok(fakes.every((r) => r.fake_label === "fake"), JSON.stringify(fakes.map((r) => r.fake_reasons)));
  assert.ok(reals.filter((r) => r.fake_label === "fake").length <= 1);
  assert.ok(scored.f0.fake_reasons.includes("duplicate"));
  assert.ok(scored.f0.fake_reasons.includes("unverified"));
  assert.ok(scored.f0.fake_reasons.includes("burst"));
});

test("summary, verdict and themes", () => {
  const a = analyze(buildDataset());
  assert.equal(a.total_reviews, 42);
  assert.ok(Math.abs(a.fake_share - 18 / 42) < 0.05);
  assert.ok(a.ratings_without_fake.mean < a.ratings_all.mean);
  assert.equal(a.verdict.level, "high");
  const pros = a.themes.pros.map((t) => t.theme.toLowerCase()).join(" | ");
  const cons = a.themes.cons.map((t) => t.theme.toLowerCase()).join(" | ");
  assert.match(pros, /арахис/);
  assert.match(cons, /пересол|масл|упаковк/);
  assert.ok(a.monthly.length >= 2);
});

test("clean product gets a low-risk verdict", () => {
  const rs = buildDataset().filter((r) => r.id.startsWith("r"));
  const a = analyze(rs);
  assert.equal(a.labels.fake, 0);
  assert.equal(a.verdict.level, "low");
});

test("review text is never interpreted as a regex or crashes on odd input", () => {
  const a = analyze([{ id: "x", rating: null, text: "((( [ ** ", pros: "", cons: "", date: "bad-date", author: "" }]);
  assert.equal(a.total_reviews, 1);
  assert.equal(analyze([]).verdict.level, "unknown");
});

module.exports = { buildDataset };
