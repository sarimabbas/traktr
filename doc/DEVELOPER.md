# Traksidian — Developer Guide

A reference for understanding, debugging, and extending the plugin.

---

## Table of Contents

1. [Repository structure](#1-repository-structure)
2. [Build system](#2-build-system)
3. [Architecture overview](#3-architecture-overview)
4. [Plugin lifecycle](#4-plugin-lifecycle)
5. [Settings](#5-settings)
6. [Authentication](#6-authentication)
7. [Sync engine](#7-sync-engine)
8. [Note rendering](#8-note-rendering)
9. [Key data types](#9-key-data-types)
10. [Common tasks](#10-common-tasks)

---

## 1. Repository structure

```
obsidian-trakt-watchlist/
├── src/
│   ├── main.ts          # Plugin entry point and lifecycle
│   ├── settings.ts      # Settings interface, defaults, settings UI tab
│   ├── sync-engine.ts   # Core sync logic: fetch → merge → reconcile
│   ├── note-renderer.ts # Turns NormalizedItem into Markdown note content
│   ├── trakt-api.ts     # Trakt REST API calls
│   ├── trakt-auth.ts    # OAuth device-code flow + token refresh
│   ├── tmdb-api.ts      # TMDB poster image fetches
│   ├── types.ts         # All TypeScript interfaces
│   └── utils.ts         # sanitizeFilename, renderTemplate, toFrontmatter, parseFrontmatter
├── doc/
│   ├── MANUAL.md        # End-user manual
│   └── DEVELOPER.md     # This file
├── main.js              # Compiled output (checked in for Obsidian to load)
├── manifest.json        # Plugin metadata (id, name, version, minAppVersion)
├── styles.css           # Optional CSS loaded by Obsidian
├── esbuild.config.mjs   # Bundler config
├── tsconfig.json        # TypeScript config
└── package.json
```

### Why `main.js` is checked in

Obsidian loads `main.js` directly from the plugin folder. It is not fetched from npm. The compiled file must be committed so the plugin works when installed from GitHub releases.

---

## 2. Build system

```mermaid
flowchart LR
    A["src/*.ts"] -->|"tsc -noEmit\n(type-check only)"| B{Type errors?}
    B -->|yes| C[Build fails]
    B -->|no| D["esbuild.config.mjs"]
    D -->|bundle + minify| E["main.js"]
```

- **`npm run dev`** — runs esbuild in watch mode, no type checking, fast iteration
- **`npm run build`** — runs `tsc -noEmit` first (full type check), then esbuild in production mode

esbuild bundles everything into a single `main.js` with all `node_modules` inlined, except modules listed as `external` (the Obsidian API, Node built-ins, Electron). Those are provided at runtime by Obsidian itself.

---

## 3. Architecture overview

```mermaid
flowchart TD
    OBS[Obsidian runtime]
    MAIN[TraksidianPlugin\nmain.ts]
    SE[SyncEngine\nsync-engine.ts]
    NR[note-renderer.ts]
    TA[trakt-api.ts]
    TB[trakt-auth.ts]
    TM[tmdb-api.ts]
    UT[utils.ts]
    VAULT[(Obsidian Vault)]
    TRAKT[(Trakt API)]
    TMDBA[(TMDB API)]

    OBS -->|loads & calls onload| MAIN
    MAIN -->|creates| SE
    MAIN -->|reads/writes settings| VAULT
    SE -->|token refresh| TB
    SE -->|fetch data| TA
    SE -->|fetch posters| TM
    SE -->|render notes| NR
    NR -->|renderTemplate\ntoFrontmatter| UT
    SE -->|parseFrontmatter\nsanitizeFilename| UT
    SE -->|create/modify/trash files| VAULT
    TA -->|HTTP| TRAKT
    TB -->|HTTP| TRAKT
    TM -->|HTTP| TMDBA
```

The plugin has no background server. Everything happens inside the Obsidian process when a sync is triggered.

---

## 4. Plugin lifecycle

### Startup sequence

```mermaid
sequenceDiagram
    participant OBS as Obsidian
    participant MAIN as TraksidianPlugin
    participant SE as SyncEngine
    participant VAULT as Vault

    OBS->>MAIN: onload()
    MAIN->>VAULT: loadData() → settings
    MAIN->>SE: new SyncEngine(app, settings, saveSettings)
    MAIN->>MAIN: addSettingTab()
    MAIN->>MAIN: addCommand() ×3
    MAIN->>MAIN: addRibbonIcon()
    MAIN->>MAIN: addStatusBarItem()
    MAIN->>MAIN: configureAutoSync()
    alt syncOnStartup && accessToken
        MAIN->>MAIN: setTimeout(5s) → sync()
    end
```

### Auto-sync reconfiguration

`configureAutoSync()` is called during `onload()` and again whenever the user changes auto-sync settings in the UI.

```mermaid
flowchart TD
    A[configureAutoSync called] --> B{autoSyncIntervalId set?}
    B -->|yes| C[clearInterval old ID]
    C --> D{autoSyncEnabled\n&& accessToken?}
    B -->|no| D
    D -->|no| E[done — no interval running]
    D -->|yes| F[setInterval every N minutes]
    F --> G[registerInterval — Obsidian\nclears on plugin unload]
```

> **Note:** `autoSyncIntervalId` is kept as a field so `configureAutoSync` can clear the previous interval before creating a new one. `registerInterval` handles final cleanup on unload; there is no `onunload` override needed.

---

## 5. Settings

### Data flow

```mermaid
flowchart LR
    DF[DEFAULT_SETTINGS] -->|merged with| LD[loadData from vault]
    LD --> S[this.settings object]
    S -->|passed by reference| SE[SyncEngine]
    S -->|passed by reference| AUTH[AuthModal]
    UI[TraksidianSettingTab] -->|mutates| S
    UI -->|calls| SAVE[saveSettings → saveData]
```

`this.settings` is passed by reference to `SyncEngine` and `AuthModal`. Both mutate it directly (e.g. writing new tokens after auth). This means `SyncEngine` always sees the latest settings without needing to be recreated.

### Interface at a glance (`src/settings.ts`)

| Group | Key fields |
|---|---|
| Auth | `clientId`, `clientSecret`, `accessToken`, `refreshToken`, `tokenExpiresAt` |
| TMDB | `tmdbApiKey`, `posterSize` |
| Vault | `propertyPrefix`, `folder`, `filenameTemplate` |
| Templates | `movieNoteTemplate`, `showNoteTemplate`, `tagPrefix` |
| Sources | `syncWatchlist`, `syncFavorites`, `syncWatched`, `syncRatings` |
| Behavior | `syncMovies`, `syncShows`, `autoSyncEnabled`, `autoSyncIntervalMinutes`, `syncOnStartup`, `overwriteExisting`, `deleteRemovedItems` |

`DEFAULT_SETTINGS` provides every field so `Object.assign({}, DEFAULT_SETTINGS, savedData)` always produces a complete object, even after adding new fields to the interface.

---

## 6. Authentication

Trakt uses the **OAuth 2.0 device code flow** — no redirect URI or browser callback needed. The user visits a URL and enters a short code; the plugin polls until authorized.

### Full auth flow

```mermaid
sequenceDiagram
    participant USER as User
    participant AUTH as AuthModal
    participant API as Trakt API
    participant SETTINGS as settings object

    USER->>AUTH: clicks "Connect to Trakt"
    AUTH->>API: POST /oauth/device/code {client_id}
    API-->>AUTH: {device_code, user_code, verification_url, expires_in, interval}
    AUTH->>USER: display verification_url + user_code
    loop every interval seconds
        AUTH->>API: POST /oauth/device/token {device_code, client_id, client_secret}
        alt 400 - not yet authorized
            API-->>AUTH: keep polling
        else 200 - authorized
            API-->>AUTH: {access_token, refresh_token, expires_in, created_at}
            AUTH->>SETTINGS: write tokens + tokenExpiresAt
            AUTH->>AUTH: call onSuccess() → saveSettings()
            AUTH->>AUTH: close modal
        else 409/418 - user denied
            AUTH->>USER: show error, stop polling
        else 410 - code expired
            AUTH->>USER: show error, stop polling
        else 429 - too fast
            API-->>AUTH: skip this cycle, continue
        end
    end
```

### Token refresh

`ensureValidToken()` in `trakt-auth.ts` is called at the start of every sync. It checks whether the access token expires within the next hour and refreshes it proactively.

```mermaid
flowchart TD
    A[ensureValidToken called] --> B{accessToken\n&& refreshToken?}
    B -->|no| ERR1[throw: not connected]
    B -->|yes| C{expires within\n1 hour?}
    C -->|no| OK[token still valid — return]
    C -->|yes| D[POST /oauth/token with refreshToken]
    D --> E{success?}
    E -->|yes| F[write new tokens to settings\ncall saveSettings]
    E -->|no| G[clear all tokens\ncall saveSettings\nthrow: session expired]
```

---

## 7. Sync engine

`SyncEngine.sync()` in `src/sync-engine.ts` is the core of the plugin. It runs in three phases: **fetch**, **merge**, **reconcile**.

### High-level flow

```mermaid
flowchart TD
    START([sync called]) --> GUARD{already syncing?}
    GUARD -->|yes| NOTICE[Notice: already in progress]
    GUARD -->|no| TOKEN[ensureValidToken]
    TOKEN --> FETCH

    subgraph FETCH ["Phase 1 — Fetch & Merge (parallel)"]
        direction LR
        FM[fetchAndMergeMovies]
        FS[fetchAndMergeShows]
        FM ~~~ FS
    end

    FETCH --> RECONCILE

    subgraph RECONCILE ["Phase 2 — Reconcile"]
        direction TB
        POSTERS[Batch fetch all poster URLs\nPromise.all]
        POSTERS --> LOOP[For each merged item:\ncreate or update note]
        LOOP --> DELETE[If deleteRemovedItems:\ntrash orphaned notes]
    end

    RECONCILE --> DONE([Notice: result summary])
```

### fetchAndMergeMovies / fetchAndMergeShows

Both methods follow the same pattern. All four source API calls fire concurrently:

```mermaid
flowchart TD
    START([fetchAndMergeMovies]) --> PARALLEL

    subgraph PARALLEL ["Promise.all — all fire at once"]
        W[fetchWatchlist movies]
        WA[fetchWatchedMovies]
        F[fetchFavorites movies]
        R[fetchRatings movies]
    end

    PARALLEL --> MERGE

    subgraph MERGE ["Merge results into Map&lt;string, NormalizedItem&gt;"]
        direction TB
        M1[for watchlistItems:\nitem.watchlist = true]
        M2[for watchedItems:\nitem.watched = true\nitem.plays = N]
        M3[for favoriteItems:\nitem.favorite = true]
        M4[for ratingItems:\nitem.my_rating = N]
    end
```

**`getOrCreateItem`** is the key deduplication function. If an item appears in multiple sources (e.g. both watchlist and watched), it gets a single `NormalizedItem` and the flags from each source are merged onto it:

```mermaid
flowchart LR
    A["getOrCreateItem(map, ids, type, ...)"] --> B{map.has\nitemKey?}
    B -->|yes| C[return existing item]
    B -->|no| D{type?}
    D -->|movie| E[baseFromMovie → new item]
    D -->|show| F[baseFromShow → new item]
    E --> G[map.set itemKey, item]
    F --> G
    G --> H[return new item]
```

**Item key format:** `"movie:123"` or `"show:456"` — a composite of type + Trakt ID. This prevents collisions since Trakt assigns IDs independently per type (a movie and a show can share the same number).

### reconcileType — create/update/delete

```mermaid
flowchart TD
    A[reconcileType] --> B[ensureFolder]
    B --> C[scanExistingNotes → localNotes map]
    C --> POSTERS[Batch poster fetches\nPromise.all over all items]
    POSTERS --> LOOP

    subgraph LOOP ["For each item in mergedItems"]
        direction TB
        L1{localNotes\nhas this key?}
        L1 -->|no| CREATE[vault.create new note]
        L1 -->|yes| L2{overwriteExisting?}
        L2 -->|yes| OVERWRITE[vault.modify — full re-render]
        L2 -->|no| FMONLY[vault.read → parseFrontmatter\nreplace frontmatter, keep body\nvault.modify]
    end

    LOOP --> ORPHAN

    subgraph ORPHAN ["If deleteRemovedItems"]
        direction TB
        O1[For each file in localNotes]
        O1 --> O2{still in mergedItems?}
        O2 -->|no| O3[vault.trash file]
        O2 -->|yes| O4[skip]
    end
```

### scanExistingNotes

Reads the notes folder and builds a `Map<string, TFile>` keyed by the same `"type:id"` composite. This is how the engine knows which vault files correspond to which Trakt items.

```mermaid
flowchart TD
    A[scanExistingNotes] --> B{folder exists?}
    B -->|no| EMPTY[return empty map]
    B -->|yes| C[for each .md file in folder]
    C --> D[cachedRead → parseFrontmatter]
    D --> E{t_id and t_type\nboth present?}
    E -->|yes| F["map.set('type:id', TFile)"]
    E -->|no| G[skip file]
```

> **Why read `t_type` as well as `t_id`?** Trakt IDs are not globally unique across types. Movie #1 and Show #1 are different entities. The composite key ensures they never collide.

### Trakt API pagination

`fetchPaginated` in `trakt-api.ts` handles all paginated endpoints:

```mermaid
flowchart TD
    A["fetchPaginated(path, ...)"] --> B["GET path?page=1&limit=100"]
    B --> C{status?}
    C -->|429| ERR1[throw rate limit]
    C -->|401| ERR2[throw expired session]
    C -->|5xx| ERR3[throw server error]
    C -->|200| D[append items to array]
    D --> E{page >= X-Pagination-Page-Count?}
    E -->|yes| DONE[return all items]
    E -->|no| F[page++]
    F --> B
```

---

## 8. Note rendering

`src/note-renderer.ts` turns a `NormalizedItem` into Markdown.

### Full note render path

```mermaid
flowchart TD
    ITEM[NormalizedItem] --> FM[buildFrontmatterData]
    ITEM --> CTX[buildTemplateContext]

    FM --> |"Record&lt;string, unknown&gt;"| YML[toFrontmatter\nutils.ts]
    YML --> FMSTR["---\nt_title: ...\ntags:\n  - trakt/movie\n---"]

    CTX --> |"Record&lt;string, unknown&gt;"| TPL[renderTemplate\nutils.ts]
    TPL --> BODY["# Title (year)\n![poster](...)\n..."]

    FMSTR --> CONCAT["renderNote output:\nfrontmatter + body"]
    BODY --> CONCAT
```

### Frontmatter-only update (overwriteExisting = false)

```mermaid
flowchart LR
    FILE[existing note] --> READ[vault.read]
    READ --> PARSE[parseFrontmatter]
    PARSE --> BODY[body string preserved]
    ITEM[NormalizedItem] --> FMONLY[renderFrontmatterOnly\n→ toFrontmatter]
    FMONLY --> NEWFM[new frontmatter string]
    NEWFM --> JOIN["--- + frontmatter + ---\n+ body"]
    BODY --> JOIN
    JOIN --> WRITE[vault.modify]
```

### Template variable resolution

`renderTemplate` in `utils.ts` does a simple regex replace of `{{varName}}` → value. Variables that are `null`/`undefined` become empty string. Arrays join with `", "`.

The same `{{variable}}` names are available whether you're using the movie template or the show template. Movie-specific variables (like `{{tagline}}`) are just empty in show notes, and vice versa.

---

## 9. Key data types

```mermaid
classDiagram
    class NormalizedItem {
        +ItemType type
        +string title
        +number year
        +TraktIds ids
        +string overview
        +string[] genres
        +number runtime
        +number rating
        +number votes
        +string certification
        +string country
        +string language
        +string status
        +string? tagline
        +string? released
        +string? network
        +number? aired_episodes
        +string? first_aired
        +string? poster_url
        +boolean? watchlist
        +boolean? watched
        +number? plays
        +boolean? favorite
        +number? my_rating
    }

    class TraktIds {
        +number trakt
        +string slug
        +string? imdb
        +number? tmdb
        +number? tvdb
    }

    class SyncResult {
        +number added
        +number updated
        +number removed
        +number failed
        +string[] errors
    }

    class TraksidianSettings {
        +string clientId
        +string clientSecret
        +string accessToken
        +string refreshToken
        +number tokenExpiresAt
        +string tmdbApiKey
        +PosterSize posterSize
        +string propertyPrefix
        +string folder
        +string filenameTemplate
        +string movieNoteTemplate
        +string showNoteTemplate
        +string tagPrefix
        +boolean syncWatchlist
        +boolean syncFavorites
        +boolean syncWatched
        +boolean syncRatings
        +boolean syncMovies
        +boolean syncShows
        +boolean autoSyncEnabled
        +number autoSyncIntervalMinutes
        +boolean syncOnStartup
        +boolean overwriteExisting
        +boolean deleteRemovedItems
    }

    NormalizedItem --> TraktIds : ids
```

### Why `NormalizedItem` has optional source flags

`NormalizedItem` is built by `baseFromMovie` / `baseFromShow` with core metadata only. Source flags (`watchlist`, `watched`, `favorite`, `my_rating`) are then set conditionally during the merge phase. A movie that appears only in ratings will have `my_rating` set but `watchlist` undefined (not false — the distinction matters for `toFrontmatter`, which skips undefined/null fields).

---

## 10. Common tasks

### Add a new sync source

1. Add a `syncXxx: boolean` field to `TraksidianSettings` in `settings.ts` and to `DEFAULT_SETTINGS`
2. Add a toggle setting in `TraksidianSettingTab.display()`
3. Add a `fetchXxx(type, clientId, accessToken)` function in `trakt-api.ts` (reuse `fetchPaginated`)
4. Inside `fetchAndMergeMovies` / `fetchAndMergeShows` in `sync-engine.ts`, add the new fetch to the `Promise.all` array and a loop to merge the results into the map

### Add a new frontmatter field

1. Add the field to `NormalizedItem` in `types.ts` (optional `?:` if not always present)
2. Populate it in `baseFromMovie` or `baseFromShow`, or in the relevant merge loop
3. Add `data[${p}fieldname] = ...` in `buildFrontmatterData` in `note-renderer.ts`
4. Optionally add it to `buildTemplateContext` if you want a `{{variable}}` for templates

### Add a new template variable

1. Add an entry to the object returned by `buildTemplateContext` in `note-renderer.ts`
2. Document it in the user manual (`doc/MANUAL.md`)
3. That's it — `renderTemplate` picks it up automatically

### Change the note file-naming scheme

Edit `buildFilename` in `sync-engine.ts`. The function calls `renderTemplate` with a context of `{title, year, imdb_id, trakt_id}` and then `sanitizeFilename`. To add more variables, expand that context object.

### Debugging a sync

The sync result object (`SyncResult`) accumulates errors in `result.errors`. Individual item failures are caught and counted in `result.failed` rather than aborting the whole sync. To see all errors, open the developer console (`Cmd+Opt+I` on Mac) — errors are also printed there via the failure path in `reconcileType`.

The Trakt API returns paginated results with `X-Pagination-Page-Count` in the response header. If a user has a very large library, `fetchPaginated` will loop through all pages before returning.

### Token expiry edge case

If `ensureValidToken` throws (e.g. refresh token is also expired), the sync catches it at the top level and shows a Notice. The user will need to disconnect and reconnect via the settings tab. The tokens are cleared from settings automatically by `ensureValidToken` on refresh failure.
