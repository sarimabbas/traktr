import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type TraktrPlugin from "./main";

export const POSTER_SIZES = [
  "w92",
  "w154",
  "w185",
  "w342",
  "w500",
  "w780",
  "original",
] as const;

export type PosterSize = (typeof POSTER_SIZES)[number];

export interface TraktrSettings {
  // Authentication
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;

  // TMDB
  tmdbApiKey: string;
  posterSize: PosterSize;

  // Property namespace
  propertyPrefix: string;

  // Folders & file naming
  folder: string;
  filenameTemplate: string;

  // Note templates
  movieNoteTemplate: string;
  showNoteTemplate: string;

  // Tags
  addTags: boolean;
  tagPrefix: string;

  // Tag notes
  addTagNotes: boolean;
  createTagNotes: boolean;
  tagNotesFolder: string;

  // Sync sources
  syncWatchlist: boolean;
  syncFavorites: boolean;
  syncWatched: boolean;
  syncRatings: boolean;

  // Sync behavior
  syncMovies: boolean;
  syncShows: boolean;
  autoSyncEnabled: boolean;
  autoSyncIntervalMinutes: number;
  syncOnStartup: boolean;
  overwriteExisting: boolean;
  deleteRemovedItems: boolean;
}

export const DEFAULT_MOVIE_TEMPLATE = `![poster]({{poster_url}})

> {{tagline}}

## Overview
{{overview}}

## Details
- **Runtime**: {{runtime}} min
- **Genres**: {{genres}}
- **Rating**: {{trakt_rating}}/10 ({{trakt_votes}} votes)
- **Certification**: {{certification}}
- **Released**: {{released}}

## Trakt Status
- **Watchlist**: {{watchlist}}
- **Watched**: {{watched}} ({{plays}} plays, last: {{last_watched_at}})
- **Favorite**: {{favorite}}
- **My Rating**: {{my_rating}}/10

## Links
- [Trakt]({{trakt_url}})
- [IMDB]({{imdb_url}})

## My Notes

`;

export const DEFAULT_SHOW_TEMPLATE = `![poster]({{poster_url}})

## Overview
{{overview}}

## Details
- **Network**: {{network}}
- **Runtime**: {{runtime}} min per episode
- **Episodes**: {{aired_episodes}} aired
- **Genres**: {{genres}}
- **Rating**: {{trakt_rating}}/10 ({{trakt_votes}} votes)
- **Certification**: {{certification}}
- **Status**: {{status}}
- **First Aired**: {{first_aired}}

## Trakt Status
- **Watchlist**: {{watchlist}}
- **Watched**: {{watched}} ({{plays}} plays, last: {{last_watched_at}})
- **Favorite**: {{favorite}}
- **My Rating**: {{my_rating}}/10

## Links
- [Trakt]({{trakt_url}})
- [IMDB]({{imdb_url}})

## My Notes

`;

export const DEFAULT_SETTINGS: TraktrSettings = {
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,

  tmdbApiKey: "",
  posterSize: "w500",

  propertyPrefix: "trakt_",

  folder: "trakt",
  filenameTemplate: "{{title}} ({{year}})",

  movieNoteTemplate: DEFAULT_MOVIE_TEMPLATE,
  showNoteTemplate: DEFAULT_SHOW_TEMPLATE,

  addTags: true,
  tagPrefix: "trakt",

  addTagNotes: false,
  createTagNotes: false,
  tagNotesFolder: "trakt",

  syncWatchlist: true,
  syncFavorites: true,
  syncWatched: false,
  syncRatings: false,

  syncMovies: true,
  syncShows: true,
  autoSyncEnabled: false,
  autoSyncIntervalMinutes: 60,
  syncOnStartup: false,
  overwriteExisting: false,
  deleteRemovedItems: false,
};

export class TraktrSettingTab extends PluginSettingTab {
  plugin: TraktrPlugin;

