# Установка eda+ на Oracle Cloud (бесплатно)

В итоге бот и Mini App будут работать круглосуточно на бесплатном сервере Oracle по адресу вида `https://edaplus.duckdns.org`. HTTPS-сертификат получается и продлевается автоматически, база копируется каждую ночь.

Займёт примерно 1–1,5 часа. Все команды для Windows выполняются в **PowerShell**, команды для сервера — в окне SSH-подключения.

> **Важно:** бот с одним токеном может работать только в одном месте. Если eda+ запущен у вас на компьютере (`npm run dev`), остановите его перед запуском на сервере, иначе Telegram будет выдавать ошибку `409 Conflict`.

---

## Шаг 1. Регистрация в Oracle Cloud

1. Откройте https://www.oracle.com/cloud/free/ и нажмите **Start for free**.
2. Укажите страну, имя и email, подтвердите почту.
3. **Home Region (домашний регион)** выбирается один раз и навсегда — бесплатные серверы создаются только в нём. Выберите ближайший к Кыргызстану, где обычно есть свободные мощности, например **Germany Central (Frankfurt)**, **UAE East (Dubai)** или **India West (Mumbai)**.
4. Введите банковскую карту. Она нужна только для проверки личности: Oracle может временно заблокировать около 1 $ и вернуть. Пока вы не нажмёте «Upgrade to Pay As You Go», с карты ничего не списывается.
5. Дождитесь письма о готовности аккаунта (от нескольких минут до часа) и войдите в https://cloud.oracle.com.

---

## Шаг 2. Создание сервера

1. В меню (☰ слева вверху) откройте **Compute → Instances** и нажмите **Create instance**.
2. **Name:** `eda-plus`.
3. **Image and shape → Edit:**
   - **Image:** Change image → **Canonical Ubuntu**, версия **24.04** (не «Minimal»).
   - **Shape:** Change shape → **Ampere** → **VM.Standard.A1.Flex**, рядом должна быть пометка **Always Free-eligible**. Поставьте **2 OCPU** и **12 GB** памяти (бесплатно до 4 OCPU и 24 GB суммарно).
4. **Networking:** оставьте «Create new virtual cloud network» и **Assign a public IPv4 address = Yes**.
5. **Add SSH keys:** выберите **Generate a key pair for me** и нажмите **Save private key**. Файл (`ssh-key-….key`) — это ключ от сервера: не теряйте и никому не отправляйте.
6. **Boot volume:** можно оставить как есть (бесплатно до 200 GB суммарно).
7. Нажмите **Create**. Через 1–2 минуты статус станет **Running**. Скопируйте **Public IP address** со страницы сервера — дальше он обозначен как `ВАШ_IP`.

**Если появилась ошибка «Out of capacity»** — свободных Ampere-серверов в регионе сейчас нет. Варианты:
- в блоке Placement выберите другой **Availability domain** (AD-2, AD-3) и попробуйте снова;
- повторите через несколько часов (часто помогает ночью);
- или выберите shape **VM.Standard.E2.1.Micro** (AMD, тоже Always Free). У него всего 1 GB памяти, поэтому на шаге 5 обязательно выполните пункт про swap.

---

## Шаг 3. Открыть порты 80 и 443

Нужно для HTTPS. Делается в двух местах.

**3.1. В панели Oracle:**
1. На странице сервера нажмите на ссылку **Subnet** (в блоке Primary VNIC) → вкладка **Security** → **Default Security List for …**.
2. Вкладка **Security rules** → **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Destination Port Range: `80,443`
3. **Add Ingress Rules**.

**3.2. На самом сервере** — сделаете на шаге 5, после подключения.

---

## Шаг 4. Подключение к серверу с Windows

1. Перенесите скачанный ключ в папку `.ssh` и закройте к нему доступ для других пользователей — без этого Windows откажется его использовать:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh"
Move-Item "$env:USERPROFILE\Downloads\ssh-key-*.key" "$env:USERPROFILE\.ssh\oracle.key"
icacls "$env:USERPROFILE\.ssh\oracle.key" /inheritance:r /grant:r "$($env:USERNAME):R"
```

2. Подключитесь (вместо `ВАШ_IP` подставьте адрес сервера):

```powershell
ssh -i "$env:USERPROFILE\.ssh\oracle.key" ubuntu@ВАШ_IP
```

На вопрос `Are you sure you want to continue connecting?` ответьте `yes`. Когда приглашение сменится на `ubuntu@eda-plus:~$`, вы на сервере. Отключиться — команда `exit`.

---

## Шаг 5. Подготовка сервера

Все команды этого шага выполняются **на сервере**.

1. Обновить систему:

```bash
sudo apt update && sudo apt -y upgrade
```

2. Открыть порты 80 и 443 во встроенном файрволе Ubuntu (в образах Oracle он по умолчанию всё блокирует):

```bash
sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
sudo netfilter-persistent save
```

3. Установить Docker:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
```

