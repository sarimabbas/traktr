import type { NormalizedItem } from "./types";
import type { TraksidianSettings } from "./settings";
import { renderTemplate, toFrontmatter } from "./utils";

function traktUrl(item: NormalizedItem): string {
  return `https://trakt.tv/${item.type === "movie" ? "movies" : "shows"}/${item.ids.slug}`;
}

function imdbUrl(item: NormalizedItem): string | null {
  return item.ids.imdb ? `https://www.imdb.com/title/${item.ids.imdb}` : null;
}

/**
 * Build the full template context (variables available for {{interpolation}})
 * from a normalized item. Template variables are NOT prefixed — they use
 * friendly names so templates stay readable.
 */
function buildTemplateContext(
  item: NormalizedItem
): Record<string, unknown> {
  return {
    title: item.title,
    year: item.year,
    type: item.type,
    overview: item.overview,
    genres: item.genres.join(", "),
    runtime: item.runtime,
    trakt_rating: item.rating,
    trakt_votes: item.votes,
    certification: item.certification,
    country: item.country,
    language: item.language,
    status: item.status,
    trakt_id: item.ids.trakt,
    trakt_slug: item.ids.slug,
    imdb_id: item.ids.imdb || "",
    tmdb_id: item.ids.tmdb || "",
    tvdb_id: item.ids.tvdb || "",
    trakt_url: traktUrl(item),
    imdb_url: imdbUrl(item) ?? "",
    poster_url: item.poster_url || "",
    // Movie-specific
    tagline: item.tagline || "",
    released: item.released || "",
    // Show-specific
    network: item.network || "",
    aired_episodes: item.aired_episodes || "",
    first_aired: item.first_aired ? item.first_aired.split("T")[0] : "",
    // Source flags
    watchlist: item.watchlist ? "true" : "",
    watchlist_added_at: item.watchlist_added_at || "",
    watched: item.watched ? "true" : "",
    plays: item.plays || "",
    last_watched_at: item.last_watched_at
      ? item.last_watched_at.split("T")[0]
      : "",
    episodes_watched: item.episodes_watched || "",
    favorite: item.favorite ? "true" : "",
    favorited_at: item.favorited_at || "",
    my_rating: item.my_rating || "",
    rated_at: item.rated_at || "",
  };
}

/**
 * Build the YAML frontmatter data object for an item.
 * ALL keys are prefixed with settings.propertyPrefix.
 */
function buildFrontmatterData(
  item: NormalizedItem,
  settings: TraksidianSettings
): Record<string, unknown> {
  const p = settings.propertyPrefix;
  const tagPfx = settings.tagPrefix;

  const tags = [`${tagPfx}/${item.type}`];
  for (const genre of item.genres) {
    tags.push(`${tagPfx}/genre/${genre}`);
  }
  if (item.watchlist) tags.push(`${tagPfx}/watchlist`);
  if (item.watched) tags.push(`${tagPfx}/watched`);
  if (item.favorite) tags.push(`${tagPfx}/favorite`);
  if (item.my_rating) tags.push(`${tagPfx}/rated`);

  const data: Record<string, unknown> = {};

  // Core metadata
  data[`${p}title`] = item.title;
  data[`${p}year`] = item.year;
  data[`${p}type`] = item.type;
  data[`${p}id`] = item.ids.trakt;
  data[`${p}slug`] = item.ids.slug;
  data[`${p}imdb_id`] = item.ids.imdb || null;
  data[`${p}tmdb_id`] = item.ids.tmdb || null;
  data[`${p}genres`] = item.genres;
  data[`${p}runtime`] = item.runtime;
  data[`${p}certification`] = item.certification;
  data[`${p}rating`] = item.rating;
  data[`${p}votes`] = item.votes;
  data[`${p}country`] = item.country;
  data[`${p}language`] = item.language;
  data[`${p}status`] = item.status;
  data[`${p}overview`] = item.overview;

  // Movie-specific
  if (item.type === "movie") {
    data[`${p}released`] = item.released || null;
    data[`${p}tagline`] = item.tagline || null;
  }

  // Show-specific
  if (item.type === "show") {
    data[`${p}tvdb_id`] = item.ids.tvdb || null;
    data[`${p}network`] = item.network || null;
    data[`${p}aired_episodes`] = item.aired_episodes || null;
    data[`${p}first_aired`] = item.first_aired
      ? item.first_aired.split("T")[0]
      : null;
  }

  // Source flags
  if (item.watchlist !== undefined) {
    data[`${p}watchlist`] = item.watchlist;
    if (item.watchlist_added_at) {
      data[`${p}watchlist_added_at`] = item.watchlist_added_at;
    }
  }

  if (item.watched !== undefined) {
    data[`${p}watched`] = item.watched;
    if (item.plays !== undefined) data[`${p}plays`] = item.plays;
    if (item.last_watched_at) {
      data[`${p}last_watched_at`] = item.last_watched_at;
    }
    if (item.episodes_watched !== undefined) {
      data[`${p}episodes_watched`] = item.episodes_watched;
    }
  }

  if (item.favorite !== undefined) {
    data[`${p}favorite`] = item.favorite;
    if (item.favorited_at) {
      data[`${p}favorited_at`] = item.favorited_at;
    }
  }

  if (item.my_rating !== undefined) {
    data[`${p}my_rating`] = item.my_rating;
    if (item.rated_at) {
      data[`${p}rated_at`] = item.rated_at;
    }
  }

  // Links
  data[`${p}url`] = traktUrl(item);
  data[`${p}imdb_url`] = imdbUrl(item);
  data[`${p}poster_url`] = item.poster_url || null;
  data[`${p}synced_at`] = new Date().toISOString();
  data["tags"] = tags;

  return data;
}

/**
 * Render a complete note (frontmatter + body) for an item.
 */
export function renderNote(
  item: NormalizedItem,
  settings: TraksidianSettings
): string {
  const fmData = buildFrontmatterData(item, settings);
  const frontmatter = toFrontmatter(fmData);

  const template =
    item.type === "movie"
      ? settings.movieNoteTemplate
      : settings.showNoteTemplate;

  const body = renderTemplate(template, buildTemplateContext(item));

  return `---\n${frontmatter}\n---\n${body}`;
}

/**
 * Render only the frontmatter section for an item.
 * Used when updating existing notes without overwriting the body.
 */
export function renderFrontmatterOnly(
  item: NormalizedItem,
  settings: TraksidianSettings
): string {
  return toFrontmatter(buildFrontmatterData(item, settings));
}
