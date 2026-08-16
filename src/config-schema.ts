// Rcs helper module supports config schema behavior.
import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
  DmPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const SecretInputSchema = buildSecretInputSchema();

const RcsAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    accountSid: z.string().optional(),
    authToken: SecretInputSchema.optional(),
    messagingServiceSid: z.string().optional(),
    webhookPath: z.string().optional(),
    publicWebhookUrl: z.string().optional(),
    dangerouslyDisableSignatureValidation: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: AllowFromListSchema,
  })
  .strict();

const RcsConfigSchema = buildMultiAccountChannelSchema(RcsAccountConfigSchema, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "rcs",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  },
});

export const RcsChannelConfigSchema = buildChannelConfigSchema(RcsConfigSchema, {
  uiHints: {
    "": {
      label: "RCS",
      help: "Twilio RCS Business Messaging channel configuration for RCS-only inbound and outbound messaging.",
    },
    accountSid: {
      label: "Twilio Account SID",
      help: "Twilio Account SID used for RCS outbound API calls.",
    },
    authToken: {
      label: "Twilio Auth Token",
      help: "Twilio Auth Token used to sign webhook validation and RCS outbound API calls.",
    },
    messagingServiceSid: {
      label: "Twilio Messaging Service SID",
      help: "Messaging Service whose sender pool contains the approved RCS Sender.",
    },
    publicWebhookUrl: {
      label: "RCS Public Webhook URL",
      help: "Public URL configured in Twilio for incoming messages. Must match Twilio's signed URL exactly.",
    },
    webhookPath: {
      label: "RCS Webhook Path",
      help: "Gateway HTTP path that receives Twilio incoming-message webhooks. Use a distinct path per account.",
    },
    dmPolicy: {
      label: "RCS DM Policy",
      help: 'Direct RCS access control ("pairing" recommended). "open" requires channels.rcs.allowFrom=["*"].',
    },
    allowFrom: {
      label: "RCS Allow From",
      help: "Allowed sender phone numbers in E.164 format, or * when dmPolicy is open.",
    },
  },
});
