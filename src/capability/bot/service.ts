import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import type { WecomRuntimeEnv } from "../../types/runtime-context.js";
import type { WecomAccountRuntime } from "../../app/account-runtime.js";
import { BotWsSdkAdapter } from "../../transport/bot-ws/sdk-adapter.js";
import { startBotWebhookTransport } from "../../transport/bot-webhook/http-handler.js";

/** Backoff for restarting a WS transport the SDK gave up on: 5 s doubling to 5 min. */
const WS_RESTART_BASE_MS = 5_000;
const WS_RESTART_MAX_MS = 5 * 60_000;
const WS_RESTART_MAX_ATTEMPTS = 10;
/** A transport that ran this long before failing starts a fresh attempt budget. */
const WS_STABLE_RUN_MS = 10 * 60_000;

export class WecomBotCapabilityService {
  private wsAdapter?: BotWsSdkAdapter;
  private stopTransport?: () => void;
  private stopFatalWatch?: () => void;
  private wsRestartTimer?: ReturnType<typeof setTimeout>;
  private wsRestartAttempts = 0;
  private wsStartedAt = 0;

  constructor(
    private readonly runtime: WecomAccountRuntime,
    private readonly cfg: OpenClawConfig,
    private readonly runtimeEnv: WecomRuntimeEnv,
  ) {}

  start(): { transport: "bot-ws" | "bot-webhook"; descriptors: string[] } | undefined {
    const bot = this.runtime.account.bot;
    if (!bot?.configured) {
      return undefined;
    }

    if (bot.primaryTransport === "ws") {
      this.startWs();
      this.stopTransport = () => this.wsAdapter?.stop();
      this.stopFatalWatch = this.runtime.onTransportFatal((error) => this.restartWs(error));
      return {
        transport: "bot-ws",
        descriptors: ["ws:primary"],
      };
    }

    const webhook = startBotWebhookTransport({
      account: bot,
      cfg: this.cfg,
      runtime: this.runtime,
      runtimeEnv: this.runtimeEnv,
    });
    this.stopTransport = webhook.stop;
    return {
      transport: "bot-webhook",
      descriptors: webhook.paths,
    };
  }

  stop(): void {
    clearTimeout(this.wsRestartTimer);
    this.wsRestartTimer = undefined;
    this.stopFatalWatch?.();
    this.stopFatalWatch = undefined;
    this.stopTransport?.();
    this.stopTransport = undefined;
    this.wsAdapter = undefined;
  }

  private startWs(): void {
    this.wsAdapter = new BotWsSdkAdapter(this.runtime, {
      info: this.runtimeEnv.log,
      warn: this.runtimeEnv.log,
      error: this.runtimeEnv.error,
    });
    this.wsAdapter.start();
    this.wsStartedAt = Date.now();
  }

  /**
   * The SDK stops for good after its reconnect budget or repeated auth
   * failures. Replace just the WS adapter with backoff: restarting the whole
   * account would also take down its healthy agent callbacks.
   */
  private restartWs(error: Error): void {
    if (this.wsRestartTimer || !this.wsAdapter) {
      return;
    }
    this.wsAdapter.stop();
    this.wsAdapter = undefined;
    if (Date.now() - this.wsStartedAt >= WS_STABLE_RUN_MS) {
      this.wsRestartAttempts = 0;
    }
    this.wsRestartAttempts += 1;
    const accountId = this.runtime.account.accountId;
    if (this.wsRestartAttempts > WS_RESTART_MAX_ATTEMPTS) {
      this.runtimeEnv.error?.(
        `[wecom-ws] restart-gave-up account=${accountId} attempts=${WS_RESTART_MAX_ATTEMPTS} error=${error.message}`,
      );
      return;
    }
    const delayMs = Math.min(
      WS_RESTART_BASE_MS * 2 ** (this.wsRestartAttempts - 1),
      WS_RESTART_MAX_MS,
    );
    this.runtimeEnv.error?.(
      `[wecom-ws] restart-scheduled account=${accountId} attempt=${this.wsRestartAttempts}/${WS_RESTART_MAX_ATTEMPTS} delayMs=${delayMs} error=${error.message}`,
    );
    this.wsRestartTimer = setTimeout(() => {
      this.wsRestartTimer = undefined;
      this.startWs();
    }, delayMs);
    this.wsRestartTimer.unref?.();
  }
}
