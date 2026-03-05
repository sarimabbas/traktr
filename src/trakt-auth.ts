import { Modal, App, Notice } from "obsidian";
import {
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  TraktApiError,
} from "./trakt-api";
import type { TraktrSettings } from "./settings";

/**
 * Modal that displays the device auth flow UI.
 * Shows the verification URL, user code, and polls for authorization.
 */
export class AuthModal extends Modal {
  private cancelled = false;
  private pollInterval: number | null = null;
  private settings: TraktrSettings;
  private onSuccess: () => Promise<void>;

  constructor(
    app: App,
    settings: TraktrSettings,
    onSuccess: () => Promise<void>
  ) {
    super(app);
    this.settings = settings;
    this.onSuccess = onSuccess;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("trakt-auth-modal");

    contentEl.createEl("h2", { text: "Connect to Trakt" });

    const statusEl = contentEl.createEl("p", {
      text: "Requesting device code...",
      cls: "trakt-auth-status",
    });

    try {
      const deviceCode = await requestDeviceCode(this.settings.clientId);

      if (this.cancelled) return;

      // Show instructions
      statusEl.setText("Open the link below and enter the code:");

      const linkEl = contentEl.createEl("p");
      linkEl.createEl("a", {
        text: deviceCode.verification_url,
        href: deviceCode.verification_url,
      });

      const codeContainer = contentEl.createEl("div", {
        cls: "trakt-auth-code-container",
      });
      const codeEl = codeContainer.createEl("code", {
        text: deviceCode.user_code,
        cls: "trakt-auth-code",
      });
      codeEl.addEventListener("click", () => {
        navigator.clipboard.writeText(deviceCode.user_code);
        new Notice("Code copied to clipboard!");
      });
      codeContainer.createEl("small", {
        text: "Click to copy",
        cls: "trakt-auth-copy-hint",
      });

      const countdownEl = contentEl.createEl("p", {
        cls: "trakt-auth-countdown",
      });

      const cancelBtn = contentEl.createEl("button", {
        text: "Cancel",
      });
      cancelBtn.addEventListener("click", () => this.close());

      // Start countdown
      const expiresAt = Date.now() + deviceCode.expires_in * 1000;
      const countdownInterval = window.setInterval(() => {
        const remaining = Math.max(
          0,
          Math.floor((expiresAt - Date.now()) / 1000)
        );
        countdownEl.setText(`Code expires in ${remaining}s`);
        if (remaining <= 0) {
          window.clearInterval(countdownInterval);
          statusEl.setText("Code expired. Please close and try again.");
        }
      }, 1000);

      // Start polling
      const pollIntervalMs = (deviceCode.interval || 5) * 1000;
      this.pollInterval = window.setInterval(async () => {
        if (this.cancelled) {
          this.clearPolling();
          window.clearInterval(countdownInterval);
          return;
        }

        try {
          const token = await pollDeviceToken(
            deviceCode.device_code,
            this.settings.clientId,
            this.settings.clientSecret
          );

          if (token) {
            this.clearPolling();
            window.clearInterval(countdownInterval);

            // Save tokens
            this.settings.accessToken = token.access_token;
            this.settings.refreshToken = token.refresh_token;
            this.settings.tokenExpiresAt =
              (token.created_at + token.expires_in) * 1000;

            await this.onSuccess();

            new Notice("Successfully connected to Trakt!");
            this.close();
          }
        } catch (e) {
          if (e instanceof TraktApiError && !e.isRetryable) {
            this.clearPolling();
            window.clearInterval(countdownInterval);
            statusEl.setText(`Error: ${e.message}`);
          }
          // For retryable errors (429), just skip this poll cycle
        }
      }, pollIntervalMs);
    } catch (e) {
      statusEl.setText(
        `Failed to start auth: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private clearPolling() {
    if (this.pollInterval !== null) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  onClose() {
    this.cancelled = true;
    this.clearPolling();
    this.contentEl.empty();
  }
}

/**
 * Ensures the access token is still valid.
 * Refreshes it if expired or within a 1-hour buffer.
 * Throws if refresh fails (caller should prompt re-auth).
 */
export async function ensureValidToken(
  settings: TraktrSettings,
  saveSettings: () => Promise<void>
): Promise<void> {
  if (!settings.accessToken || !settings.refreshToken) {
    throw new Error("Not connected to Trakt. Please connect first.");
  }

  const bufferMs = 60 * 60 * 1000; // 1 hour
  if (Date.now() < settings.tokenExpiresAt - bufferMs) {
    return; // Token is still valid
  }

  // Refresh the token
  try {
    const token = await refreshAccessToken(
      settings.refreshToken,
      settings.clientId,
      settings.clientSecret
    );
    settings.accessToken = token.access_token;
    settings.refreshToken = token.refresh_token;
    settings.tokenExpiresAt = (token.created_at + token.expires_in) * 1000;
    await saveSettings();
  } catch {
    // Clear tokens on refresh failure
    settings.accessToken = "";
    settings.refreshToken = "";
    settings.tokenExpiresAt = 0;
    await saveSettings();
    throw new Error("Trakt session expired. Please reconnect.");
  }
}
