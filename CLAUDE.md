# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Traktr — an Obsidian plugin that syncs Trakt.tv data (watchlist, watch history, favorites, ratings) into vault notes with YAML frontmatter and customizable templates.

## Build Commands

- `npm run dev` — esbuild watch mode (no type checking)
- `npm run build` — `tsc -noEmit -skipLibCheck` then esbuild production bundle → `main.js`

`main.js` is checked in because Obsidian loads it directly from the plugin folder.

## Documentation

- [doc/DEVELOPER.md](doc/DEVELOPER.md) — architecture, data flow diagrams, how to extend
- [doc/MANUAL.md](doc/MANUAL.md) — settings reference, frontmatter fields, template variables

## Key Conventions

- All HTTP uses `requestUrl` from the `obsidian` module (not `fetch`)
- Frontmatter keys are prefixed with `settings.propertyPrefix` (default `trakt_`)
- Template `{{variables}}` are unprefixed for readability
- Items are keyed by `"type:traktId"` (e.g. `"movie:123"`) to avoid cross-type ID collisions
- `this.settings` is shared by reference across `SyncEngine` and `AuthModal`
- `strictNullChecks` is enabled in tsconfig