После этого выполните `exit` и подключитесь снова (шаг 4.2), чтобы права на Docker применились. Проверка: `docker ps` должен вывести пустую таблицу без ошибки.

4. **Только для E2.1.Micro (1 GB памяти)** — добавить файл подкачки, иначе сборка не поместится в память:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

5. Выставить часовой пояс сервера (для времени в логах и копиях):

```bash
sudo timedatectl set-timezone Asia/Bishkek
```

---

## Шаг 6. Бесплатный адрес (DuckDNS)

Telegram открывает Mini App только по HTTPS, а сертификат выдаётся на доменное имя, не на IP.

1. Откройте https://www.duckdns.org и войдите через Google или GitHub.
2. В поле **sub domain** введите имя, например `edaplus`, нажмите **add domain**.
3. В поле **current ip** у нового домена впишите `ВАШ_IP` и нажмите **update ip**.

Ваш адрес: `edaplus.duckdns.org` (дальше — `ВАШ_ДОМЕН`). Проверьте на компьютере: `ping ВАШ_ДОМЕН` должен показать `ВАШ_IP`.

> Если потом купите свой домен, просто добавьте у регистратора A-запись на `ВАШ_IP` и поменяйте `DOMAIN` и `WEBAPP_URL` в `.env` (шаг 8).

---

## Шаг 7. Загрузка проекта на сервер

1. **На компьютере** соберите архив проекта без лишнего и без секретов (`.env`, база и `node_modules` в архив не попадут):

```powershell
cd "$env:USERPROFILE\Downloads"
tar.exe -czf eda.tar.gz --exclude=node_modules --exclude=edaPlus/web/dist --exclude=edaPlus/data --exclude=edaPlus/.env --exclude=.git edaPlus
scp -i "$env:USERPROFILE\.ssh\oracle.key" eda.tar.gz ubuntu@ВАШ_IP:~
```

2. **На сервере** распакуйте:

```bash
tar -xzf eda.tar.gz && rm eda.tar.gz
cd ~/edaPlus
chmod +x scripts/backup.sh
```

---

## Шаг 8. Настройки (.env) на сервере

```bash
cd ~/edaPlus
cp .env.example .env
nano .env
```

Заполните строки (остальное можно не трогать):

```ini
BOT_TOKEN=токен_от_BotFather
WEBAPP_URL=https://ВАШ_ДОМЕН
DOMAIN=ВАШ_ДОМЕН
ADMIN_TELEGRAM_IDS=123456789,987654321
DEV_AUTH=false
```

- `DOMAIN` пишется **без** `https://`, `WEBAPP_URL` — **с** ним.
- Токен скопируйте из своего локального `.env` — в чат и в мессенджеры его не отправляйте.
- Строку `DB_PATH` не добавляйте: база будет храниться в `data/eda.db` внутри тома Docker.

Сохранить в nano: **Ctrl+O**, **Enter**, выйти: **Ctrl+X**.

Закройте файл от чужих глаз:

```bash
chmod 600 .env
```

---

## Шаг 9. Запуск

1. Убедитесь, что локальная копия бота на компьютере остановлена.
2. На сервере:

```bash
cd ~/edaPlus
docker compose up -d --build
```

Первая сборка занимает 2–5 минут (на E2.1.Micro — до 15).

3. Посмотрите логи:

```bash
docker compose logs -f
```

Ждите строк `[api] http://localhost:3000` и `[bot] запущен как @имя_бота`, а от Caddy — `certificate obtained successfully`. Выход из логов: **Ctrl+C** (сервер продолжит работать).

4. Проверьте:
   - в браузере откройте `https://ВАШ_ДОМЕН/api/health` — должен быть ответ с `ok`;
   - в Telegram отправьте боту `/start` → кнопка **«Открыть eda+»** должна открыть приложение;
   - кнопка меню бота (слева от поля ввода) настроится автоматически при запуске.

Готово: бот работает круглосуточно и сам перезапускается после перезагрузки сервера.

> **База на сервере новая и пустая.** Кафе и админов кафе нужно добавить заново через «Главный админ» — тестовые заказы с компьютера туда не переносятся. Если очень нужно перенести локальную базу — напишите, подскажу отдельно.

---

## Шаг 10. Ежедневная резервная копия

Скрипт `scripts/backup.sh` делает копию базы (без остановки бота) и фото блюд в папку `~/eda-backups`, хранит последние 14 копий.

