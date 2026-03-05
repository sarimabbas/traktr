import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { TraktrSettings } from "./settings";
import type {
  TraktWatchlistItem,
  TraktWatchedMovieItem,
  TraktWatchedShowItem,
  TraktFavoriteItem,
  TraktRatingItem,
  NormalizedItem,
  SyncResult,
  TraktMovie,
  TraktShow,
  TraktIds,
  ItemType,
} from "./types";
import {
  fetchWatchlist,
  fetchWatchedMovies,
  fetchWatchedShows,
  fetchFavorites,
  fetchRatings,
} from "./trakt-api";
import { fetchMoviePosterUrl, fetchTvPosterUrl } from "./tmdb-api";
import { ensureValidToken } from "./trakt-auth";
import { renderNote, buildFrontmatterData } from "./note-renderer";
import { sanitizeFilename, renderTemplate, parseFrontmatter } from "./utils";

// ── Normalization helpers ──

function baseFromMovie(m: TraktMovie): NormalizedItem {
  return {
    type: "movie",
    title: m.title,
    year: m.year,
    ids: m.ids,
    overview: m.overview || "",
    genres: m.genres || [],
    runtime: m.runtime || 0,
    rating: m.rating || 0,
    votes: m.votes || 0,
    certification: m.certification || "",
    country: m.country || "",
    language: m.language || "",
    status: m.status || "",
    tagline: m.tagline,
    released: m.released,
  };
}

function baseFromShow(s: TraktShow): NormalizedItem {
  return {
    type: "show",
    title: s.title,
    year: s.year,
    ids: s.ids,
    overview: s.overview || "",
    genres: s.genres || [],
    runtime: s.runtime || 0,
    rating: s.rating || 0,
    votes: s.votes || 0,
    certification: s.certification || "",
    country: s.country || "",
    language: s.language || "",
    status: s.status || "",
    network: s.network,
    aired_episodes: s.aired_episodes,
    first_aired: s.first_aired,
  };
}

function itemKey(type: ItemType, traktId: number): string {
  return `${type}:${traktId}`;
}

function getOrCreateItem(
  map: Map<string, NormalizedItem>,
  ids: TraktIds,
  type: ItemType,
  movie?: TraktMovie,
  show?: TraktShow
): NormalizedItem {
  const key = itemKey(type, ids.trakt);
  const existing = map.get(key);
  if (existing) return existing;

  let item: NormalizedItem;
  if (type === "movie" && movie) {
    item = baseFromMovie(movie);
  } else if (type === "show" && show) {
    item = baseFromShow(show);
  } else {
    throw new Error(`Cannot create item: missing ${type} data`);
  }

  map.set(key, item);
  return item;
}

// ── Folder & file helpers ──

async function ensureFolder(app: App, path: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  if (!existing) {
    await app.vault.createFolder(path);
  }
}

function buildFilename(item: NormalizedItem, template: string): string {
  const context: Record<string, unknown> = {
    title: item.title,
    year: item.year,
    imdb_id: item.ids.imdb || "",
    trakt_id: item.ids.trakt,
  };
  return sanitizeFilename(renderTemplate(template, context));
}

/**
 * Scan a folder for notes and build a composite "type:trakt_id" → TFile map
 * from frontmatter. Reading both t_id and t_type avoids collisions between
 * movies and shows that share the same numeric Trakt ID.
 */
async function scanExistingNotes(
  app: App,
  folderPath: string,
  propertyPrefix: string
): Promise<Map<string, TFile>> {
  const map = new Map<string, TFile>();
  const folder = app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return map;

  const idKey = `${propertyPrefix}id`;
  const typeKey = `${propertyPrefix}type`;

  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const content = await app.vault.cachedRead(child);
    const { frontmatter } = parseFrontmatter(content);
    const traktId = parseInt(frontmatter[idKey], 10);
    const type = frontmatter[typeKey];
    if (!isNaN(traktId) && (type === "movie" || type === "show")) {
      map.set(itemKey(type, traktId), child);
    }
  }

  return map;
}

// ── Sync Engine ──

export class SyncEngine {
  private app: App;
  private settings: TraktrSettings;
  private saveSettings: () => Promise<void>;
  private syncing = false;

