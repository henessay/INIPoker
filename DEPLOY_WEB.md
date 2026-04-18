# Развёртывание INIPoker в интернете

## Вариант 1: Vercel (рекомендуется — бесплатно, быстро)

### Шаги:

1. **Залить код на GitHub**
```bash
cd ~/minitia-poker-l2
git init
git add .
git commit -m "INIPoker v1.0 — Initia design"
git remote add origin https://github.com/YOUR_USER/inipoker.git
git push -u origin main
```

2. **Деплой на Vercel**
- Зайти на https://vercel.com и войти через GitHub
- "Add New" → "Project" → выбрать репозиторий `inipoker`
- Настройки:
  - **Root Directory:** `frontend`
  - **Framework Preset:** Vite
  - **Build Command:** `npm run build`
  - **Output Directory:** `dist`
- Environment Variables (добавить):
  - `VITE_POKER_GAME_ADDRESS` = `0xeCB7Ff40f3C6058785Ca97d95bb6AC4400cB842d`
- Нажать "Deploy"

3. **Готово!** Сайт будет доступен по адресу: `https://inipoker.vercel.app`

### Обновление:
```bash
git add .
git commit -m "update"
git push
```
Vercel автоматически пересоберёт.

---

## Вариант 2: Netlify (альтернатива Vercel)

1. Зарегистрироваться на https://netlify.com
2. "Sites" → "Add new site" → "Import from Git"
3. Выбрать репозиторий
4. Настройки:
   - **Base directory:** `frontend`
   - **Build command:** `npm run build`
   - **Publish directory:** `frontend/dist`
5. Environment Variables: `VITE_POKER_GAME_ADDRESS=0xeCB7Ff40f3C6058785Ca97d95bb6AC4400cB842d`

---

## Вариант 3: Ngrok для фронта (быстрый тест)

Если Vite уже запущен на `localhost:3000`:

```bash
# На основном компе (WSL):
ngrok http 3000

# Ngrok даст URL типа https://xxxx.ngrok-free.dev
# Открыть этот URL на втором компьютере
```

**Важно:** Для Ngrok нужно добавить в `vite.config.ts`:
```ts
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ['all'],
  },
  // ...
})
```

---

## Важные заметки

### RPC Endpoint
Сейчас RPC идёт через ngrok: `https://exothermally-multiplated-dannie.ngrok-free.dev`

Чтобы другие компьютеры могли подключиться:
- Ngrok для EVM RPC должен быть активен (уже настроен в `providers.tsx`)
- Если ngrok перезапустится, URL изменится → обновить в `providers.tsx`

### Для стабильного доступа (без ngrok):
Лучше развернуть Initia ноду на VPS (например DigitalOcean/Hetzner за $5/мес) и использовать постоянный IP.

### Keplr / InterwovenKit
Пользователям нужно:
1. Установить Keplr расширение
2. Подключиться к Initia Testnet
3. Получить тестовые INIT через фаucet
