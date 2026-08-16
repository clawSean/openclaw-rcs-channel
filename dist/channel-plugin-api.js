import { t as getRcsRuntime } from "./runtime-BgEFQLky.js";
import { n as collectRuntimeConfigAssignments, r as secretTargetRegistryEntries } from "./secret-contract-CjWPbkM4.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { createHybridChannelConfigAdapter, createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { bindIngressLifecycleToReplyOptions, createAccountStatusSink, createChannelIngressMonitor, createMessageReceiptFromOutboundResults, defineChannelMessageAdapter, waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState } from "openclaw/plugin-sdk/status-helpers";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound, sanitizeAssistantVisibleText, stripMarkdown } from "openclaw/plugin-sdk/text-chunking";
import { DEFAULT_ACCOUNT_ID as DEFAULT_ACCOUNT_ID$1, hasConfiguredAccountValue, listCombinedAccountIds, resolveAccountEntry, resolveListedDefaultAccountId, resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { buildSecretInputSchema, hasConfiguredSecretInput, normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { isIP } from "node:net";
import { fetchWithSsrFGuard, isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { AllowFromListSchema, DmPolicySchema, buildChannelConfigSchema, buildMultiAccountChannelSchema, requireOpenAllowFrom } from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import { channelBlockedPatch, channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { createFixedWindowRateLimiter, isRequestBodyLimitError, readRequestBodyWithLimit, registerPluginHttpRoute, resolveRequestClientIp } from "openclaw/plugin-sdk/webhook-ingress";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createHash, createHmac } from "node:crypto";
import * as querystring from "node:querystring";
import { redactSensitiveText, safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
//#region extensions/rcs/src/address.ts
const RCS_ADDRESS_PREFIX = /^rcs:/i;
function normalizeRcsIdentity(raw) {
	const trimmed = raw.trim().replace(RCS_ADDRESS_PREFIX, "");
	if (!trimmed) return "";
	return (trimmed.startsWith("+") ? trimmed : `+${trimmed}`).replace(/[^\d+]/g, "");
}
function looksLikeRcsTarget(raw) {
	const normalized = normalizeRcsIdentity(raw);
	return /^\+[1-9]\d{6,14}$/.test(normalized);
}
function toRcsWireAddress(identity) {
	const normalized = normalizeRcsIdentity(identity);
	return normalized ? `rcs:${normalized}` : "";
}
function isRcsWireAddress(raw) {
	return /^rcs:/i.test(raw.trim());
}
function normalizeRcsAllowFrom(raw) {
	if (raw.trim() === "*") return "*";
	return normalizeRcsIdentity(raw).toLowerCase();
}
//#endregion
//#region extensions/rcs/src/public-webhook-url.ts
const RCS_STATUS_CALLBACK_MAX_LENGTH = 4e3;
const RCS_STATUS_CALLBACK_READ_TIMEOUT_MS = 5e3;
const TWILIO_READ_TIMEOUT_MIN_MS = 100;
const TWILIO_READ_TIMEOUT_MAX_MS = 15e3;
const ABSOLUTE_HTTPS_URL_PATTERN = /^https:\/\//iu;
const RAW_AUTHORITY_PATTERN = /^[a-z0-9.:[\]-]+$/iu;
const RAW_PATH_QUERY_FRAGMENT_PATTERN = /^[a-z0-9\-._~%!$&'()*+,;=:@/?]*$/iu;
const INVALID_PERCENT_ESCAPE_PATTERN = /%(?![0-9a-f]{2})/iu;
function hasForbiddenRawUrlCharacter(value) {
	for (let index = 0; index < value.length; index += 1) {
		const codePoint = value.charCodeAt(index);
		if (codePoint <= 32 || codePoint === 92 || codePoint === 127) return true;
	}
	return false;
}
function hasSafeRawUrlCharacters(value) {
	const match = /^https:\/\/([^/?#]*)([^#]*)(?:#(.*))?$/iu.exec(value);
	if (!match) return false;
	return RAW_AUTHORITY_PATTERN.test(match[1] ?? "") && RAW_PATH_QUERY_FRAGMENT_PATTERN.test(match[2] ?? "") && RAW_PATH_QUERY_FRAGMENT_PATTERN.test(match[3] ?? "");
}
function hasValidHostname(url) {
	const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
	if (isBlockedHostnameOrIp(hostname)) return false;
	if (isIP(hostname) !== 0) return true;
	const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
	if (!normalized.includes(".") || normalized.length > 253) return false;
	return normalized.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label));
}
function parseRcsPublicWebhookUrl(value) {
	const trimmed = value.trim();
	if (!ABSOLUTE_HTTPS_URL_PATTERN.test(trimmed) || !hasSafeRawUrlCharacters(trimmed) || INVALID_PERCENT_ESCAPE_PATTERN.test(trimmed) || hasForbiddenRawUrlCharacter(trimmed)) return;
	let url;
	try {
		url = new URL(trimmed);
	} catch {
		return;
	}
	if (url.protocol !== "https:" || url.username || url.password || !hasValidHostname(url)) return;
	return url;
}
function parseTwilioRetryPolicies(overrides) {
	const policies = overrides.getAll("rp").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
	return policies.length > 0 ? [...new Set(policies)] : ["ct"];
}
function resolveRcsStatusCallbackUrl(publicWebhookUrl) {
	const trimmed = publicWebhookUrl.trim();
	if (!trimmed || !parseRcsPublicWebhookUrl(trimmed)) return "";
	const hashIndex = trimmed.indexOf("#");
	const baseUrl = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
	const overrides = new URLSearchParams(hashIndex === -1 ? "" : trimmed.slice(hashIndex + 1));
	const retryPolicies = parseTwilioRetryPolicies(overrides);
	const normalizedPolicies = new Set(retryPolicies.map((policy) => policy.toLowerCase()));
	if (!normalizedPolicies.has("all")) {
		for (const requiredPolicy of [
			"ct",
			"rt",
			"5xx"
		]) if (!normalizedPolicies.has(requiredPolicy)) retryPolicies.push(requiredPolicy);
	}
	overrides.set("rp", retryPolicies.join(","));
	const configuredReadTimeout = Number(overrides.get("rt"));
	const readTimeout = Number.isInteger(configuredReadTimeout) && configuredReadTimeout >= TWILIO_READ_TIMEOUT_MIN_MS && configuredReadTimeout <= TWILIO_READ_TIMEOUT_MAX_MS ? configuredReadTimeout : RCS_STATUS_CALLBACK_READ_TIMEOUT_MS;
	overrides.set("rt", String(readTimeout));
	const configuredRetryCount = Number(overrides.get("rc"));
	const retryCount = Number.isInteger(configuredRetryCount) && configuredRetryCount >= 1 && configuredRetryCount <= 5 ? configuredRetryCount : 1;
	overrides.set("rc", String(retryCount));
	const callbackUrl = `${baseUrl}#${overrides.toString().replaceAll("%2C", ",")}`;
	if (callbackUrl.length > RCS_STATUS_CALLBACK_MAX_LENGTH || !parseRcsPublicWebhookUrl(callbackUrl)) return "";
	return callbackUrl;
}
//#endregion
//#region extensions/rcs/src/accounts.ts
const CHANNEL_ID$3 = "rcs";
const DEFAULT_WEBHOOK_PATH = "/webhooks/rcs";
function getChannelConfig(cfg) {
	return cfg?.channels?.[CHANNEL_ID$3];
}
function parseList(raw) {
	if (!raw) return [];
	return (Array.isArray(raw) ? raw : typeof raw === "string" ? normalizeStringEntries(raw.split(",")) : [raw]).map((entry) => normalizeRcsAllowFrom(String(entry))).filter(Boolean);
}
function hasBaseAccount(channelCfg) {
	return [
		channelCfg?.accountSid,
		channelCfg?.messagingServiceSid,
		process.env.TWILIO_ACCOUNT_SID,
		process.env.TWILIO_AUTH_TOKEN,
		process.env.TWILIO_RCS_MESSAGING_SERVICE_SID
	].some((value) => hasConfiguredAccountValue(value)) || hasConfiguredSecretInput(channelCfg?.authToken);
}
function listRcsAccountIds(cfg) {
	const channelCfg = getChannelConfig(cfg);
	return listCombinedAccountIds({
		configuredAccountIds: Object.keys(channelCfg?.accounts ?? {}),
		implicitAccountId: hasBaseAccount(channelCfg) ? DEFAULT_ACCOUNT_ID$1 : void 0
	});
}
function resolveDefaultRcsAccountId(cfg) {
	const channelCfg = getChannelConfig(cfg);
	return resolveListedDefaultAccountId({
		accountIds: listRcsAccountIds(cfg),
		configuredDefaultAccountId: normalizeOptionalAccountId(channelCfg?.defaultAccount)
	});
}
function resolveRcsAccount(cfg, accountId) {
	const channelCfg = getChannelConfig(cfg) ?? {};
	const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultRcsAccountId(cfg);
	const accountConfig = resolveAccountEntry(channelCfg.accounts, id);
	const merged = resolveMergedAccountConfig({
		channelConfig: { ...channelCfg },
		accounts: channelCfg.accounts ? Object.fromEntries(Object.entries(channelCfg.accounts).map(([accountKey, account]) => [accountKey, { ...account }])) : void 0,
		accountId: id,
		omitKeys: ["defaultAccount"]
	});
	const useEnvFallbacks = id === DEFAULT_ACCOUNT_ID$1;
	const envAccountSid = useEnvFallbacks ? process.env.TWILIO_ACCOUNT_SID : void 0;
	const envAuthToken = useEnvFallbacks ? process.env.TWILIO_AUTH_TOKEN : void 0;
	const envMessagingServiceSid = useEnvFallbacks ? process.env.TWILIO_RCS_MESSAGING_SERVICE_SID : void 0;
	const envWebhookPath = useEnvFallbacks ? process.env.RCS_WEBHOOK_PATH : void 0;
	const envPublicWebhookUrl = useEnvFallbacks ? process.env.RCS_PUBLIC_WEBHOOK_URL : void 0;
	const envAllowFrom = useEnvFallbacks ? process.env.RCS_ALLOWED_USERS : void 0;
	const webhookPath = (merged.webhookPath ?? envWebhookPath ?? DEFAULT_WEBHOOK_PATH).trim();
	const publicWebhookUrl = (merged.publicWebhookUrl ?? envPublicWebhookUrl ?? "").trim();
	const authToken = normalizeResolvedSecretInputString({
		value: merged.authToken ?? envAuthToken,
		path: id === DEFAULT_ACCOUNT_ID$1 ? "channels.rcs.authToken" : `channels.rcs.accounts.${id}.authToken`
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
		allowFrom: parseList(merged.allowFrom ?? envAllowFrom)
	};
}
function inspectRcsAccount(cfg, accountId) {
	const account = resolveRcsAccount(cfg, accountId);
	const configured = isRcsAccountConfigured(account);
	const publicWebhookUrlConfigured = Boolean(parseRcsPublicWebhookUrl(account.publicWebhookUrl));
	return {
		enabled: account.enabled,
		configured,
		tokenStatus: account.authToken ? "available" : "missing",
		webhookPath: account.webhookPath,
		signatureValidation: account.dangerouslyDisableSignatureValidation || publicWebhookUrlConfigured ? "configured" : "missing-public-url"
	};
}
function isRcsAccountConfigured(account) {
	return Boolean(account.accountSid && account.authToken && account.messagingServiceSid && parseRcsPublicWebhookUrl(account.publicWebhookUrl));
}
//#endregion
//#region extensions/rcs/src/config-schema.ts
const SecretInputSchema = buildSecretInputSchema();
const RcsChannelConfigSchema = buildChannelConfigSchema(buildMultiAccountChannelSchema(z.object({
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
	allowFrom: AllowFromListSchema
}).strict(), {
	optionalAccount: true,
	refine: (value, ctx) => {
		requireChannelOpenAllowFrom({
			channel: "rcs",
			policy: value.dmPolicy,
			allowFrom: value.allowFrom,
			ctx,
			requireOpenAllowFrom
		});
	}
}), { uiHints: {
	"": {
		label: "RCS",
		help: "Twilio RCS Business Messaging channel configuration for RCS-only inbound and outbound messaging."
	},
	accountSid: {
		label: "Twilio Account SID",
		help: "Twilio Account SID used for RCS outbound API calls."
	},
	authToken: {
		label: "Twilio Auth Token",
		help: "Twilio Auth Token used to sign webhook validation and RCS outbound API calls."
	},
	messagingServiceSid: {
		label: "Twilio Messaging Service SID",
		help: "Messaging Service whose sender pool contains the approved RCS Sender."
	},
	publicWebhookUrl: {
		label: "RCS Public Webhook URL",
		help: "Public URL configured in Twilio for incoming messages. Must match Twilio's signed URL exactly."
	},
	webhookPath: {
		label: "RCS Webhook Path",
		help: "Gateway HTTP path that receives Twilio incoming-message webhooks. Use a distinct path per account."
	},
	dmPolicy: {
		label: "RCS DM Policy",
		help: "Direct RCS access control (\"pairing\" recommended). \"open\" requires channels.rcs.allowFrom=[\"*\"]."
	},
	allowFrom: {
		label: "RCS Allow From",
		help: "Allowed sender phone numbers in E.164 format, or * when dmPolicy is open."
	}
} });
//#endregion
//#region extensions/rcs/src/delivery-observations.ts
const NAMESPACE = "twilio-rcs-delivery-observations-v1";
const RETENTION_MS = 720 * 60 * 60 * 1e3;
const MAX_MESSAGES = 5e3;
const RANK = {
	accepted: 10,
	scheduled: 20,
	queued: 30,
	sending: 40,
	sent: 50,
	delivered: 60,
	read: 70
};
const FAILURES = /* @__PURE__ */ new Set([
	"undelivered",
	"failed",
	"canceled"
]);
const INBOUND = /* @__PURE__ */ new Set(["receiving", "received"]);
let cachedStore;
let cachedRuntime;
function trimmed(form, key) {
	return form[key]?.trim() ?? "";
}
function messageSid(form) {
	return trimmed(form, "MessageSid") || trimmed(form, "SmsSid") || trimmed(form, "SmsMessageSid");
}
function normalizeStatus(status) {
	const normalized = status.trim().toLowerCase();
	return INBOUND.has(normalized) ? "" : normalized;
}
function callbackStatus(form) {
	return trimmed(form, "EventType").toUpperCase() === "READ" ? "read" : normalizeStatus(trimmed(form, "MessageStatus") || trimmed(form, "SmsStatus"));
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
function recordKey(account, sid) {
	return sha256(account.accountId + "\n" + sha256(account.accountSid) + "\n" + sid);
}
function observationFingerprint(observation) {
	return sha256(JSON.stringify([
		observation.source,
		observation.messageSid,
		observation.status,
		observation.errorCode ?? ""
	]));
}
function openStore() {
	const runtime = getRcsRuntime();
	if (!cachedStore || cachedRuntime !== runtime) {
		cachedRuntime = runtime;
		cachedStore = runtime.state.openKeyedStore({
			namespace: NAMESPACE,
			maxEntries: MAX_MESSAGES,
			overflowPolicy: "evict-oldest",
			defaultTtlMs: RETENTION_MS
		});
	}
	return cachedStore;
}
function isTwilioRcsDeliveryStatusForm(form) {
	return Boolean(callbackStatus(form));
}
function reducedStatus(current, next) {
	if (!current) return {
		status: next.status,
		...next.errorCode ? { errorCode: next.errorCode } : {}
	};
	if (current.status === "conflicted") return {
		status: current.status,
		...current.errorCode ? { errorCode: current.errorCode } : {},
		conflict: true
	};
	if (current.status === next.status) {
		const errorCode = current.errorCode ?? next.errorCode;
		return {
			status: current.status,
			...errorCode ? { errorCode } : {}
		};
	}
	const currentFailure = FAILURES.has(current.status);
	const nextFailure = FAILURES.has(next.status);
	const currentDelivered = current.status === "delivered" || current.status === "read";
	const nextDelivered = next.status === "delivered" || next.status === "read";
	if (currentFailure && (nextFailure || nextDelivered) || currentDelivered && nextFailure) {
		const errorCode = next.errorCode ?? current.errorCode;
		return {
			status: "conflicted",
			...errorCode ? { errorCode } : {},
			conflict: true
		};
	}
	if (currentFailure || current.status === "read") return {
		status: current.status,
		...current.errorCode ? { errorCode: current.errorCode } : {}
	};
	if (nextFailure || (RANK[next.status] ?? -1) > (RANK[current.status] ?? -1)) return {
		status: next.status,
		...next.errorCode ? { errorCode: next.errorCode } : {}
	};
	return {
		status: current.status,
		...current.errorCode ? { errorCode: current.errorCode } : {}
	};
}
function mergeRecord(params) {
	if (params.current?.observations.some((existing) => existing.fingerprint === params.observation.fingerprint)) return;
	const reduced = reducedStatus(params.current, params.observation);
	return {
		accountId: params.account.accountId,
		accountSidHash: sha256(params.account.accountSid),
		messageSid: params.messageSid,
		status: reduced.status,
		firstObservedAt: params.current?.firstObservedAt ?? params.observation.observedAt,
		lastObservedAt: params.observation.observedAt,
		...reduced.errorCode ? { errorCode: reduced.errorCode } : {},
		...reduced.conflict ? { conflict: true } : {},
		observations: [...params.current?.observations ?? [], params.observation].slice(-20)
	};
}
async function persist(params) {
	if (!params.store.update) throw new Error("RCS delivery observations require atomic plugin state updates.");
	let record;
	let duplicate = false;
	let unknown = false;
	await params.store.update(recordKey(params.account, params.messageSid), (current) => {
		if (!current && params.requireExisting) {
			unknown = true;
			return;
		}
		const next = mergeRecord({
			...params,
			current
		});
		if (!next) {
			duplicate = true;
			record = current;
			return;
		}
		record = next;
		return next;
	});
	if (unknown) return { kind: "unknown-message" };
	if (!record) throw new Error("RCS delivery observation was not persisted.");
	return {
		kind: "recorded",
		duplicate,
		record
	};
}
function createRcsDeliveryRecorder(store = openStore()) {
	return { async record({ account, form }) {
		const sid = messageSid(form);
		const status = callbackStatus(form);
		if (!sid || !status) throw new Error("Invalid Twilio RCS delivery status callback.");
		const errorCode = trimmed(form, "ErrorCode");
		return await persist({
			account,
			messageSid: sid,
			observation: {
				source: "callback",
				fingerprint: observationFingerprint({
					source: "callback",
					messageSid: sid,
					status,
					...errorCode ? { errorCode } : {}
				}),
				status,
				observedAt: Date.now(),
				...errorCode ? { errorCode } : {}
			},
			store,
			requireExisting: true
		});
	} };
}
async function recordInitialRcsDeliveryResult(params) {
	const sid = params.result.sid.trim();
	if (!sid) throw new Error("RCS delivery registration requires a Message SID.");
	const status = normalizeStatus(params.result.status ?? "") || "accepted";
	const result = await persist({
		account: params.account,
		messageSid: sid,
		observation: {
			source: "api-response",
			fingerprint: observationFingerprint({
				source: "api-response",
				messageSid: sid,
				status
			}),
			status,
			observedAt: params.nowMs ?? Date.now()
		},
		store: params.store ?? openStore(),
		requireExisting: false
	});
	if (result.kind !== "recorded") throw new Error("RCS delivery result was not registered.");
	return result.record;
}
async function listRecentRcsDeliveryRecords(account, limit = 1, store = openStore()) {
	if (limit <= 0) return [];
	const accountSidHash = sha256(account.accountSid);
	return (await store.entries()).map((entry) => entry.value).filter((record) => record.accountId === account.accountId && record.accountSidHash === accountSidHash).toSorted((left, right) => right.lastObservedAt - left.lastObservedAt).slice(0, limit);
}
//#endregion
//#region extensions/rcs/src/twilio-api.ts
const TWILIO_API_TIMEOUT_MS = 3e4;
const TWILIO_API_SUCCESS_BODY_LIMIT_BYTES = 1 * 1024 * 1024;
const TWILIO_API_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const TRUNCATED_RESPONSE_SUFFIX = "... [truncated]";
function parseTwilioApiError(text) {
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object") return {};
		const record = parsed;
		return {
			code: typeof record.code === "number" ? record.code : void 0,
			message: typeof record.message === "string" ? record.message : void 0
		};
	} catch {
		return {};
	}
}
var TwilioRcsApiError = class extends Error {
	constructor(httpStatus, responseText, operation = "send") {
		const parsed = parseTwilioApiError(responseText);
		const detail = parsed.message ?? (responseText || "unknown");
		super(`Twilio RCS ${operation} failed (${httpStatus}): ${detail}`);
		this.name = "TwilioRcsApiError";
		this.httpStatus = httpStatus;
		this.responseText = responseText;
		this.twilioCode = parsed.code;
	}
};
function basicAuthHeader(account) {
	return `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64")}`;
}
function redactTwilioResponseText(text, account) {
	let redacted = redactSensitiveText(text, { mode: "tools" });
	for (const secret of [
		basicAuthHeader(account),
		`${account.accountSid}:${account.authToken}`,
		account.authToken
	]) if (secret) redacted = redacted.split(secret).join("[REDACTED]");
	return redacted;
}
async function toTwilioApiResponse(response, account) {
	const text = await readTwilioApiResponseText(response);
	return {
		ok: response.ok,
		status: response.status,
		text: response.ok ? text : redactTwilioResponseText(text, account)
	};
}
function appendTruncatedResponseSuffix(text) {
	return `${text.trimEnd()}${TRUNCATED_RESPONSE_SUFFIX}`;
}
async function readTwilioApiResponseText(response) {
	if (!response.body) return "";
	const maxBytes = response.ok ? TWILIO_API_SUCCESS_BODY_LIMIT_BYTES : TWILIO_API_ERROR_BODY_LIMIT_BYTES;
	const truncateOnLimit = !response.ok;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return text + decoder.decode();
			if (!value?.byteLength) continue;
			const remainingBytes = maxBytes - totalBytes;
			if (value.byteLength > remainingBytes) {
				const clipped = remainingBytes > 0 ? value.slice(0, remainingBytes) : void 0;
				if (truncateOnLimit) {
					if (clipped) text += decoder.decode(clipped, { stream: true });
					await reader.cancel().catch(() => void 0);
					return appendTruncatedResponseSuffix(text + decoder.decode());
				}
				await reader.cancel().catch(() => void 0);
				throw new Error(`Twilio RCS API response body too large: ${totalBytes + value.byteLength} bytes (limit: ${maxBytes} bytes)`);
			}
			text += decoder.decode(value, { stream: true });
			totalBytes += value.byteLength;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {}
	}
}
function normalizeRequestHeaders(headers) {
	if (!headers) return {};
	if (headers instanceof Headers) return Object.fromEntries(headers.entries());
	if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
	return Object.fromEntries(Object.entries(headers));
}
async function requestTwilioApi(params) {
	const init = {
		...params.init,
		headers: {
			...normalizeRequestHeaders(params.init?.headers),
			authorization: basicAuthHeader(params.account)
		}
	};
	if (params.fetchImpl) return await toTwilioApiResponse(await params.fetchImpl(params.url, init), params.account);
	const guarded = await fetchWithSsrFGuard({
		url: params.url,
		init,
		auditContext: "rcs-twilio-api",
		policy: { allowedHostnames: [params.allowedHostname] },
		requireHttps: true,
		timeoutMs: params.timeoutMs ?? TWILIO_API_TIMEOUT_MS
	});
	try {
		return await toTwilioApiResponse(guarded.response, params.account);
	} finally {
		await guarded.release();
	}
}
//#endregion
//#region extensions/rcs/src/twilio.ts
const TWILIO_ACCOUNTS_URL = "https://api.twilio.com/2010-04-01/Accounts";
const TWILIO_MESSAGING_URL = "https://messaging.twilio.com/v1";
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MESSAGING_HOSTNAME = "messaging.twilio.com";
const WEBHOOK_BODY_LIMIT_BYTES = 32 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5e3;
const MAX_INBOUND_MEDIA = 10;
function firstString(value) {
	if (Array.isArray(value)) return firstString(value[0]);
	return typeof value === "string" ? value : "";
}
function firstTrimmedString(value) {
	return firstString(value).trim();
}
function parseTwilioSuccessPayload(text) {
	if (!text.trim()) return {};
	try {
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Twilio RCS send returned malformed JSON.");
		const record = parsed;
		return {
			sid: typeof record.sid === "string" ? record.sid : void 0,
			to: typeof record.to === "string" ? record.to : void 0,
			from: typeof record.from === "string" ? record.from : void 0,
			status: typeof record.status === "string" ? record.status : void 0
		};
	} catch (cause) {
		if (cause instanceof Error && cause.message === "Twilio RCS send returned malformed JSON.") throw cause;
		throw new Error("Twilio RCS send returned malformed JSON.", { cause });
	}
}
function requestSearch(req) {
	try {
		return new URL(req.url ?? "/", "http://localhost").search;
	} catch {
		return "";
	}
}
function resolveTwilioWebhookSignatureUrl(params) {
	const hashIndex = params.publicWebhookUrl.indexOf("#");
	const signatureBaseUrl = hashIndex === -1 ? params.publicWebhookUrl : params.publicWebhookUrl.slice(0, hashIndex);
	if (signatureBaseUrl.includes("?")) return signatureBaseUrl;
	const search = requestSearch(params.req);
	return search ? `${signatureBaseUrl}${search}` : signatureBaseUrl;
}
function parseTwilioFormBody(body) {
	const parsed = querystring.parse(body);
	const out = {};
	for (const [key, value] of Object.entries(parsed)) out[key] = firstString(value);
	return out;
}
function computeTwilioSignature(params) {
	const data = params.url + Object.keys(params.form).toSorted().map((key) => `${key}${params.form[key] ?? ""}`).join("");
	return createHmac("sha1", params.authToken).update(data).digest("base64");
}
function verifyTwilioSignature(params) {
	if (!params.signature || !params.url || !params.authToken) return false;
	return safeEqualSecret(params.signature, computeTwilioSignature({
		url: params.url,
		authToken: params.authToken,
		form: params.form
	}));
}
function collectInboundMedia(form) {
	const declaredCount = Number.parseInt(form.NumMedia ?? "0", 10);
	if (!Number.isSafeInteger(declaredCount) || declaredCount <= 0) return {
		media: [],
		unavailableMediaCount: 0
	};
	const count = Math.min(declaredCount, MAX_INBOUND_MEDIA);
	const media = [];
	for (let index = 0; index < count; index += 1) {
		const url = firstTrimmedString(form[`MediaUrl${index}`]);
		if (!url) continue;
		const contentType = firstTrimmedString(form[`MediaContentType${index}`]);
		media.push({
			url,
			...contentType ? { contentType } : {}
		});
	}
	return {
		media,
		unavailableMediaCount: Math.max(0, declaredCount - media.length)
	};
}
function buildTwilioInboundMessage(form) {
	const accountSid = firstTrimmedString(form.AccountSid);
	const from = firstTrimmedString(form.From);
	const to = firstTrimmedString(form.To);
	const body = firstString(form.Body);
	const messageSid = firstTrimmedString(form.MessageSid) || firstTrimmedString(form.SmsSid) || firstTrimmedString(form.SmsMessageSid);
	const { media, unavailableMediaCount } = collectInboundMedia(form);
	if (!accountSid || !from || !to || !isRcsWireAddress(from) || !isRcsWireAddress(to) || !messageSid || !body && media.length === 0 && unavailableMediaCount === 0) return null;
	return {
		accountSid,
		from,
		to,
		body,
		messageSid,
		media,
		...unavailableMediaCount > 0 ? { unavailableMediaCount } : {},
		...firstTrimmedString(form.MessagingServiceSid) ? { messagingServiceSid: firstTrimmedString(form.MessagingServiceSid) } : {}
	};
}
async function readTwilioWebhookForm(req) {
	return parseTwilioFormBody(await readRequestBodyWithLimit(req, {
		maxBytes: WEBHOOK_BODY_LIMIT_BYTES,
		timeoutMs: WEBHOOK_BODY_TIMEOUT_MS
	}));
}
function respondTwiml(res, statusCode, body = "") {
	res.statusCode = statusCode;
	res.setHeader("content-type", "text/xml; charset=utf-8");
	res.end(body || "<Response></Response>");
}
function twilioApiUrl(accountSid, path) {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return new URL(`${TWILIO_ACCOUNTS_URL}/${encodeURIComponent(accountSid)}${normalizedPath}`).toString();
}
function twilioMessagingUrl(path) {
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return new URL(`${TWILIO_MESSAGING_URL}${normalizedPath}`).toString();
}
function parseTwilioMessagingService(record) {
	return {
		sid: firstTrimmedString(record.sid),
		inboundRequestUrl: firstTrimmedString(record.inbound_request_url ?? record.inboundRequestUrl),
		inboundMethod: firstTrimmedString(record.inbound_method ?? record.inboundMethod),
		useInboundWebhookOnNumber: Boolean(record.use_inbound_webhook_on_number ?? record.useInboundWebhookOnNumber)
	};
}
async function retrieveTwilioMessagingService(params) {
	const response = await requestTwilioApi({
		account: params.account,
		url: twilioMessagingUrl(`/Services/${encodeURIComponent(params.serviceSid)}`),
		allowedHostname: TWILIO_MESSAGING_HOSTNAME,
		fetchImpl: params.fetchImpl,
		timeoutMs: params.timeoutMs
	});
	if (!response.ok) throw new TwilioRcsApiError(response.status, response.text, "messaging-service lookup");
	let parsed;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Twilio Messaging Service lookup returned malformed JSON.");
	return parseTwilioMessagingService(parsed);
}
async function sendRcsViaTwilio(params) {
	if (!params.account.messagingServiceSid) throw new Error("Twilio RCS send requires messagingServiceSid.");
	if (!params.text && !(params.mediaUrls && params.mediaUrls.length)) throw new Error("Twilio RCS send requires text or media.");
	const statusCallback = resolveRcsStatusCallbackUrl(params.account.publicWebhookUrl);
	if (!statusCallback) throw new Error("Twilio RCS send requires a valid publicWebhookUrl for status callbacks.");
	const wireTo = toRcsWireAddress(params.to);
	const body = new URLSearchParams({
		To: wireTo,
		MessagingServiceSid: params.account.messagingServiceSid,
		StatusCallback: statusCallback
	});
	if (params.text) body.set("Body", params.text);
	for (const mediaUrl of params.mediaUrls ?? []) body.append("MediaUrl", mediaUrl);
	await params.onPlatformSendDispatch?.();
	const response = await requestTwilioApi({
		account: params.account,
		url: twilioApiUrl(params.account.accountSid, "/Messages.json"),
		allowedHostname: TWILIO_API_HOSTNAME,
		init: {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body
		},
		fetchImpl: params.fetchImpl
	});
	if (!response.ok) throw new TwilioRcsApiError(response.status, response.text);
	const payload = parseTwilioSuccessPayload(response.text);
	const sid = payload.sid?.trim();
	if (!sid) throw new Error("Twilio RCS send response did not include a Message SID.");
	return {
		sid,
		to: payload.to?.trim() || wireTo,
		...payload.from?.trim() ? { from: payload.from.trim() } : {},
		...payload.status?.trim() ? { status: payload.status.trim() } : {}
	};
}
//#endregion
//#region extensions/rcs/src/send.ts
const RCS_TEXT_CHUNK_LIMIT = 1600;
function createRcsChannelSendResult(params) {
	const first = params.results[0];
	if (!first) throw new Error("RCS send did not return a Twilio Message SID.");
	return {
		channel: "rcs",
		messageId: first.sid,
		chatId: first.to,
		receipt: createMessageReceiptFromOutboundResults({
			results: params.results.map((result) => ({
				channel: "rcs",
				messageId: result.sid,
				chatId: result.to,
				toJid: result.to,
				conversationId: result.to,
				meta: {
					...result.from ? { from: result.from } : {},
					...result.status ? { status: result.status } : {}
				}
			})),
			threadId: first.to,
			kind: params.kind
		})
	};
}
function throwRcsPartialDeliveryError(error, results, kind) {
	if (results.length === 0) throw error;
	const completed = createRcsChannelSendResult({
		results,
		kind
	});
	throw createChannelPartialDeliveryError(error, {
		messageIds: results.map((result) => result.sid),
		receipt: completed.receipt,
		visibleReplySent: true
	});
}
async function recordInitialDeliveryBestEffort(account, result) {
	try {
		await recordInitialRcsDeliveryResult({
			account,
			result
		});
	} catch (error) {
		try {
			getRcsRuntime().logging.getChildLogger({
				plugin: "rcs",
				feature: "delivery-status"
			}).warn("RCS delivery initial state could not be persisted.", {
				messageSid: result.sid,
				errorType: error instanceof Error ? error.name : typeof error
			});
		} catch {}
	}
}
async function sendRcsProviderMessage(params) {
	let platformDispatchStarted = false;
	let result;
	try {
		result = await sendRcsViaTwilio({
			account: params.account,
			to: params.to,
			...params.text !== void 0 ? { text: params.text } : {},
			...params.mediaUrls !== void 0 ? { mediaUrls: params.mediaUrls } : {},
			onPlatformSendDispatch: async () => {
				await params.onPlatformSendDispatch?.();
				platformDispatchStarted = true;
			}
		});
	} catch (error) {
		if (platformDispatchStarted || error instanceof PlatformMessageNotDispatchedError) throw error;
		throw new PlatformMessageNotDispatchedError(`RCS send failed before Twilio dispatch: ${formatErrorMessage(error)}`, { cause: error });
	}
	await recordInitialDeliveryBestEffort(params.account, result);
	return result;
}
function toRcsPlainText(text) {
	return stripMarkdown(sanitizeAssistantVisibleText(text).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, body) => body.trim()).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
		const cleanLabel = label.trim();
		const cleanUrl = url.trim();
		return cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel} (${cleanUrl})` : cleanUrl;
	})).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
async function sendRcsTextChunks(params) {
	const text = toRcsPlainText(params.text);
	if (!text) throw new Error("RCS send requires non-empty text.");
	const chunks = chunkTextForOutbound(text, RCS_TEXT_CHUNK_LIMIT).filter(Boolean);
	const sendChunks = chunks.length ? chunks : [text];
	const results = [];
	try {
		for (const textLocal of sendChunks) {
			const result = await sendRcsProviderMessage({
				account: params.account,
				to: params.to,
				text: textLocal,
				onPlatformSendDispatch: params.onPlatformSendDispatch
			});
			results.push(result);
			await params.onDeliveryResult?.(createRcsChannelSendResult({
				results: [result],
				kind: "text"
			}));
		}
	} catch (error) {
		throwRcsPartialDeliveryError(error, results, "text");
	}
	return results;
}
async function sendRcsMedia(params) {
	const remote = params.mediaUrls.filter((url) => /^https?:\/\//i.test(url));
	if (!remote.length) throw new Error("RCS outbound media requires publicly reachable http(s) URLs; local file hosting is not supported yet.");
	const text = params.text ? toRcsPlainText(params.text) : "";
	const results = [];
	try {
		const result = await sendRcsProviderMessage({
			account: params.account,
			to: params.to,
			...text ? { text } : {},
			mediaUrls: remote,
			onPlatformSendDispatch: params.onPlatformSendDispatch
		});
		results.push(result);
		await params.onDeliveryResult?.(createRcsChannelSendResult({
			results: [result],
			kind: "media"
		}));
	} catch (error) {
		throwRcsPartialDeliveryError(error, results, "media");
	}
	return results;
}
//#endregion
//#region extensions/rcs/src/inbound.ts
const CHANNEL_ID$2 = "rcs";
async function authorizeRcsSender(params) {
	const commandRequested = params.channelRuntime.commands.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	return await resolveStableChannelMessageIngress({
		channelId: CHANNEL_ID$2,
		accountId: params.account.accountId,
		cfg: params.cfg,
		identity: {
			key: "phone",
			entryIdPrefix: "rcs-entry"
		},
		readStoreAllowFrom: async () => await params.channelRuntime.pairing.readAllowFromStore({
			channel: CHANNEL_ID$2,
			accountId: params.account.accountId
		}),
		subject: { stableId: params.from },
		conversation: {
			kind: "direct",
			id: params.from
		},
		contextBinding: params.contextBinding,
		event: { mayPair: true },
		dmPolicy: params.account.dmPolicy,
		allowFrom: params.account.allowFrom,
		command: commandRequested ? {
			cfg: params.cfg,
			modeWhenAccessGroupsOff: "configured"
		} : void 0
	});
}
async function issueRcsPairingChallenge(params) {
	await createChannelPairingChallengeIssuer({
		channel: CHANNEL_ID$2,
		accountId: params.account.accountId,
		upsertPairingRequest: async (input) => await params.channelRuntime.pairing.upsertPairingRequest({
			channel: CHANNEL_ID$2,
			accountId: params.account.accountId,
			...input
		})
	})({
		senderId: params.from,
		senderIdLine: `Your RCS phone number: ${params.from}`,
		sendPairingReply: async (text) => {
			await sendRcsTextChunks({
				account: params.account,
				to: params.from,
				text
			});
		},
		onCreated: () => params.log?.info?.("RCS pairing request created"),
		onReplyError: () => params.log?.warn?.("RCS pairing reply failed")
	});
}
async function dispatchRcsInboundEvent(params) {
	const from = normalizeRcsIdentity(params.msg.from);
	let auth = await authorizeRcsSender({
		cfg: params.cfg,
		account: params.account,
		channelRuntime: params.channelRuntime,
		from,
		rawBody: params.msg.body
	});
	if (!auth.senderAccess.allowed) {
		if (auth.senderAccess.decision === "pairing") {
			await issueRcsPairingChallenge({
				account: params.account,
				channelRuntime: params.channelRuntime,
				from,
				log: params.log
			});
			return;
		}
		params.log?.warn?.("RCS sender is not authorized");
		return;
	}
	const materialized = params.msg.media.length > 0 || (params.msg.unavailableMediaCount ?? 0) > 0 ? await (await import("./media-B9iXlnAD.js")).materializeRcsInboundMedia({
		account: params.account,
		msg: params.msg,
		mediaRuntime: params.channelRuntime,
		abortSignal: params.turnAdoptionLifecycle?.abortSignal,
		log: params.log
	}) : {
		body: params.msg.body,
		media: [],
		cleanup: async () => void 0
	};
	let adoptionState = "pending";
	try {
		const turnAdoptionLifecycle = materialized.media.length > 0 && params.turnAdoptionLifecycle ? {
			...params.turnAdoptionLifecycle,
			onAdopted: async () => {
				try {
					await params.turnAdoptionLifecycle?.onAdopted();
					adoptionState = "adopted";
				} catch (error) {
					await materialized.cleanup();
					throw error;
				}
			},
			onDeferred: () => {
				const deferred = params.turnAdoptionLifecycle?.onDeferred?.();
				if (deferred !== false) adoptionState = "deferred";
				return deferred;
			},
			onAbandoned: () => {
				adoptionState = "abandoned";
				materialized.cleanup().then(() => params.turnAdoptionLifecycle?.onAbandoned?.()).catch(() => params.log?.warn?.("Failed to abandon Twilio RCS ingress media"));
			}
		} : params.turnAdoptionLifecycle;
		const route = params.channelRuntime.routing.resolveAgentRoute({
			cfg: params.cfg,
			channel: CHANNEL_ID$2,
			accountId: params.account.accountId,
			peer: {
				kind: "direct",
				id: from
			}
		});
		const sessionKey = route.sessionKey;
		auth = await authorizeRcsSender({
			cfg: params.cfg,
			account: params.account,
			channelRuntime: params.channelRuntime,
			from,
			rawBody: params.msg.body,
			contextBinding: {
				agentId: route.agentId,
				sessionKey,
				messageId: params.msg.messageSid,
				inboundEventKind: "user_request"
			}
		});
		if (!auth.senderAccess.allowed) {
			params.log?.warn?.("RCS sender authorization changed before dispatch");
			return;
		}
		const commandRequested = auth.commandAccess.requested;
		const commandAuthorized = auth.commandAccess.authorized;
		const isTextCommand = params.channelRuntime.commands.isControlCommandMessage(params.msg.body, params.cfg);
		await params.channelRuntime.inbound.run({
			channel: CHANNEL_ID$2,
			accountId: params.account.accountId,
			raw: params.msg,
			...turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {},
			adapter: {
				ingest: (msg) => ({
					id: msg.messageSid,
					timestamp: params.receivedAt,
					rawText: msg.body,
					textForAgent: materialized.body,
					textForCommands: msg.body,
					raw: msg
				}),
				resolveTurn: async (input) => {
					const ctxPayload = params.channelRuntime.inbound.buildContext({
						channelIngress: auth,
						channel: CHANNEL_ID$2,
						accountId: params.account.accountId,
						messageId: input.id,
						timestamp: input.timestamp,
						from: `rcs:${from}`,
						sender: {
							id: from,
							name: from
						},
						conversation: {
							kind: "direct",
							id: from,
							label: from
						},
						route: {
							agentId: route.agentId,
							accountId: params.account.accountId,
							routeSessionKey: sessionKey,
							dispatchSessionKey: sessionKey
						},
						reply: { to: `rcs:${from}` },
						message: {
							rawBody: input.rawText,
							commandBody: input.textForCommands,
							bodyForAgent: input.textForAgent
						},
						media: materialized.media,
						access: commandRequested ? { commands: { authorized: commandAuthorized } } : void 0,
						command: isTextCommand ? {
							kind: "text-slash",
							body: input.textForCommands,
							authorized: commandAuthorized
						} : void 0,
						extra: {
							MessageSid: params.msg.messageSid,
							SenderE164: from,
							To: params.msg.to
						}
					});
					return {
						cfg: params.cfg,
						channel: CHANNEL_ID$2,
						accountId: params.account.accountId,
						route: {
							agentId: route.agentId,
							sessionKey
						},
						ctxPayload,
						delivery: {
							durable: () => ({ to: from }),
							deliver: async (payload) => {
								if (!payload.text) return { visibleReplySent: false };
								await sendRcsTextChunks({
									account: params.account,
									to: from,
									text: payload.text
								});
								return { visibleReplySent: true };
							}
						},
						dispatcherOptions: { onReplyStart: () => params.log?.info?.("RCS reply started") }
					};
				}
			}
		});
		if (adoptionState === "pending" || adoptionState === "abandoned") await materialized.cleanup();
	} catch (error) {
		if (adoptionState === "pending" || adoptionState === "abandoned") await materialized.cleanup();
		throw error;
	}
}
//#endregion
//#region extensions/rcs/src/ingress-spool.ts
const RCS_INGRESS_PAYLOAD_VERSION = 1;
const RCS_INGRESS_DRAIN_INTERVAL_MS = 500;
const RCS_COMPLETED_TTL_MS = 1440 * 60 * 1e3;
const RCS_COMPLETED_MAX_ENTRIES = 2e4;
const RCS_FAILED_TTL_MS = 720 * 60 * 60 * 1e3;
const RCS_FAILED_MAX_ENTRIES = 1e3;
var RcsIngressPermanentError = class extends Error {};
function resolveTwilioMessageSid(form) {
	return (form.MessageSid || form.SmsSid || form.SmsMessageSid || "").trim();
}
function parseRcsIngressForm(form, account) {
	const message = buildTwilioInboundMessage(form);
	if (!message) throw new RcsIngressPermanentError("RCS ingress payload is invalid.");
	if (message.accountSid !== account.accountSid) throw new RcsIngressPermanentError("RCS ingress payload has an invalid Twilio account.");
	if (message.messagingServiceSid !== account.messagingServiceSid) throw new RcsIngressPermanentError("RCS ingress payload has an invalid Messaging Service.");
	return message;
}
function createRcsIngressSpool(params) {
	const queue = params.queue ?? getRcsRuntime().state.openChannelIngressQueue({ accountId: params.account.accountId });
	const deliver = params.deliver ?? (async (message, lifecycle, receivedAt) => {
		await dispatchRcsInboundEvent({
			cfg: params.cfg,
			account: params.account,
			channelRuntime: params.channelRuntime,
			msg: message,
			receivedAt,
			turnAdoptionLifecycle: lifecycle,
			log: params.log
		});
	});
	const monitor = createChannelIngressMonitor({
		queue,
		inspect: (form, context) => {
			const eventId = resolveTwilioMessageSid(form);
			if (!eventId) {
				if (context.phase === "claim") throw new RcsIngressPermanentError("RCS ingress payload is invalid.");
				throw new Error("RCS webhook is missing MessageSid.");
			}
			const sender = normalizeRcsIdentity(form.From ?? "");
			return {
				eventId,
				laneKey: sender ? `sender:${sender}` : `event:${eventId}`
			};
		},
		payload: {
			version: RCS_INGRESS_PAYLOAD_VERSION,
			serialize: (form) => form,
			deserialize: (form) => form,
			encode: ({ body }) => ({
				version: RCS_INGRESS_PAYLOAD_VERSION,
				form: body
			}),
			decode: (payload) => ({
				version: payload.version,
				body: payload.form
			}),
			createClaimError: (kind) => new RcsIngressPermanentError(kind === "invalid-version" ? "RCS ingress payload version is invalid." : "RCS ingress identity changed after durable admission.")
		},
		deliver: (_form, lifecycle, event) => runDetachedWebhookWork(() => deliver(parseRcsIngressForm(event.payload.form, params.account), bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle, event.receivedAt)),
		pollIntervalMs: RCS_INGRESS_DRAIN_INTERVAL_MS,
		retention: {
			pruneIntervalMs: 0,
			completedTtlMs: RCS_COMPLETED_TTL_MS,
			completedMaxEntries: RCS_COMPLETED_MAX_ENTRIES,
			failedTtlMs: RCS_FAILED_TTL_MS,
			failedMaxEntries: RCS_FAILED_MAX_ENTRIES
		},
		appendRetryDelaysMs: [0],
		waitForDeliveryIdleBeforeRepump: false,
		waitForDeliveryIdleOnStop: false,
		runPumpTask: runDetachedWebhookWork,
		admissionMode: "durable-after-stop",
		drain: {
			onLog: (message) => params.log?.warn?.(message),
			resolveNonRetryableFailure: (error) => error instanceof RcsIngressPermanentError ? {
				reason: "invalid-payload",
				message: error.message
			} : null
		},
		...params.abortSignal ? { abortSignal: params.abortSignal } : {},
		createStoppedError: () => /* @__PURE__ */ new Error("RCS ingress stopped."),
		onError: (error) => params.log?.error?.(`RCS ingress drain failed: ${error instanceof Error ? error.message : String(error)}`)
	});
	return {
		enqueue: async (form) => {
			const admitted = await monitor.admit(form);
			if (admitted.kind === "ignored") throw new Error("RCS webhook admission was unexpectedly ignored.");
			return {
				kind: admitted.queueResult.kind,
				duplicate: admitted.queueResult.duplicate
			};
		},
		start: monitor.start,
		pause: monitor.pause,
		waitForIdle: monitor.waitForIdle,
		stop: monitor.stop
	};
}
//#endregion
//#region extensions/rcs/src/webhook.ts
const INVALID_REQUEST_MAX_REQUESTS = 300;
const INBOUND_DISPATCH_MAX_REQUESTS = 30;
const VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS = 300;
const DELIVERY_CALLBACK_MAX_REQUESTS = 3e3;
const DELIVERY_CALLBACK_WINDOW_MS = 6e4;
const RCS_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const RCS_WEBHOOK_ACCEPTED_VALUE = "durable";
const invalidRequestRateLimiter = createFixedWindowRateLimiter({
	maxRequests: INVALID_REQUEST_MAX_REQUESTS,
	windowMs: 6e4,
	maxTrackedKeys: 5e3
});
const inboundDispatchRateLimiter = createFixedWindowRateLimiter({
	maxRequests: INBOUND_DISPATCH_MAX_REQUESTS,
	windowMs: 6e4,
	maxTrackedKeys: 5e3
});
const validatedInboundAggregateRateLimiter = createFixedWindowRateLimiter({
	maxRequests: VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS,
	windowMs: 6e4,
	maxTrackedKeys: 1e3
});
function headerValue(value) {
	return Array.isArray(value) ? value[0] : value;
}
function resolvedClientAddress(params) {
	return resolveRequestClientIp(params.req, params.cfg.gateway?.trustedProxies, params.cfg.gateway?.allowRealIpFallback === true) ?? params.req.socket?.remoteAddress ?? "unknown";
}
function rateLimitKey(params) {
	return `${params.account.accountId}:${params.account.webhookPath}:${params.subject}`;
}
function accountRouteRateLimitKey(account) {
	return `${account.accountId}:${account.webhookPath}`;
}
function rejectInvalidRequestRateLimit(params) {
	params.log?.warn?.("RCS webhook invalid-request rate limit exceeded");
	respondTwiml(params.res, 429, "Rate limit exceeded");
	return true;
}
function createRcsWebhookHandler(params) {
	let deliveryRecorder = params.delivery;
	const deliveryCallbackRateLimiter = createFixedWindowRateLimiter({
		maxRequests: DELIVERY_CALLBACK_MAX_REQUESTS,
		windowMs: DELIVERY_CALLBACK_WINDOW_MS,
		maxTrackedKeys: 1
	});
	const deliveryCallbackKey = rateLimitKey({
		account: params.account,
		subject: "delivery-callbacks"
	});
	return async (req, res) => {
		if (req.method !== "POST") {
			respondTwiml(res, 405, "Method not allowed");
			return true;
		}
		const clientAddressKey = rateLimitKey({
			account: params.account,
			subject: resolvedClientAddress({
				cfg: params.cfg,
				req
			})
		});
		const invalidRequestRateLimited = invalidRequestRateLimiter.isRateLimited(clientAddressKey);
		let form;
		try {
			form = await readTwilioWebhookForm(req);
		} catch (error) {
			if (isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")) {
				respondTwiml(res, 413, "Payload too large");
				return true;
			}
			throw error;
		}
		if (!params.account.dangerouslyDisableSignatureValidation) {
			if (!verifyTwilioSignature({
				signature: headerValue(req.headers["x-twilio-signature"]),
				url: resolveTwilioWebhookSignatureUrl({
					req,
					publicWebhookUrl: params.account.publicWebhookUrl
				}),
				authToken: params.account.authToken,
				form
			})) {
				if (invalidRequestRateLimited) return rejectInvalidRequestRateLimit({
					log: params.log,
					res
				});
				params.log?.warn?.("RCS webhook rejected invalid Twilio signature");
				respondTwiml(res, 403, "Invalid signature");
				return true;
			}
		} else if (invalidRequestRateLimited) return rejectInvalidRequestRateLimit({
			log: params.log,
			res
		});
		if (!form.AccountSid || form.AccountSid !== params.account.accountSid) {
			params.log?.warn?.("RCS webhook rejected missing or mismatched Twilio AccountSid");
			respondTwiml(res, 403, "Invalid account");
			return true;
		}
		if (isTwilioRcsDeliveryStatusForm(form)) {
			if (deliveryCallbackRateLimiter.isRateLimited(deliveryCallbackKey)) {
				params.log?.warn?.("RCS delivery callback rate limit exceeded");
				respondTwiml(res, 503, "Service unavailable");
				return true;
			}
			deliveryRecorder ??= createRcsDeliveryRecorder();
			try {
				const verdict = await deliveryRecorder.record({
					account: params.account,
					form
				});
				if (verdict.kind === "unknown-message") {
					params.log?.warn?.("RCS delivery callback ignored unknown outbound MessageSid");
					respondTwiml(res, 200);
					return true;
				}
				params.log?.info?.(verdict.duplicate ? "RCS delivery callback ignored duplicate" : `RCS delivery observation ${verdict.record.status} recorded`);
				res.setHeader(RCS_WEBHOOK_ACCEPTED_HEADER, RCS_WEBHOOK_ACCEPTED_VALUE);
				respondTwiml(res, 200);
				return true;
			} catch (error) {
				params.log?.error?.(`RCS delivery callback persistence failed: ${error instanceof Error ? error.name : typeof error}`);
				respondTwiml(res, 503, "Service unavailable");
				return true;
			}
		}
		const message = buildTwilioInboundMessage(form);
		if (!message) {
			respondTwiml(res, 400, "Missing RCS payload");
			return true;
		}
		if (message.messagingServiceSid !== params.account.messagingServiceSid) {
			params.log?.warn?.("RCS webhook rejected missing or mismatched MessagingServiceSid");
			respondTwiml(res, 403, "Invalid Messaging Service");
			return true;
		}
		const dispatchKey = params.account.dangerouslyDisableSignatureValidation ? clientAddressKey : rateLimitKey({
			account: params.account,
			subject: normalizeRcsIdentity(message.from)
		});
		if (inboundDispatchRateLimiter.isRateLimited(dispatchKey)) {
			params.log?.warn?.("RCS webhook callback rate limit exceeded");
			respondTwiml(res, 429, "Rate limit exceeded");
			return true;
		}
		if (!params.account.dangerouslyDisableSignatureValidation) {
			const aggregateKey = accountRouteRateLimitKey(params.account);
			if (validatedInboundAggregateRateLimiter.isRateLimited(aggregateKey)) {
				params.log?.warn?.(`RCS webhook aggregate rate limit exceeded for ${aggregateKey}`);
				respondTwiml(res, 429, "Rate limit exceeded");
				return true;
			}
		}
		try {
			if ((await params.ingress.enqueue(form)).duplicate) params.log?.info?.("RCS webhook ignored replayed message");
			res.setHeader(RCS_WEBHOOK_ACCEPTED_HEADER, RCS_WEBHOOK_ACCEPTED_VALUE);
			respondTwiml(res, 200);
			return true;
		} catch (error) {
			params.log?.error?.(`RCS durable admission failed: ${error instanceof Error ? error.name : typeof error}`);
			respondTwiml(res, 503, "Service unavailable");
			return true;
		}
	};
}
//#endregion
//#region extensions/rcs/src/gateway.ts
const CHANNEL_ID$1 = "rcs";
const activeRoutes = /* @__PURE__ */ new Map();
const activeRoutePaths = /* @__PURE__ */ new Map();
const activeAccounts = /* @__PURE__ */ new Map();
const pendingAccountStops = /* @__PURE__ */ new Map();
function normalizeWebhookPath(path) {
	const trimmed = path.trim();
	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function collectRcsStartupWarnings(account) {
	const warnings = [];
	if (!account.accountSid || !account.authToken || !account.messagingServiceSid) warnings.push("- RCS: accountSid, authToken, and messagingServiceSid are required.");
	if (!account.dangerouslyDisableSignatureValidation && !parseRcsPublicWebhookUrl(account.publicWebhookUrl)) warnings.push("- RCS: a valid publicWebhookUrl is required for Twilio signature validation and status callbacks.");
	if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) warnings.push("- RCS: dmPolicy=allowlist with empty allowFrom rejects every sender.");
	if (account.dmPolicy === "open" && !account.allowFrom.includes("*")) warnings.push("- RCS: dmPolicy=open should set allowFrom=[\"*\"] or explicit sender numbers.");
	return warnings;
}
function canStartRcsAccount(account) {
	return Boolean(account.accountSid && account.authToken && account.messagingServiceSid && (account.dangerouslyDisableSignatureValidation || parseRcsPublicWebhookUrl(account.publicWebhookUrl)));
}
function registerRoute(params) {
	const key = `${params.accountId}:${params.path}`;
	const currentPathOwner = activeRoutePaths.get(params.path);
	if (currentPathOwner && currentPathOwner !== params.accountId) throw new Error(`RCS webhook path ${params.path} is already registered by account ${currentPathOwner}; configure a distinct webhookPath for account ${params.accountId}.`);
	activeRoutes.get(key)?.();
	activeRoutePaths.delete(params.path);
	const handle = registerPluginHttpRoute({
		path: params.path,
		auth: "plugin",
		throwOnFailure: true,
		pluginId: CHANNEL_ID$1,
		accountId: params.accountId,
		log: (msg) => params.log?.info?.(msg),
		handler: params.handler
	});
	activeRoutes.set(key, handle);
	activeRoutePaths.set(params.path, params.accountId);
	return () => {
		handle();
		activeRoutes.delete(key);
		if (activeRoutePaths.get(params.path) === params.accountId) activeRoutePaths.delete(params.path);
	};
}
function registerRcsWebhookRoutes(params) {
	return registerRoute({
		path: normalizeWebhookPath(params.account.webhookPath),
		accountId: params.account.accountId,
		handler: createRcsWebhookHandler(params),
		log: params.log
	});
}
function stopRcsWebhookAccount(accountId, active) {
	if (active.stopTask) return active.stopTask;
	const pauseTask = active.ingress.pause();
	active.unregisterRoutes();
	if (activeAccounts.get(accountId) === active) activeAccounts.delete(accountId);
	const previousStop = pendingAccountStops.get(accountId) ?? Promise.resolve();
	const stopTask = Promise.all([
		previousStop,
		active.ready,
		pauseTask
	]).then(() => active.ingress.stop(), async (error) => {
		await Promise.allSettled([active.ingress.stop()]);
		throw error;
	});
	active.stopTask = stopTask;
	pendingAccountStops.set(accountId, stopTask);
	const clear = () => {
		if (pendingAccountStops.get(accountId) === stopTask) pendingAccountStops.delete(accountId);
	};
	stopTask.then(clear, clear);
	return stopTask;
}
async function startRcsGatewayAccount(params) {
	params.statusSink?.({ lifecycle: "starting" });
	if (!params.account.enabled) {
		params.log?.info?.(`RCS account ${params.account.accountId} is disabled`);
		params.statusSink?.(channelStoppedPatch());
		return waitUntilAbort(params.abortSignal);
	}
	const warnings = collectRcsStartupWarnings(params.account);
	if (!canStartRcsAccount(params.account)) {
		for (const warning of warnings) params.log?.warn?.(warning);
		params.statusSink?.(channelBlockedPatch(warnings.join("; "), {
			running: true,
			connected: false
		}));
		return waitUntilAbort(params.abortSignal);
	}
	for (const warning of warnings) params.log?.warn?.(warning);
	const currentAccount = activeAccounts.get(params.account.accountId);
	const predecessorStop = currentAccount ? stopRcsWebhookAccount(params.account.accountId, currentAccount) : pendingAccountStops.get(params.account.accountId) ?? Promise.resolve();
	const ingress = createRcsIngressSpool({
		cfg: params.cfg,
		account: params.account,
		channelRuntime: params.channelRuntime,
		...params.log ? { log: params.log } : {}
	});
	let unregisterRoutes;
	try {
		unregisterRoutes = registerRcsWebhookRoutes({
			cfg: params.cfg,
			account: params.account,
			ingress,
			...params.log ? { log: params.log } : {}
		});
	} catch (error) {
		await Promise.allSettled([predecessorStop, ingress.stop()]);
		params.statusSink?.(channelBlockedPatch(`RCS webhook route registration failed: ${error instanceof Error ? error.message : String(error)}`, {
			running: false,
			connected: false
		}));
		throw error;
	}
	const active = {
		ingress,
		unregisterRoutes,
		ready: Promise.resolve()
	};
	activeAccounts.set(params.account.accountId, active);
	active.ready = predecessorStop.then(() => {
		if (activeAccounts.get(params.account.accountId) === active && !active.stopTask) ingress.start();
	});
	const stop = () => stopRcsWebhookAccount(params.account.accountId, active);
	const readinessAbort = new AbortController();
	const lifecycle = waitUntilAbort(AbortSignal.any([params.abortSignal, readinessAbort.signal]), stop);
	try {
		await active.ready;
	} catch (error) {
		readinessAbort.abort();
		await Promise.allSettled([lifecycle]);
		params.statusSink?.(channelStoppedPatch({ lastError: `RCS gateway startup failed: ${error instanceof Error ? error.message : String(error)}` }));
		throw error;
	}
	params.log?.info?.(`Registered RCS webhook route ${params.account.webhookPath} for account ${params.account.accountId}`);
	params.statusSink?.(channelReadyPatch());
	return lifecycle.finally(() => {
		params.statusSink?.(channelStoppedPatch());
	});
}
//#endregion
//#region extensions/rcs/src/status.ts
function compareMessagingService(account, service) {
	if (service.useInboundWebhookOnNumber) return {
		status: "unavailable",
		reason: "Disable defer-to-sender so RCS inbound uses the service-level webhook."
	};
	const shared = {
		serviceSid: service.sid || account.messagingServiceSid,
		expectedUrl: account.publicWebhookUrl,
		configuredUrl: service.inboundRequestUrl,
		configuredMethod: service.inboundMethod.toUpperCase()
	};
	if (!service.inboundRequestUrl) return {
		status: "messaging-service-missing",
		...shared
	};
	if (shared.configuredMethod && shared.configuredMethod !== "POST") return {
		status: "messaging-service-method-mismatch",
		...shared
	};
	if (service.inboundRequestUrl !== account.publicWebhookUrl) return {
		status: "messaging-service-url-mismatch",
		...shared
	};
	return {
		status: "messaging-service-matches",
		...shared
	};
}
function webhookError(probe) {
	switch (probe.status) {
		case "messaging-service-matches": return;
		case "unavailable": return probe.reason;
		case "messaging-service-missing": return "Twilio Messaging Service " + probe.serviceSid + " has no inbound request URL.";
		case "messaging-service-method-mismatch": return "Twilio Messaging Service " + probe.serviceSid + " uses " + (probe.configuredMethod || "an unknown method") + "; use POST.";
		case "messaging-service-url-mismatch": return "Twilio Messaging Service " + probe.serviceSid + " points at " + probe.configuredUrl + "; expected " + probe.expectedUrl + ".";
	}
}
async function probeRcsAccount(params) {
	const webhook = params.account.messagingServiceSid ? compareMessagingService(params.account, await retrieveTwilioMessagingService({
		account: params.account,
		serviceSid: params.account.messagingServiceSid,
		fetchImpl: params.options?.fetchImpl,
		timeoutMs: params.timeoutMs
	})) : {
		status: "unavailable",
		reason: "RCS probe requires messagingServiceSid."
	};
	const error = webhookError(webhook);
	return {
		ok: !error,
		...error ? { error } : {},
		webhook,
		hints: ["RCS-only transport: recipients must be RCS-enabled and approved while the sender is in test mode."]
	};
}
function deliveryLine(receipt) {
	if (receipt.errorCode) return {
		text: "Latest receipt " + receipt.messageSid + " failed (error " + receipt.errorCode + ")",
		tone: "warn"
	};
	const status = receipt.status.trim().toLowerCase();
	if (status === "read") return {
		text: "Read receipt: recipient read " + receipt.messageSid,
		tone: "success"
	};
	if (status === "delivered") return {
		text: "Delivered: " + receipt.messageSid + " reached the recipient",
		tone: "muted"
	};
	return {
		text: "Latest receipt " + receipt.messageSid + ": " + receipt.status,
		tone: "muted"
	};
}
async function buildRcsDeliveryStatusLines(account) {
	const [event] = await listRecentRcsDeliveryRecords(account, 1);
	return event ? [deliveryLine(event)] : [];
}
function formatRcsProbeLines(probe) {
	if (!probe || typeof probe !== "object") return [];
	const value = probe;
	const lines = [];
	if (value.ok === true) lines.push({
		text: "Probe: ok",
		tone: "success"
	});
	else if (value.ok === false) lines.push({
		text: "Probe: failed" + (value.error ? " (" + value.error + ")" : ""),
		tone: "error"
	});
	if (value.webhook?.status === "messaging-service-matches") lines.push({ text: "Twilio RCS webhook: " + value.webhook.configuredUrl });
	else if (value.webhook?.status) lines.push({
		text: "Twilio RCS webhook: " + value.webhook.status,
		tone: "warn"
	});
	for (const hint of value.hints ?? []) lines.push({
		text: hint,
		tone: "muted"
	});
	return lines;
}
//#endregion
//#region extensions/rcs/src/channel.ts
const CHANNEL_ID = "rcs";
const rcsConfigAdapter = createHybridChannelConfigAdapter({
	sectionKey: CHANNEL_ID,
	listAccountIds: listRcsAccountIds,
	resolveAccount: resolveRcsAccount,
	defaultAccountId: resolveDefaultRcsAccountId,
	clearBaseFields: [
		"accountSid",
		"authToken",
		"messagingServiceSid",
		"webhookPath",
		"publicWebhookUrl",
		"dangerouslyDisableSignatureValidation",
		"dmPolicy",
		"allowFrom"
	],
	resolveAllowFrom: (account) => account.allowFrom,
	formatAllowFrom: (allowFrom) => normalizeStringEntries(allowFrom.map((entry) => normalizeRcsAllowFrom(String(entry))))
});
const resolveRcsDmPolicy = createScopedDmSecurityResolver({
	channelKey: CHANNEL_ID,
	resolvePolicy: (account) => account.dmPolicy,
	resolveAllowFrom: (account) => account.allowFrom,
	policyPathSuffix: "dmPolicy",
	defaultPolicy: "pairing",
	approveHint: "openclaw pairing approve rcs <code>",
	normalizeEntry: normalizeRcsAllowFrom
});
const collectRcsSecurityWarnings = createConditionalWarningCollector((account) => account.dangerouslyDisableSignatureValidation && "- RCS: Twilio signature validation is disabled. Only use this for local testing.", (account) => account.dmPolicy === "open" && account.allowFrom.includes("*") && "- RCS: dmPolicy=\"open\" allows any phone number to message the bot.");
function rcsSetupPatch(input) {
	const patch = {};
	for (const key of [
		"accountSid",
		"authToken",
		"messagingServiceSid",
		"webhookPath",
		"publicWebhookUrl",
		"dmPolicy",
		"allowFrom"
	]) if (input[key] !== void 0) patch[key] = input[key];
	return patch;
}
function applyRcsAccountConfig(params) {
	const patch = rcsSetupPatch(params.input);
	const channels = { ...params.cfg.channels };
	const current = { ...channels[CHANNEL_ID] };
	if (params.accountId === DEFAULT_ACCOUNT_ID) {
		channels[CHANNEL_ID] = {
			...current,
			...patch
		};
		return {
			...params.cfg,
			channels
		};
	}
	const accounts = { ...current.accounts };
	accounts[params.accountId] = {
		...accounts[params.accountId],
		...patch
	};
	channels[CHANNEL_ID] = {
		...current,
		accounts
	};
	return {
		...params.cfg,
		channels
	};
}
const rcsSetupContract = defineChannelSetupContract({
	fields: {
		accountSid: {
			kind: "string",
			sensitive: true,
			cli: {
				flags: "--account-sid <sid>",
				description: "Twilio account SID"
			}
		},
		authToken: {
			kind: "string",
			sensitive: true,
			cli: {
				flags: "--auth-token <token>",
				description: "Twilio auth token"
			}
		},
		messagingServiceSid: {
			kind: "string",
			cli: {
				flags: "--messaging-service-sid <sid>",
				description: "Twilio RCS Messaging Service SID"
			}
		},
		webhookPath: {
			kind: "string",
			cli: {
				flags: "--webhook-path <path>",
				description: "RCS webhook path"
			}
		},
		publicWebhookUrl: {
			kind: "string",
			cli: {
				flags: "--public-webhook-url <url>",
				description: "Public RCS webhook URL"
			}
		},
		dmPolicy: {
			kind: "choice",
			choices: [
				"pairing",
				"allowlist",
				"open",
				"disabled"
			],
			cli: {
				flags: "--dm-policy <policy>",
				description: "RCS DM policy"
			}
		},
		allowFrom: {
			kind: "string-list",
			cli: {
				flags: "--allow-from <numbers>",
				description: "Allowed RCS senders"
			}
		}
	},
	adapter: { applyAccountConfig: applyRcsAccountConfig }
});
function resolveRcsTo(ctx) {
	const account = resolveRcsAccount(ctx.cfg, ctx.accountId);
	const to = normalizeRcsIdentity(ctx.to);
	if (!looksLikeRcsTarget(to)) throw new Error(`Invalid RCS target: ${ctx.to}`);
	return {
		account,
		to
	};
}
async function sendRcsText(ctx) {
	const { account, to } = resolveRcsTo(ctx);
	return createRcsChannelSendResult({
		results: await sendRcsTextChunks({
			account,
			to,
			text: ctx.text,
			onPlatformSendDispatch: ctx.onPlatformSendDispatch,
			onDeliveryResult: ctx.onDeliveryResult
		}),
		kind: "text"
	});
}
async function sendRcsMediaMessage(ctx) {
	const { account, to } = resolveRcsTo(ctx);
	const mediaUrls = resolveOutboundMediaUrls(ctx) ?? [];
	if (!mediaUrls.length) {
		if (!ctx.text) throw new Error("RCS media send requires mediaUrl or text.");
		return createRcsChannelSendResult({
			results: await sendRcsTextChunks({
				account,
				to,
				text: ctx.text,
				onPlatformSendDispatch: ctx.onPlatformSendDispatch,
				onDeliveryResult: ctx.onDeliveryResult
			}),
			kind: "text"
		});
	}
	return createRcsChannelSendResult({
		results: await sendRcsMedia({
			account,
			to,
			mediaUrls,
			...ctx.text ? { text: ctx.text } : {},
			onPlatformSendDispatch: ctx.onPlatformSendDispatch,
			onDeliveryResult: ctx.onDeliveryResult
		}),
		kind: "media"
	});
}
const rcsMessageAdapter = defineChannelMessageAdapter({
	id: CHANNEL_ID,
	durableFinal: { capabilities: {
		text: true,
		media: true,
		messageSendingHooks: true
	} },
	send: {
		text: async (ctx) => await sendRcsText(ctx),
		media: async (ctx) => await sendRcsMediaMessage(ctx)
	}
});
const rcsPlugin = createChatChannelPlugin({
	base: {
		id: CHANNEL_ID,
		meta: {
			id: CHANNEL_ID,
			label: "RCS",
			selectionLabel: "RCS (Twilio)",
			detailLabel: "Twilio RCS",
			docsPath: "/channels/rcs",
			docsLabel: "rcs",
			blurb: "Twilio RCS Business Messaging with text, media, and delivery/read receipts.",
			order: 89
		},
		capabilities: {
			chatTypes: ["direct"],
			media: true,
			threads: false,
			reactions: false,
			edit: false,
			unsend: false,
			reply: false,
			effects: false,
			blockStreaming: false
		},
		reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
		configSchema: RcsChannelConfigSchema,
		setupContract: rcsSetupContract,
		config: {
			...rcsConfigAdapter,
			inspectAccount: inspectRcsAccount,
			isConfigured: isRcsAccountConfigured,
			unconfiguredReason: () => "RCS requires accountSid, authToken, and messagingServiceSid.",
			describeAccount: (account) => ({
				accountId: account.accountId,
				name: account.messagingServiceSid || "RCS",
				configured: isRcsAccountConfigured(account),
				enabled: account.enabled
			})
		},
		messaging: {
			targetPrefixes: ["rcs"],
			normalizeTarget: (target) => normalizeRcsIdentity(target),
			targetResolver: {
				looksLikeId: looksLikeRcsTarget,
				hint: "<+15551234567 or rcs:+15551234567>"
			}
		},
		directory: createEmptyChannelDirectoryAdapter(),
		gateway: { startAccount: async (ctx) => {
			if (!ctx.channelRuntime) {
				ctx.log?.warn?.("RCS channel runtime is not available; webhook route not started");
				return;
			}
			const statusSink = createAccountStatusSink({
				accountId: ctx.account.accountId,
				setStatus: ctx.setStatus
			});
			return await startRcsGatewayAccount({
				cfg: ctx.cfg,
				account: ctx.account,
				channelRuntime: ctx.channelRuntime,
				abortSignal: ctx.abortSignal,
				log: ctx.log,
				statusSink
			});
		} },
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			resolveAccountSnapshot: ({ account }) => {
				const configured = isRcsAccountConfigured(account);
				return {
					accountId: account.accountId,
					name: account.messagingServiceSid || "RCS",
					enabled: account.enabled,
					configured,
					extra: { statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured" }
				};
			},
			probeAccount: async ({ account, timeoutMs }) => await probeRcsAccount({
				account,
				timeoutMs
			}),
			formatCapabilitiesProbe: ({ probe }) => formatRcsProbeLines(probe),
			buildCapabilitiesDiagnostics: async ({ account }) => ({ lines: [...collectRcsStartupWarnings(account).map((text) => ({
				text,
				tone: "warn"
			})), ...await buildRcsDeliveryStatusLines(account)] })
		}),
		secrets: {
			secretTargetRegistryEntries,
			collectRuntimeConfigAssignments
		},
		agentPrompt: { messageToolHints: () => [
			"",
			"### RCS Formatting",
			"RCS sends plain text and media to RCS-enabled recipients only. Keep replies conversational; avoid markdown tables. Outbound media must use public http(s) URLs."
		] },
		message: rcsMessageAdapter
	},
	pairing: { text: {
		idLabel: "phoneNumber",
		message: "OpenClaw: your RCS access has been approved.",
		normalizeAllowEntry: normalizeRcsAllowFrom,
		notify: async ({ cfg, id, message, accountId }) => {
			await sendRcsTextChunks({
				account: resolveRcsAccount(cfg, accountId),
				to: normalizeRcsIdentity(id),
				text: message
			});
		}
	} },
	security: {
		resolveDmPolicy: resolveRcsDmPolicy,
		collectWarnings: ({ account }) => collectRcsSecurityWarnings(account)
	},
	outbound: {
		deliveryMode: "gateway",
		chunker: chunkTextForOutbound,
		chunkerMode: "text",
		textChunkLimit: 1600,
		resolveTarget: ({ to }) => {
			const explicit = normalizeRcsIdentity(to ?? "");
			if (explicit) return {
				ok: true,
				to: explicit
			};
			return {
				ok: false,
				error: /* @__PURE__ */ new Error("RCS target must be an E.164 phone number.")
			};
		},
		sanitizeText: ({ text }) => toRcsPlainText(text),
		sendText: sendRcsText,
		sendMedia: async (ctx) => await sendRcsMediaMessage(ctx)
	}
});
//#endregion
export { rcsPlugin };
