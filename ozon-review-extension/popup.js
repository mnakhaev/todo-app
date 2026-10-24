(async () => {
  const msg = document.getElementById("msg");
  const run = document.getElementById("run");
  const open = document.getElementById("open");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isOzon = tab && /^https:\/\/(www\.)?ozon\.ru\//.test(tab.url || "");
  if (!isOzon) {
    msg.textContent = "Откройте страницу товара на ozon.ru — расширение работает только там.";
    return;
  }
  let status = null;
  try {
    status = await chrome.tabs.sendMessage(tab.id, { type: "ora:status" });
  } catch (_) {
    msg.textContent = "Обновите страницу Ozon (F5), чтобы расширение подключилось к ней.";
    return;
  }
  if (!status || !status.isProduct) {
    msg.textContent = "Откройте карточку конкретного товара — ссылка вида ozon.ru/product/…";
    return;
  }
  msg.textContent = status.running ? "Анализ уже идёт — смотрите панель на странице." : "Расширение скачает все отзывы и проверит их на накрутку.";
  run.hidden = status.running;
  open.hidden = false;
  const send = async (runNow) => {
    await chrome.tabs.sendMessage(tab.id, { type: "ora:open", run: runNow });
    window.close();
  };
  run.addEventListener("click", () => send(true));
  open.addEventListener("click", () => send(false));
})();
