// Rcs plugin module implements accounts behavior.
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredAccountValue,
  listCombinedAccountIds,
  resolveAccountEntry,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeRcsAllowFrom } from "./address.js";
import { parseRcsPublicWebhookUrl } from "./public-webhook-url.js";
import type { RcsChannelConfig, ResolvedRcsAccount } from "./types.js";

const CHANNEL_ID = "rcs";
const DEFAULT_WEBHOOK_PATH = "/webhooks/rcs";

function getChannelConfig(cfg: OpenClawConfig): RcsChannelConfig | undefined {
  // SAFETY: the channel config is validated against the RCS manifest schema before resolution.
  return cfg?.channels?.[CHANNEL_ID] as RcsChannelConfig | undefined;
}

function parseList(raw: unknown): string[] {
  if (!raw) {
    return [];
  }
  const entries = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? normalizeStringEntries(raw.split(","))
      : [raw];
  return entries.map((entry) => normalizeRcsAllowFrom(String(entry))).filter(Boolean);
}

function hasBaseAccount(channelCfg: RcsChannelConfig | undefined): boolean {
  return (
    [
      channelCfg?.accountSid,
      channelCfg?.messagingServiceSid,
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      process.env.TWILIO_RCS_MESSAGING_SERVICE_SID,
    ].some((value) => hasConfiguredAccountValue(value)) ||
    hasConfiguredSecretInput(channelCfg?.authToken)
  );
}

export function listRcsAccountIds(cfg: OpenClawConfig): string[] {
  const channelCfg = getChannelConfig(cfg);
  return listCombinedAccountIds({
    configuredAccountIds: Object.keys(channelCfg?.accounts ?? {}),
    implicitAccountId: hasBaseAccount(channelCfg) ? DEFAULT_ACCOUNT_ID : undefined,
  });
}

export function resolveDefaultRcsAccountId(cfg: OpenClawConfig): string {
  const channelCfg = getChannelConfig(cfg);
  return resolveListedDefaultAccountId({
    accountIds: listRcsAccountIds(cfg),
    configuredDefaultAccountId: normalizeOptionalAccountId(channelCfg?.defaultAccount),
  });
}

export function resolveRcsAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedRcsAccount {
  const channelCfg = getChannelConfig(cfg) ?? {};
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultRcsAccountId(cfg);
  const accountConfig = resolveAccountEntry(channelCfg.accounts, id);
  const channelConfig: Record<string, unknown> & RcsChannelConfig = { ...channelCfg };
  const accountEntries:
    | Record<string, Partial<Record<string, unknown> & RcsChannelConfig>>
    | undefined = channelCfg.accounts
    ? Object.fromEntries(
        Object.entries(channelCfg.accounts).map(([accountKey, account]) => [
          accountKey,
          { ...account },
        ]),
      )
    : undefined;
  const merged = resolveMergedAccountConfig<Record<string, unknown> & RcsChannelConfig>({
    channelConfig,
    accounts: accountEntries,
    accountId: id,
    omitKeys: ["defaultAccount"],
  });

  const useEnvFallbacks = id === DEFAULT_ACCOUNT_ID;
  const envAccountSid = useEnvFallbacks ? process.env.TWILIO_ACCOUNT_SID : undefined;
  const envAuthToken = useEnvFallbacks ? process.env.TWILIO_AUTH_TOKEN : undefined;
  const envMessagingServiceSid = useEnvFallbacks
    ? process.env.TWILIO_RCS_MESSAGING_SERVICE_SID
    : undefined;
  const envWebhookPath = useEnvFallbacks ? process.env.RCS_WEBHOOK_PATH : undefined;
  const envPublicWebhookUrl = useEnvFallbacks ? process.env.RCS_PUBLIC_WEBHOOK_URL : undefined;
  const envAllowFrom = useEnvFallbacks ? process.env.RCS_ALLOWED_USERS : undefined;

  const webhookPath = (merged.webhookPath ?? envWebhookPath ?? DEFAULT_WEBHOOK_PATH).trim();
  const publicWebhookUrl = (merged.publicWebhookUrl ?? envPublicWebhookUrl ?? "").trim();
  const authToken =
    normalizeResolvedSecretInputString({
      value: merged.authToken ?? envAuthToken,
      path:
        id === DEFAULT_ACCOUNT_ID
          ? "channels.rcs.authToken"
          : `channels.rcs.accounts.${id}.authToken`,
    }) ?? "";
  return {
    accountId: id,
    enabled: channelCfg.enabled !== false && accountConfig?.enabled !== false,
    accountSid: (merged.accountSid ?? envAccountSid ?? "").trim(),
    authToken,
    messagingServiceSid: (merged.messagingServiceSid ?? envMessagingServiceSid ?? "").trim(),
    webhookPath: webhookPath || DEFAULT_WEBHOOK_PATH,
    publicWebhookUrl,
    dangerouslyDisableSignatureValidation: merged.dangerouslyDisableSignatureValidation === true,
    dmPolicy: merged.dmPolicy ?? "pairing",
    allowFrom: parseList(merged.allowFrom ?? envAllowFrom),
  };
}

export function inspectRcsAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveRcsAccount(cfg, accountId);
  const configured = isRcsAccountConfigured(account);
  const publicWebhookUrlConfigured = Boolean(parseRcsPublicWebhookUrl(account.publicWebhookUrl));
  return {
    enabled: account.enabled,
    configured,
    tokenStatus: account.authToken ? "available" : "missing",
    webhookPath: account.webhookPath,
    signatureValidation:
      account.dangerouslyDisableSignatureValidation || publicWebhookUrlConfigured
        ? "configured"
        : "missing-public-url",
  };
}

export function isRcsAccountConfigured(account: ResolvedRcsAccount): boolean {
  return Boolean(
    account.accountSid &&
    account.authToken &&
    account.messagingServiceSid &&
    parseRcsPublicWebhookUrl(account.publicWebhookUrl),
  );
}