1. Проверьте вручную:

```bash
cd ~/edaPlus && ./scripts/backup.sh && ls -lh ~/eda-backups
```

2. Включите запуск каждую ночь в 4:00:

```bash
(crontab -l 2>/dev/null; echo '0 4 * * * /home/ubuntu/edaPlus/scripts/backup.sh >> /home/ubuntu/eda-backups/backup.log 2>&1') | crontab -
```

3. Копии на том же сервере не спасут, если пропадёт сам сервер. Раз в неделю скачивайте их **на компьютер**:

```powershell
scp -i "$env:USERPROFILE\.ssh\oracle.key" -r ubuntu@ВАШ_IP:~/eda-backups "$env:USERPROFILE\Documents\eda-backups"
```

**Восстановление из копии** (если что-то сломалось):

```bash
cd ~/edaPlus
docker compose stop eda
gunzip -k ~/eda-backups/eda-ДАТА.db.gz
docker compose cp ~/eda-backups/eda-ДАТА.db eda:/app/data/eda.db
docker compose run --rm --user root --entrypoint sh eda -c "rm -f /app/data/eda.db-wal /app/data/eda.db-shm; chown node:node /app/data/eda.db"
docker compose start eda
```

---

## Обновление после изменений в коде

1. На компьютере — тот же архив и загрузка, что в шаге 7.1.
2. На сервере:

```bash
tar -xzf eda.tar.gz && rm eda.tar.gz
cd ~/edaPlus && chmod +x scripts/backup.sh
./scripts/backup.sh
docker compose up -d --build
```

`.env` и база при этом не затрагиваются: их нет в архиве, а база лежит в томе Docker.

Изменили `ADMIN_TELEGRAM_IDS` или другие настройки в `.env` — примените так:

```bash
docker compose up -d
```

---

## Полезные команды

| Что | Команда |
|---|---|
| Статус контейнеров | `docker compose ps` |
| Логи приложения | `docker compose logs -f eda` |
| Логи HTTPS (Caddy) | `docker compose logs -f caddy` |
| Перезапустить | `docker compose restart` |
| Остановить всё | `docker compose down` (данные сохранятся) |
| Свободное место | `df -h /` |

⚠️ Никогда не выполняйте `docker compose down -v` и `docker volume rm` — это удалит базу.

---

## Если что-то не работает

| Симптом | Причина и решение |
|---|---|
| `ssh` пишет `UNPROTECTED PRIVATE KEY FILE` | Не выполнена команда `icacls` из шага 4.1 |
| `ssh` долго думает и пишет `timed out` | Неверный IP или сервер не в статусе Running |
| `permission denied ... docker.sock` | Не переподключились после `usermod` (шаг 5.3) |
| Сайт не открывается, в логах Caddy ошибки сертификата | Порты 80/443 не открыты (шаги 3.1 и 5.2) или DuckDNS указывает не на `ВАШ_IP`. После исправления: `docker compose restart caddy` |
| `DOMAIN ... Укажите DOMAIN в .env` при запуске | В `.env` нет строки `DOMAIN=` |
| В логах `409 Conflict: terminated by other getUpdates request` | Бот с этим токеном запущен где-то ещё (на компьютере) — остановите ту копию |
| Кнопка «Открыть eda+» открывает пустую страницу | `WEBAPP_URL` не совпадает с доменом или указан без `https://`. Исправьте `.env` → `docker compose up -d` |
| Сборка падает с `Killed` | Не хватает памяти — добавьте swap (шаг 5.4) |
| Через пару недель сервер остановлен | См. ниже про простой |

**Про простой.** Oracle может остановить бесплатный сервер, если он почти не используется (нагрузка на процессор долго ниже ~20%). Для небольшого бота это возможно. Надёжные варианты:
- перевести аккаунт в **Pay As You Go** (Billing → Upgrade). Бесплатные ресурсы остаются бесплатными, а правило про простой перестаёт действовать. Платить придётся только если вы сами создадите что-то сверх бесплатных лимитов, поэтому в Billing стоит настроить **Budget** с уведомлением, например на 1 $;
- если сервер всё же остановили — запустите его кнопкой **Start** на странице сервера, бот поднимется сам.

---

## Что помнить про безопасность

- Ключ `oracle.key` и файл `.env` — как пароли: не отправлять, не выкладывать.
- Если токен бота куда-то утёк — в @BotFather: `/revoke`, затем новый токен в `.env` на сервере и `docker compose up -d`.
- Главные админы задаются только в `.env` на сервере; админов кафе назначайте в разделе «Главный админ → Заведения».
