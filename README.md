# CalenPulse

Расширение для Edge/Chrome: Google Календарь в боковой панели + напоминания в браузере, Telegram и Discord.
Плюс мини-сервер, который опрашивает календарь и присылает напоминания 24/7 — даже когда компьютер выключен.

- **Расширение** — MV3, боковая панель (side panel), создание/редактирование/удаление событий,
  выбор календаря при создании, сетка календаря (2 недели / неделя / месяц), локальные уведомления.
- **Сервер** — Node.js + Express, шифрует конфиги (AES-256-GCM), опрашивает Calendar API каждые 30 секунд,
  шлёт в Telegram Bot API и Discord webhook.
- **Один код** — из Edge Add-ons ставится в Chrome и наоборот.

## Архитектура

```
┌──────────────── расширение (Edge / Chrome) ────────────────┐
│  side panel ──► Google Calendar API v3 (OAuth, calendar.events)
│  chrome.alarms ──► уведомления в браузере (пока браузер запущен)
│  options: токены каналов, адрес сервера, ключ синхронизации │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTPS PUT /api/account
                            │ (refresh token + настройки каналов)
                  ┌─────────▼──────────┐
                  │  ваш сервер        │  опрос раз в 30 с
                  │  Node + Express    │──► api.telegram.org
                  │  data/accounts.json│──► discord.com/api/webhooks
                  └────────────────────┘
```

Без сервера расширение полностью работает как обычный календарь с браузерными напоминаниями.
Сервер добавляет 24/7-доставку в Telegram/Discord.

## Структура

```
extension/            MV3-расширение (загружается как unpacked, пакуется в zip для стора)
  manifest.json
  background.js       OAuth, alarms, локальные уведомления, прокси Calendar API
  lib/                auth, calendar (включая палитру цветов), event-editor, settings, server sync
  sidepanel.html/js   список событий и фильтры
  calendar.html/js    сетка календаря: 2 недели / неделя / месяц, создание растягиванием, карточка события
  options.html/js     подключение Google, каналы, адрес сервера, ключ
  privacy.html        политика конфиденциальности (страница внутри расширения)
  icons/              PNG 16/32/48/128
server/               сервер 24/7
  src/index.js        HTTP API (sync key, rate limit, HTTPS-only)
  src/poller.js       опрос календаря и отправка напоминаний
  src/google.js       refresh token → access token, events.list
  src/notify.js       Telegram / Discord + форматирование текста
  src/crypto.js       AES-256-GCM для данных на диске
  src/store.js        атомарное JSON-хранилище
  ecosystem.config.cjs
tools/make_icons.py   генератор иконок без зависимостей
docs/                 страницы для GitHub Pages (политика конфиденциальности для стора)
```

---

## 1. Google Cloud Console

