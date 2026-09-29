# PeriPage.js

SvelteKit 2 / Svelte 5 / TypeScript, Bun, Paraglide (`en`, `ru`), ESLint, Prettier и Vitest.
Настройки SvelteKit находятся в `vite.config.ts`.

## Разработка

```sh
nix develop
bun install --frozen-lockfile
bun run dev
```

## Статическая сборка

```sh
bun run build
bun run preview
```

Готовый сайт находится в `build/`: HTML, JavaScript, CSS и статические файлы.
На хостинге не нужны Bun, Node.js или сервер SvelteKit.

`@sveltejs/adapter-static` и `src/routes/+layout.ts` включают пререндеринг всех
страниц. Сборка завершается ошибкой, если остаются динамические маршруты.
`trailingSlash = 'always'` создаёт страницы вида `route/index.html`, чтобы прямые
переходы и обновления страницы работали на статическом хостинге.

Язык определяется URL: английская версия находится в `/`, русская — в `/ru/`.
Скрытые ссылки в корневом layout позволяют пререндереру найти все языковые версии
каждой страницы. `src/hooks.server.ts` обрабатывает локализацию при пререндеринге;
после публикации серверный hook не нужен.

## GitHub Pages

Для сайта репозитория `peripagejs` по адресу `https://<owner>.github.io/peripagejs/`:

```sh
BASE_PATH=/peripagejs bun run build
BASE_PATH=/peripagejs bun run preview
```

При просмотре локально открывай `/peripagejs/`. Если репозиторий называется иначе,
замени `/peripagejs` на его имя с начальным `/` и без завершающего `/`.
Для `https://<owner>.github.io/` или собственного домена собирай без `BASE_PATH`.

Публиковать нужно содержимое `build/`, включая `_app/` и `.nojekyll`.
В будущем GitHub Actions должен установить зависимости командой
`bun install --frozen-lockfile`, выполнить сборку с нужным `BASE_PATH` и загрузить
`build/` как Pages artifact. Сам деплой пока не настроен.

Внутренние ссылки создавай через `resolve` из `$app/paths`, а ссылки на файлы из
`static/` — через `asset`. Для языковых ссылок используй `localizeHref` из
Paraglide: его шаблоны уже учитывают `BASE_PATH`, повторно добавлять префикс не нужно.
Динамическим маршрутам (`[slug]`) нужны `entries` или ссылки с конкретными значениями,
по которым пререндерер сможет их обнаружить.

Справка: [статическая сборка SvelteKit](https://svelte.dev/docs/kit/adapter-static),
[Paraglide и SvelteKit](https://paraglidejs.com/sveltekit).

## Проверки

```sh
bun run check
bun run lint
bun run test
```

Для компонентных тестов Vitest нужен Chromium: `bun x playwright install chromium`.