  constructor(app: App, plugin: TraktrPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Authentication ──
    new Setting(containerEl).setName("Authentication").setHeading();

    new Setting(containerEl)
      .setName("Trakt client ID")
      .setDesc("Create an app at trakt.tv/oauth/applications to get this.")
      .addText((text) =>
        text
          .setPlaceholder("Trakt client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Trakt client secret")
      .setDesc("From the same application page.")
      .addText((text) =>
        text
          .setPlaceholder("Trakt client secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    const connectionSetting = new Setting(containerEl).setName(
      "Connection status",
    );

    if (this.plugin.settings.accessToken) {
      connectionSetting.setDesc("Traktr connected.");
      connectionSetting.addButton((btn) =>
        btn
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.accessToken = "";
            this.plugin.settings.refreshToken = "";
            this.plugin.settings.tokenExpiresAt = 0;
            await this.plugin.saveSettings();
            new Notice("Traktr disconnected.");
            this.display();
          }),
      );
    } else {
      connectionSetting.setDesc("Not connected.");
      connectionSetting.addButton((btn) =>
        btn
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            if (
              !this.plugin.settings.clientId ||
              !this.plugin.settings.clientSecret
            ) {
              new Notice("Please enter your client ID and secret first.");
              return;
            }
            this.plugin.startAuth();
            this.display();
          }),
      );
    }

    // ── TMDB (poster images) ──
    new Setting(containerEl).setName("TMDB").setHeading();

    new Setting(containerEl)
      .setName("API key")
      .setDesc(
        "Optional. Get a free key at themoviedb.org/settings/api. If blank, poster images are skipped.",
      )
      .addText((text) =>
        text
          .setPlaceholder("Paste your API key")
          .setValue(this.plugin.settings.tmdbApiKey)
          .onChange(async (value) => {
            this.plugin.settings.tmdbApiKey = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Poster size")
      .setDesc("Image size for posters embedded in notes.")
      .addDropdown((dd) => {
        for (const size of POSTER_SIZES) {
          dd.addOption(size, size);
        }
        dd.setValue(this.plugin.settings.posterSize);
        dd.onChange(async (value) => {
          this.plugin.settings.posterSize = value as PosterSize;
          await this.plugin.saveSettings();
        });
      });

    // ── Notes ──
    new Setting(containerEl).setName("Notes").setHeading();

    new Setting(containerEl)
      .setName("Notes folder")
      .setDesc("Vault folder where notes are stored.")
      .addText((text) =>
        text
          .setPlaceholder("Trakt")
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Filename template")
      .setDesc(
        "Template for note filenames. Variables: {{title}}, {{year}}, {{imdb_id}}, {{trakt_id}}.",
      )
      .addText((text) =>
        text
          .setPlaceholder("{{title}} ({{year}})")
          .setValue(this.plugin.settings.filenameTemplate)
          .onChange(async (value) => {
            this.plugin.settings.filenameTemplate = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Property prefix")
      .setDesc(
        'Prefix for all frontmatter properties added by this plugin. E.g. "trakt_" → trakt_title, trakt_watched. Leave blank for no prefix.',
      )
      .addText((text) =>
        text
          .setPlaceholder("Trakt_")
          .setValue(this.plugin.settings.propertyPrefix)
          .onChange(async (value) => {
            this.plugin.settings.propertyPrefix = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Note templates ──
    new Setting(containerEl).setName("Note templates").setHeading();

    const movieTemplateSetting = new Setting(containerEl)
      .setName("Movie note template")
      .setDesc(
        "Template for the body of movie notes. Uses {{variable}} syntax.",
      );
    movieTemplateSetting.addTextArea((ta) => {
      ta.inputEl.rows = 12;
      ta.inputEl.cols = 60;
      ta.setValue(this.plugin.settings.movieNoteTemplate).onChange(
        async (value) => {
          this.plugin.settings.movieNoteTemplate = value;
          await this.plugin.saveSettings();
        },
      );
    });
    movieTemplateSetting.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        this.plugin.settings.movieNoteTemplate = DEFAULT_MOVIE_TEMPLATE;
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    const showTemplateSetting = new Setting(containerEl)
      .setName("Show template")
      .setDesc(
        "Template for the body of TV show notes. Uses {{variable}} syntax.",
      );
    showTemplateSetting.addTextArea((ta) => {
      ta.inputEl.rows = 12;
      ta.inputEl.cols = 60;
      ta.setValue(this.plugin.settings.showNoteTemplate).onChange(
        async (value) => {
          this.plugin.settings.showNoteTemplate = value;
          await this.plugin.saveSettings();
        },
      );
    });
    showTemplateSetting.addButton((btn) =>
      btn.setButtonText("Reset to default").onClick(async () => {
        this.plugin.settings.showNoteTemplate = DEFAULT_SHOW_TEMPLATE;
        await this.plugin.saveSettings();
        this.display();
      }),
    );

    // ── Tags ──
    new Setting(containerEl).setName("Tags").setHeading();

    new Setting(containerEl)
      .setName("Add tags")
      .setDesc(
        "Add metadata tags to the note frontmatter on each sync. E.g. #trakt/genre/action.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.addTags)
          .onChange(async (value) => {
            this.plugin.settings.addTags = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Tag prefix")
      .setDesc(
        'Prefix for tags. E.g. "trakt" → #trakt/movie, #trakt/genre/action.',
      )
      .addText((text) =>
        text
          .setPlaceholder("Trakt")
          .setValue(this.plugin.settings.tagPrefix)
          .onChange(async (value) => {
            this.plugin.settings.tagPrefix = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Tag notes ──
    new Setting(containerEl)
      .setName("Tag notes")
      .setDesc(
        "Tag notes are topic files you link to/from your notes. Stick to one of tags or tag notes, or use both.",
      )
      .setHeading();

    new Setting(containerEl)
      .setName("Add tag notes to frontmatter")
      .setDesc(
        "Add a wikilink list property to the note frontmatter on each sync. E.g. [[trakt/genre/action]]. Or leave this setting off and use the {{tag_notes}} template variable to place links in the note body instead.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.addTagNotes)
          .onChange(async (value) => {
            this.plugin.settings.addTagNotes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Create tag notes")
      .setDesc("Automatically create tag note files if they don't exist.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.createTagNotes)
          .onChange(async (value) => {
            this.plugin.settings.createTagNotes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Tag notes folder")
      .setDesc(
        'Folder for tag notes. Used for frontmatter links, file creation, and the {{tag_notes}} template variable. E.g. "trakt" → [[trakt/genre/action]].',
      )
      .addText((text) =>
        text
          .setPlaceholder("Trakt")
          .setValue(this.plugin.settings.tagNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.tagNotesFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── Sync sources ──
    new Setting(containerEl).setName("Sync sources").setHeading();

    new Setting(containerEl)
      .setName("Sync watchlist")
      .setDesc("Items you want to watch.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncWatchlist)
          .onChange(async (value) => {
            this.plugin.settings.syncWatchlist = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync favorites")
      .setDesc("Items you've marked as favorites.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncFavorites)
          .onChange(async (value) => {
            this.plugin.settings.syncFavorites = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync watch history")
      .setDesc(
        "Items you've watched. Adds play count and last watched date. Can be large.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncWatched)
          .onChange(async (value) => {
            this.plugin.settings.syncWatched = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync ratings")
      .setDesc("Items you've rated (1–10 scale).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncRatings)
          .onChange(async (value) => {
            this.plugin.settings.syncRatings = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Sync behavior ──
    new Setting(containerEl).setName("Sync behavior").setHeading();

    new Setting(containerEl)
      .setName("Sync movies")
      .setDesc("Include movies.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncMovies)
          .onChange(async (value) => {
            this.plugin.settings.syncMovies = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync shows")
      .setDesc("Include shows.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncShows)
          .onChange(async (value) => {
            this.plugin.settings.syncShows = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Automatically sync when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync")
      .setDesc(`Periodically sync in the background.`)
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.configureAutoSync();
            this.display();
          }),
      );

    if (this.plugin.settings.autoSyncEnabled) {
      new Setting(containerEl)
        .setName("Auto-sync interval (minutes)")
        .setDesc("How often to sync. Minimum 5, maximum 360.")
        .addSlider((slider) =>
          slider
            .setLimits(5, 360, 5)
            .setValue(this.plugin.settings.autoSyncIntervalMinutes)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.autoSyncIntervalMinutes = value;
              await this.plugin.saveSettings();
              this.plugin.configureAutoSync();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Overwrite existing note body")
      .setDesc(
        "When off, only frontmatter is updated and your notes are preserved. When on, the full note is regenerated from the template on every sync — any edits you've made to the note body will be permanently lost.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.overwriteExisting)
          .onChange(async (value) => {
            this.plugin.settings.overwriteExisting = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Remove notes for deleted items")
      .setDesc("When on, notes from all sync sources are moved to trash.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteRemovedItems)
          .onChange(async (value) => {
            this.plugin.settings.deleteRemovedItems = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Reset ──
    new Setting(containerEl).setName("Reset").setHeading();

    new Setting(containerEl)
      .setName("Reset to defaults")
      .setDesc(
        "Clear all settings back to their default values. Authentication credentials are preserved.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Reset to defaults")
          .setWarning()
          .onClick(async () => {
            const {
              accessToken,
              refreshToken,
              clientId,
              clientSecret,
              tokenExpiresAt,
              tmdbApiKey,
            } = this.plugin.settings;
            Object.assign(this.plugin.settings, DEFAULT_SETTINGS, {
              accessToken,
              refreshToken,
              clientId,
              clientSecret,
              tokenExpiresAt,
              tmdbApiKey,
            });
            await this.plugin.saveSettings();
            this.plugin.configureAutoSync();
            new Notice("Settings reset to defaults.");
            this.display();
          }),
      );
  }
}