1. Создайте проект на [console.cloud.google.com](https://console.cloud.google.com/).
2. **APIs & Services → Library → Google Calendar API → Enable.**
3. **OAuth consent screen**: тип **External**, название `CalenPulse`, укажите e-mail поддержки и контакт разработчика.
   - В разделе **Scopes** добавьте `https://www.googleapis.com/auth/calendar.events`
     и `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
   - Пока приложение в статусе **Testing**, в **Test users** добавьте аккаунты, которым разрешён вход (до 100).
4. **Credentials → Create credentials → OAuth client ID**, тип **Web application**:
   - Name: `CalenPulse Web`;
   - **Authorized redirect URIs → Add URI** → адрес из настроек расширения
     («Данные для Google Cloud Console», раздел 2);
   - **Create** → скопируйте **Client ID** и **Client secret**.

   > Альтернатива — тип **Chrome Extension**: тогда redirect URI не нужен, вместо него
   > указывается **Item ID** (ID расширения), а секрет не требуется. В части версий Edge
   > этот тип отдаёт `redirect_uri_mismatch`; Web application надёжнее.
5. **Client ID** впишите в [`extension/lib/config.js`](extension/lib/config.js) — он публичный.
   **Client secret** вставьте в настройках расширения (раздел **OAuth-клиент**): он хранится
   только в `chrome.storage.local`, в репозиторий и в git-историю не попадает.

> Redirect URI показан в настройках расширения кнопкой «Скопировать redirect URI».
> Для типа **Web application** он должен быть добавлен в Authorized redirect URIs
> ровно как скопирован, со слэшем в конце.

## 2. Расширение

1. Откройте `edge://extensions` (или `chrome://extensions`), включите **Режим разработчика**.
2. **Загрузить распакованное** → выберите папку `extension/`.
3. Скопируйте ID расширения, вставьте в OAuth-клиент (шаг 1.4), откройте настройки →
   **OAuth-клиент** и вставьте Client secret (Client ID уже указан в `lib/config.js`).
4. Нажмите **Обновить** на карточке расширения.
5. Откройте настройки (⚙ в боковой панели) → **Подключить Google**.
6. Для 24/7: заполните адрес сервера и ключ синхронизации (кнопка «Сгенерировать»),
   нажмите **Сохранить и синхронизировать** и разрешите доступ к адресу сервера.

## 3. Сервер

Требуется Ubuntu/Debian, Node.js 20+, домен с A-записью на IP сервера (для HTTPS).
Или Cloudflare Tunnel без домена и открытых портов (см. 3.6).

### 3.1. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
```

```bash
sudo apt install -y nodejs
```

```bash
node -v
```

### 3.2. Код

```bash
sudo mkdir -p /opt/calenpulse && sudo chown "$USER":"$USER" /opt/calenpulse
```

```bash
git clone https://github.com/<ваш-логин>/CalenPulse.git /opt/calenpulse
```

### 3.3. Зависимости и конфиг

```bash
cd /opt/calenpulse/server && npm ci --omit=dev
```

```bash
cp /opt/calenpulse/server/.env.example /opt/calenpulse/server/.env
```

Проверка локально (без HTTPS):

```bash
cd /opt/calenpulse/server && ALLOW_HTTP=1 node src/index.js
```

```bash
curl -s http://127.0.0.1:8787/healthz
```

Ожидаемый ответ: `{"ok":true}`. Остановите процесс (Ctrl+C).

### 3.4. HTTPS через Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
calendar.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo systemctl reload caddy
```

Caddy сам получит сертификат Let's Encrypt. Порты 80/443 должны быть открыты:

```bash
sudo ufw allow 80,443/tcp
```

Проверка: `curl -s https://calendar.example.com/healthz`

### 3.5. pm2 (автозапуск)

```bash
sudo npm install -g pm2
```

```bash
cd /opt/calenpulse/server && pm2 start ecosystem.config.cjs
```

```bash
pm2 save
```

```bash
pm2 startup
```

Выполните команду, которую выведет `pm2 startup`, затем ещё раз `pm2 save`.

### 3.6. Вариант без домена: Cloudflare Tunnel

Порт 443 часто бывает занят (у нас его держит nginx из docker-стека мониторинга), а выпускать
порт наружу не нужно: `cloudflared` сам устанавливает исходящее соединение с Cloudflare и отдаёт
готовый HTTPS-адрес. Расширение принимает только `https://`, поэтому фронт обязателен.

Бинарник без репозитория:

```bash
curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod 755 /usr/local/bin/cloudflared
```

Юнит `/etc/systemd/system/calenpulse-tunnel.service`:

```ini
[Unit]
Description=CalenPulse quick tunnel
After=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now calenpulse-tunnel
```

Текущий адрес (меняется при каждом перезапуске туннеля):

```bash
journalctl -u calenpulse-tunnel --no-pager | grep -o "https://[a-z0-9-]*\.trycloudflare\.com" | sort -u | tail -1
```

Если адрес сменился — обновите его в настройках расширения и нажмите «Сохранить и
синхронизировать». Для постоянной работы лучше именованный туннель со своим доменом
(Cloudflare выдаст стабильный `https://calenpulse.example.com`) или домен + Caddy (3.4).

### 3.6.1. Что задеплоено сейчас

```
сервер          87.58.205.57 (Ubuntu 24.04, Node 22)
код             /opt/calenpulse/server
pm2             calenpulse (порт 8787, наружу закрыт ufw) + соседний ds-bot не трогали
https           systemd-юнит calenpulse-tunnel → https://<случайное>.trycloudflare.com
данные          /opt/calenpulse/server/data/{accounts.json,enc.key}
```

Проверка после любой перезагрузки:

```bash
pm2 ls && systemctl is-active calenpulse-tunnel && curl -s "$(journalctl -u calenpulse-tunnel --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)/healthz"
```

Ожидаемый ответ: `{"ok":true}`.

### 3.7. Подключение расширения

В настройках расширения укажите адрес (`https://calendar.example.com`), сгенерируйте ключ
синхронизации и нажмите **Сохранить и синхронизировать**. Затем **Тест каналов на сервере**.

Данные сервера:

```
server/data/accounts.json   зашифрованные конфиги пользователей
server/data/enc.key         ключ шифрования (не коммитить, сделать бэкап)
```

### 3.8. CLI владельца (вместо веб-админки)

`server/tools/admin.mjs` работает напрямую с `data/accounts.json` и `data/enc.key`, поэтому
наружу не добавляется новая поверхность атаки. Секреты (refresh token, client secret,
токен бота, webhook URL) утилита не печатает — только адрес аккаунта, название, число календарей,
интервалы, статус каналов и метки времени.

```bash
cd /opt/calenpulse/server
node tools/admin.mjs list                    # все аккаунты: хеш, почта, каналы, когда синхронизировались
node tools/admin.mjs show 3a8f               # подробности по префиксу хеша
node tools/admin.mjs delete 3a8f --restart   # удалить запись
node tools/admin.mjs purge --days 30         # удалить все, что не синхронизировалось 30 дней
```

С флагом `--restart` утилита делает `pm2 stop → правка файла → pm2 start`. Без флага она правит
только файл и подсказывает команды: приложение держит записи в памяти и на остановке перезаписывает
`accounts.json` собой, поэтому править файл у запущенного процесса бессмысленно — запись вернётся.

## 4. Как это проверить целиком

1. **События**: в боковой панели виден список на 2 недели; создайте событие — проверьте в Google Календаре.
   В форме можно выбрать календарь; у события заливка — его цвет, кромка — цвет календаря.
2. **Сетка**: кнопка ▦ в шапке панели открывает вкладку с видами «2 недели / Неделя / Месяц».
   Зажмите и растяните мышью в колонке дня — создастся событие на это время; в месяце
   достаточно кликнуть по дню. Клик по событию открывает карточку с деталями, там же его
   можно переименовать (клик по названию), изменить, удалить или открыть в Google.
3. **Браузер**: настройки → «Проверить уведомление»; затем событие через 5–10 минут с интервалом «5 мин».
4. **Telegram/Discord**: кнопки «Тест Telegram» / «Тест Discord».
5. **24/7**: после синхронизации закройте браузер и дождитесь напоминания в Telegram/Discord.
6. **Дедупликация**: одно и то же напоминание не должно прийти дважды.

## 5. Публикация в сторах

- **Edge Add-ons** — бесплатно: [partner.microsoft.com/dashboard/microsoftedge](https://partner.microsoft.com/dashboard/microsoftedge).
- **Chrome Web Store** — разовый взнос $5: [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).
- ZIP для загрузки: содержимое папки `extension/` (манифест должен лежать в корне архива).
- Название в сторе не должно начинаться с «Google»: используйте, например,
  **«CalenPulse — Calendar alerts»**, а слово Google — только в описании.
- Материалы: иконка 128×128, минимум 1 скриншот 1280×800 (лучше 3–5), промо 440×280 для Edge.
- URL политики конфиденциальности: разместите `docs/` на GitHub Pages
  (Settings → Pages → Source: `main` / `/docs`). Ссылку на `privacy.html` указывайте в сторе.
- Перед публикацией замените `support@example.com` в `docs/privacy.html`,
  `docs/index.html` и `extension/privacy.html` на реальный контакт.
- **Верификация Google OAuth**: пока consent screen в статусе Testing, работают только 100 тестовых
  пользователей. Для публичного доступа нужна верификация sensitive scope `calendar.events`:
  скринкаст работы, обоснование scope, публичная политика конфиденциальности, домен разработчика.
  Обычно 1–4 недели. Код к этому готов: нет удалённого кода, нет динамических URL,
  запросы только к Google API и к серверу, который пользователь указал сам.
- В форме Data usage укажите: используется календарь (чтение/запись) и передача напоминаний
  в Telegram/Discord по выбору пользователя.

## 6. Ограничения MVP

- Показываются все календари, отмеченные галочкой в Google Календаре; заливка события берётся
  из его собственного цвета (если он задан), а кромка — из цвета календаря, как в Google.
  Скрытые календари и календари с доступом «только занятость» не выводятся.
- События календарей только для чтения открываются в Google Календаре, редактировать их из панели нельзя.
- Сменить календарь у уже созданного события нельзя — форма показывает его и блокирует выбор;
  в Google Календаре для этого есть «Переместить».
- Сервер 24/7 опрашивает все календари, отмеченные в Google Календаре, и синхронизирует
  этот список каждые 30 минут; фильтры в панели влияют только на отображение.
- События «на весь день» показываются, но напоминания по ним не отправляются.
- Браузерные уведомления работают только при запущенном браузере; 24/7 обеспечивает сервер.
- Сервер хранит данные в JSON-файле — этого достаточно для сотен пользователей; для больших
  нагрузок замените `server/src/store.js` на SQLite/Postgres.
- Опрос каждые 30 секунд на пользователя: квота Calendar API 1 000 000 запросов/день,
  один календарь расходует ~2 880 запросов/день, поэтому N календарей — примерно N × 2 880.
  При десятках пользователей увеличьте `POLL_INTERVAL_MS`.
- Сервер должен иметь исходящий доступ к `oauth2.googleapis.com`, `www.googleapis.com`,
  `api.telegram.org`, `discord.com`. Если Discord блокируется сетью сервера — используйте VPS
  в другой стране.

## 7. Безопасность

- Обмен с сервером только по HTTPS (`ALLOW_HTTP=1` — только для локальной отладки).
- `data/enc.key` и `data/accounts.json` создаются с правами `600`, каталог — `700`.
- Ключ синхронизации не хранится на сервере: в базе лежит только SHA-256 от него.
- Refresh token и токены каналов шифруются AES-256-GCM; сервер не отдаёт их в API.
- Для идентификации записи сервер хранит адрес аккаунта Google (`email`) — это `id` primary-календаря,
  который Google отдаёт по уже запрошенным скоупам; отдельных скоупов на профиль/почту не просим.
  Адрес лежит в том же зашифрованном блобе и наружу не отправляется.
- Записи, которые не синхронизировались из расширения дольше `ACCOUNT_TTL_DAYS` (по умолчанию 30),
  поллер удаляет сам: вместе с refresh token и токенами каналов. Это чистит «сирот» после того,
  как пользователь удалил расширение и потерял ключ.
- «Отключить Google» удаляет токены из браузера **и** шлёт `DELETE /api/account` — сервер теряет
  refresh token и каналы, рассылка прекращается. Кнопка «Удалить меня с сервера» делает только это,
  оставляя Google подключённым.
- Client secret хранится только в `chrome.storage.local` (страница настроек) и в публичном
  репозитории отсутствует; Client ID публичный по определению.
- Сделайте бэкап `data/enc.key`: без него расшифровать `accounts.json` невозможно.

## 8. Git

Репозиторий: **`CalenPulse`**

Описание (GitHub, короткое): `Google Calendar side panel for Edge/Chrome with browser, Telegram and Discord reminders and a 24/7 polling backend.`

Описание (RU): `Боковая панель Google Календаря для Edge/Chrome и напоминания в браузере, Telegram и Discord, включая сервер 24/7.`

```bash
git init -b main
```

```bash
git add .
```

```bash
git commit -m "feat: CalenPulse 0.2.0 — мультикалендарь с цветами и напоминания в браузере, Telegram и Discord"
```

```bash
gh repo create CalenPulse --private --description "Google Calendar side panel for Edge/Chrome with browser, Telegram and Discord reminders and a 24/7 polling backend." --source=. --remote=origin
```

```bash
git push -u origin main
```

Или без `gh`: создайте пустой репозиторий `CalenPulse` на GitHub и выполните
`git remote add origin https://github.com/<логин>/CalenPulse.git`, затем `git push -u origin main`.
