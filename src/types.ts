// Rcs type declarations define plugin contracts.
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";

type RcsChannelConfigFields = {
  enabled?: boolean;
  accountSid?: string;
  authToken?: SecretInput;
  messagingServiceSid?: string;
  webhookPath?: string;
  publicWebhookUrl?: string;
  dangerouslyDisableSignatureValidation?: boolean;
  dmPolicy?: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom?: string | Array<string | number>;
};

export interface RcsChannelConfig extends RcsChannelConfigFields {
  accounts?: Record<string, RcsAccountRaw>;
  defaultAccount?: string;
}

interface RcsAccountRaw extends RcsChannelConfigFields {}

export interface ResolvedRcsAccount {
  accountId: string;
  enabled: boolean;
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  webhookPath: string;
  publicWebhookUrl: string;
  dangerouslyDisableSignatureValidation: boolean;
  dmPolicy: "pairing" | "open" | "allowlist" | "disabled";
  allowFrom: string[];
}

export interface RcsInboundMedia {
  url: string;
  contentType?: string;
}

export interface RcsInboundMessage {
  messageSid: string;
  accountSid: string;
  messagingServiceSid?: string;
  /** Raw Twilio RCS wire address. */
  from: string;
  to: string;
  body: string;
  media: RcsInboundMedia[];
  unavailableMediaCount?: number;
}

export type RcsSendResult = {
  sid: string;
  to: string;
  from?: string;
  status?: string;
};
