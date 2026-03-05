import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  TraksidianSettingTab,
  type TraksidianSettings,
} from "./settings";
import { AuthModal } from "./trakt-auth";
import { SyncEngine } from "./sync-engine";

export default class TraksidianPlugin extends Plugin {
  settings: TraksidianSettings = DEFAULT_SETTINGS;
  private syncEngine!: SyncEngine;
  private autoSyncIntervalId: number | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    console.debug(
      "[Traksidian] Plugin loaded. Connected:",
      !!this.settings.accessToken,
    );

    this.syncEngine = new SyncEngine(this.app, this.settings, () =>
      this.saveSettings(),
    );

    // Settings tab
    this.addSettingTab(new TraksidianSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "trakt-sync",
      name: "Sync",
      callback: async () => {
        if (!this.settings.accessToken) {
          new Notice(
            "Not connected to Trakt. Use Settings or the command palette to connect.",
          );
          return;
        }
        this.updateStatusBar("⟳ Syncing…");
        await this.syncEngine.sync();
        this.updateStatusBar("");
      },
    });

    this.addCommand({
      id: "trakt-connect",
      name: "Connect account",
      callback: async () => {
        if (!this.settings.clientId || !this.settings.clientSecret) {
          new Notice(
            "Please configure your Trakt Client ID and Secret in settings first.",
          );
          return;
        }
        await this.startAuth();
      },
    });

    this.addCommand({
      id: "trakt-disconnect",
      name: "Disconnect account",
      callback: async () => {
        this.settings.accessToken = "";
        this.settings.refreshToken = "";
        this.settings.tokenExpiresAt = 0;
        await this.saveSettings();
        new Notice("Disconnected from Trakt.");
      },
    });

    // Status bar — only shown transiently during sync
    this.statusBarEl = this.addStatusBarItem();

    // Auto-sync
    this.configureAutoSync();

    // Sync on startup (delayed to let Obsidian finish loading)
    if (this.settings.syncOnStartup && this.settings.accessToken) {
      window.setTimeout(async () => {
        this.updateStatusBar("⟳ Syncing…");
        await this.syncEngine.sync();
        this.updateStatusBar("");
      }, 5000);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /**
   * Start the Trakt device auth flow.
   */
  async startAuth(): Promise<void> {
    const modal = new AuthModal(this.app, this.settings, async () => {
      await this.saveSettings();
    });
    modal.open();
  }

  /**
   * Configure or reconfigure the auto-sync interval.
   */
  configureAutoSync() {
    // Clear existing interval
    if (this.autoSyncIntervalId !== null) {
      window.clearInterval(this.autoSyncIntervalId);
      this.autoSyncIntervalId = null;
    }

    if (this.settings.autoSyncEnabled && this.settings.accessToken) {
      const intervalMs = this.settings.autoSyncIntervalMinutes * 60 * 1000;
      this.autoSyncIntervalId = window.setInterval(async () => {
        try {
          await this.syncEngine.sync();
        } catch (e) {
          console.error("Trakt auto-sync failed:", e);
        }
      }, intervalMs);
      // Register for cleanup
      this.registerInterval(this.autoSyncIntervalId);
    }
  }

  private updateStatusBar(status: string) {
    if (this.statusBarEl) {
      this.statusBarEl.setText(status ? `Traksidian: ${status}` : "");
    }
  }
}