  constructor(
    app: App,
    settings: TraktrSettings,
    saveSettings: () => Promise<void>
  ) {
    this.app = app;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  async sync(): Promise<SyncResult> {
    if (this.syncing) {
      new Notice("Sync already in progress.");
      return { added: 0, updated: 0, removed: 0, failed: 0, errors: [] };
    }

    this.syncing = true;
    const result: SyncResult = {
      added: 0,
      updated: 0,
      removed: 0,
      failed: 0,
      errors: [],
    };

    console.debug("[Traktr] Sync started");
    try {
      // 1. Ensure valid token
      await ensureValidToken(this.settings, this.saveSettings);

      // 2. Fetch from all enabled sources in parallel, merging into a single
      //    map keyed by "type:trakt_id" to avoid cross-type ID collisions.
      const merged = new Map<string, NormalizedItem>();

      await Promise.all([
        this.settings.syncMovies ? this.fetchAndMergeMovies(merged) : Promise.resolve(),
        this.settings.syncShows ? this.fetchAndMergeShows(merged) : Promise.resolve(),
      ]);

      // 3. Ensure tag note files exist
      await this.ensureTagNotes(merged);

      // 4. Reconcile all items into the single notes folder
      await this.reconcileType(merged, result);

      // 5. Show result
      console.debug(`[Traktr] Sync complete — added: ${result.added}, updated: ${result.updated}, removed: ${result.removed}, failed: ${result.failed}`);
      let msg = `Sync complete: ${result.added} added, ${result.updated} updated, ${result.removed} removed`;
      if (result.failed > 0) {
        msg += `, ${result.failed} failed`;
        console.error(`[Traktr] Sync completed with ${result.failed} failure(s):`);
        for (const err of result.errors) {
          console.error(err);
        }
      }
      new Notice(msg, result.failed > 0 ? 10000 : 5000);
      if (result.failed > 0) {
        new Notice(`Traktr: ${result.errors[0]}${result.errors.length > 1 ? ` (+${result.errors.length - 1} more — see console)` : ""}`, 10000);
      }
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Unknown error during sync.";
      console.error("[Traktr] Sync failed:", e);
      new Notice(`Traktr sync failed: ${msg}`, 10000);
      result.errors.push(msg);
    } finally {
      this.syncing = false;
    }

    return result;
  }

  /**
   * Create tag note files for all tag notes referenced by the merged items.
   * Only creates files that don't already exist — never overwrites.
   */
  private async ensureTagNotes(
    mergedItems: Map<string, NormalizedItem>
  ): Promise<void> {
    if (!this.settings.createTagNotes) return;

    const folder = this.settings.tagNotesFolder;
    const pfx = folder ? `${folder}/` : "";

    // Collect all unique note paths (without .md extension)
    const paths = new Set<string>();
    for (const item of mergedItems.values()) {
      paths.add(`${pfx}${item.type}`);
      for (const genre of item.genres) {
        paths.add(`${pfx}genre/${genre}`);
      }
      if (item.watchlist) paths.add(`${pfx}watchlist`);
      if (item.watched) paths.add(`${pfx}watched`);
      if (item.favorite) paths.add(`${pfx}favorite`);
      if (item.my_rating) paths.add(`${pfx}rated`);
    }

    for (const notePath of paths) {
      const filePath = normalizePath(`${notePath}.md`);
      // Ensure parent folder(s) exist
      const lastSlash = filePath.lastIndexOf("/");
      if (lastSlash > 0) {
        await ensureFolder(this.app, filePath.slice(0, lastSlash));
      }
      // Create file only if it doesn't already exist
      if (!this.app.vault.getAbstractFileByPath(filePath)) {
        await this.app.vault.create(filePath, "");
      }
    }
  }

  /**
   * Fetch from all enabled sources for movies in parallel and merge into map.
   */
  private async fetchAndMergeMovies(
    map: Map<string, NormalizedItem>
  ): Promise<void> {
    const { clientId, accessToken } = this.settings;

    const [watchlistItems, watchedItems, favoriteItems, ratingItems] = await Promise.all([
      this.settings.syncWatchlist ? fetchWatchlist("movies", clientId, accessToken) : Promise.resolve([] as TraktWatchlistItem[]),
      this.settings.syncWatched ? fetchWatchedMovies(clientId, accessToken) : Promise.resolve([] as TraktWatchedMovieItem[]),
      this.settings.syncFavorites ? fetchFavorites("movies", clientId, accessToken) : Promise.resolve([] as TraktFavoriteItem[]),
      this.settings.syncRatings ? fetchRatings("movies", clientId, accessToken) : Promise.resolve([] as TraktRatingItem[]),
    ]);

    for (const raw of watchlistItems) {
      if (!raw.movie) continue;
      const item = getOrCreateItem(map, raw.movie.ids, "movie", raw.movie);
      item.watchlist = true;
      item.watchlist_added_at = raw.listed_at;
    }

    for (const raw of watchedItems) {
      const item = getOrCreateItem(map, raw.movie.ids, "movie", raw.movie);
      item.watched = true;
      item.plays = raw.plays;
      item.last_watched_at = raw.last_watched_at;
    }

    for (const raw of favoriteItems) {
      if (!raw.movie) continue;
      const item = getOrCreateItem(map, raw.movie.ids, "movie", raw.movie);
      item.favorite = true;
      item.favorited_at = raw.listed_at;
    }

    for (const raw of ratingItems) {
      if (!raw.movie) continue;
      const item = getOrCreateItem(map, raw.movie.ids, "movie", raw.movie);
      item.my_rating = raw.rating;
      item.rated_at = raw.rated_at;
    }
  }

  /**
   * Fetch from all enabled sources for shows in parallel and merge into map.
   */
  private async fetchAndMergeShows(
    map: Map<string, NormalizedItem>
  ): Promise<void> {
    const { clientId, accessToken } = this.settings;

    const [watchlistItems, watchedItems, favoriteItems, ratingItems] = await Promise.all([
      this.settings.syncWatchlist ? fetchWatchlist("shows", clientId, accessToken) : Promise.resolve([] as TraktWatchlistItem[]),
      this.settings.syncWatched ? fetchWatchedShows(clientId, accessToken) : Promise.resolve([] as TraktWatchedShowItem[]),
      this.settings.syncFavorites ? fetchFavorites("shows", clientId, accessToken) : Promise.resolve([] as TraktFavoriteItem[]),
      this.settings.syncRatings ? fetchRatings("shows", clientId, accessToken) : Promise.resolve([] as TraktRatingItem[]),
    ]);

    for (const raw of watchlistItems) {
      if (!raw.show) continue;
      const item = getOrCreateItem(map, raw.show.ids, "show", undefined, raw.show);
      item.watchlist = true;
      item.watchlist_added_at = raw.listed_at;
    }

    for (const raw of watchedItems) {
      const item = getOrCreateItem(map, raw.show.ids, "show", undefined, raw.show);
      item.watched = true;
      item.plays = raw.plays;
      item.last_watched_at = raw.last_watched_at;
      if (raw.seasons) {
        item.episodes_watched = raw.seasons.reduce(
          (sum, s) => sum + s.episodes.length,
          0
        );
      }
    }

    for (const raw of favoriteItems) {
      if (!raw.show) continue;
      const item = getOrCreateItem(map, raw.show.ids, "show", undefined, raw.show);
      item.favorite = true;
      item.favorited_at = raw.listed_at;
    }

    for (const raw of ratingItems) {
      if (!raw.show) continue;
      const item = getOrCreateItem(map, raw.show.ids, "show", undefined, raw.show);
      item.my_rating = raw.rating;
      item.rated_at = raw.rated_at;
    }
  }

  /**
   * Reconcile merged items against the vault.
   */
  private async reconcileType(
    mergedItems: Map<string, NormalizedItem>,
    result: SyncResult
  ): Promise<void> {
    const folderPath = normalizePath(this.settings.folder);
    await ensureFolder(this.app, folderPath);

    const localNotes = await scanExistingNotes(
      this.app,
      folderPath,
      this.settings.propertyPrefix
    );

    // Fetch all poster URLs in parallel before processing notes
    if (this.settings.tmdbApiKey) {
      await Promise.all(
        [...mergedItems.values()].map(async (item) => {
          if (!item.ids.tmdb) return;
          const posterFn =
            item.type === "movie" ? fetchMoviePosterUrl : fetchTvPosterUrl;
          item.poster_url = await posterFn(
            item.ids.tmdb,
            this.settings.tmdbApiKey,
            this.settings.posterSize
          );
        })
      );
    }

    // Create or update notes
    for (const [key, item] of mergedItems) {
      try {
        const existingFile = localNotes.get(key);

        if (!existingFile) {
          // CREATE
          const filename = buildFilename(item, this.settings.filenameTemplate);
          const filePath = normalizePath(`${folderPath}/${filename}.md`);
          await this.app.vault.create(filePath, renderNote(item, this.settings));
          result.added++;
        } else {
          // UPDATE
          if (this.settings.overwriteExisting) {
            // Replace full note content atomically
            await this.app.vault.process(existingFile, () =>
              renderNote(item, this.settings)
            );
          } else {
            // Frontmatter-only update via Obsidian's API — preserves the note body
            await this.app.fileManager.processFrontMatter(
              existingFile,
              (fm) => {
                const newData = buildFrontmatterData(item, this.settings);
                for (const [key, value] of Object.entries(newData)) {
                  if (value === null || value === undefined) {
                    delete fm[key];
                  } else {
                    fm[key] = value;
                  }
                }
              }
            );
          }
          result.updated++;
        }
      } catch (e) {
        result.failed++;
        const msg = `Failed to sync "${item.title}" (${item.type} ${item.ids.trakt}): ${e instanceof Error ? e.message : String(e)}`;
        result.errors.push(msg);
        console.error("[Traktr]", msg, e);
      }
    }

    // Remove notes that are no longer in any synced source
    if (this.settings.deleteRemovedItems) {
      for (const [key, file] of localNotes) {
        if (!mergedItems.has(key)) {
          try {
            await this.app.vault.trash(file, true);
            result.removed++;
          } catch (e) {
            result.failed++;
            const msg = `Failed to remove "${file.name}": ${e instanceof Error ? e.message : String(e)}`;
            result.errors.push(msg);
            console.error("[Traktr]", msg, e);
          }
        }
      }
    }
  }
}
