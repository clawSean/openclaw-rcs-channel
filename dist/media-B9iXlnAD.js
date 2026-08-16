import { formatInboundMediaUnavailableText, toInboundMediaFactsWithMetadata } from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates } from "openclaw/plugin-sdk/error-runtime";
import { SsrFBlockedError } from "openclaw/plugin-sdk/security-runtime";
import { extensionForMime } from "openclaw/plugin-sdk/media-mime";
import { MediaFetchError, unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";
import { isTransientNetworkError } from "openclaw/plugin-sdk/retry-runtime";
//#region extensions/rcs/src/media.ts
const TWILIO_API_HOSTNAME = "api.twilio.com";
const TWILIO_MEDIA_PATH_RE = /^\/2010-04-01\/Accounts\/([^/]+)\/Messages\/([^/]+)\/Media\/(ME[0-9a-fA-F]{32})$/u;
const TWILIO_RCS_MEDIA_TOTAL_TIMEOUT_MS = 6e4;
const TWILIO_RCS_MEDIA_RESPONSE_HEADER_TIMEOUT_MS = 3e4;
const TWILIO_RCS_MEDIA_READ_IDLE_TIMEOUT_MS = 3e4;
const TWILIO_RCS_MEDIA_BATCH_TIMEOUT_MS = 4 * 6e4;
const TWILIO_RCS_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const TWILIO_RCS_MEDIA_RETRY = {
	attempts: 2,
	minDelayMs: 500,
	maxDelayMs: 2e3,
	jitter: .2
};
function requireTwilioMediaUrl(rawUrl, identity) {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:" || url.hostname !== TWILIO_API_HOSTNAME || url.port || url.username || url.password) throw new Error("Twilio RCS media URL must use https://api.twilio.com.");
	const match = TWILIO_MEDIA_PATH_RE.exec(url.pathname);
	if (!match || match[1] !== identity.accountSid || match[2] !== identity.messageSid) throw new Error("Twilio RCS media URL does not match the inbound message.");
	return url.toString();
}
function inboundMediaUnavailableBody(body, count) {
	return formatInboundMediaUnavailableText({
		body,
		notice: `[${count} Twilio RCS attachment${count === 1 ? "" : "s"} unavailable]`
	});
}
function inboundMediaFileName(contentType, index) {
	return `rcs-${index + 1}${extensionForMime(contentType) ?? ".bin"}`;
}
function createInboundMediaCleanup(paths) {
	let cleanup;
	return async () => {
		cleanup ??= Promise.all(paths.map(async (filePath) => await unlinkIfExists(filePath))).then(() => void 0);
		await cleanup;
	};
}
function nestedMediaErrorCandidates(candidate) {
	const nested = [
		candidate.cause,
		candidate.reason,
		candidate.original,
		candidate.error,
		candidate.data
	];
	if (Array.isArray(candidate.errors)) nested.push(...candidate.errors);
	return nested;
}
function isRetryableInboundMediaError(error) {
	if (!(error instanceof MediaFetchError)) return false;
	if (error.code === "http_error") return error.status === 408 || error.status === 429 || typeof error.status === "number" && error.status >= 500;
	if (error.code !== "fetch_failed") return false;
	if (collectErrorGraphCandidates(error.cause, nestedMediaErrorCandidates).some((candidate) => candidate instanceof SsrFBlockedError)) return false;
	return isTransientNetworkError(error.cause);
}
async function materializeRcsInboundMedia(params) {
	const savedPaths = [];
	const cleanup = createInboundMediaCleanup(savedPaths);
	const declaredUnavailableCount = params.msg.unavailableMediaCount ?? 0;
	if (params.msg.media.length === 0) return {
		body: declaredUnavailableCount > 0 ? inboundMediaUnavailableBody(params.msg.body, declaredUnavailableCount) : params.msg.body,
		media: [],
		cleanup
	};
	if (params.msg.accountSid !== params.account.accountSid) {
		params.log?.warn?.("Refused Twilio RCS attachments for webhook account mismatch");
		return {
			body: inboundMediaUnavailableBody(params.msg.body, declaredUnavailableCount + params.msg.media.length),
			media: [],
			cleanup
		};
	}
	let remainingBytes = TWILIO_RCS_MEDIA_MAX_BYTES;
	let unavailableCount = declaredUnavailableCount;
	const batchTimeoutSignal = AbortSignal.timeout(TWILIO_RCS_MEDIA_BATCH_TIMEOUT_MS);
	const abortSignal = params.abortSignal ? AbortSignal.any([params.abortSignal, batchTimeoutSignal]) : batchTimeoutSignal;
	const savedMedia = [];
	try {
		for (const [index, media] of params.msg.media.entries()) {
			abortSignal.throwIfAborted();
			if (remainingBytes <= 0) {
				unavailableCount += 1;
				continue;
			}
			try {
				const saved = await params.mediaRuntime.media.saveRemoteMedia({
					url: requireTwilioMediaUrl(media.url, {
						accountSid: params.msg.accountSid,
						messageSid: params.msg.messageSid
					}),
					requestInit: {
						headers: { authorization: `Basic ${Buffer.from(`${params.account.accountSid}:${params.account.authToken}`).toString("base64")}` },
						signal: abortSignal
					},
					filePathHint: inboundMediaFileName(media.contentType, index),
					fallbackContentType: media.contentType,
					maxBytes: remainingBytes,
					ssrfPolicy: { hostnameAllowlist: [TWILIO_API_HOSTNAME] },
					timeoutMs: TWILIO_RCS_MEDIA_TOTAL_TIMEOUT_MS,
					responseHeaderTimeoutMs: TWILIO_RCS_MEDIA_RESPONSE_HEADER_TIMEOUT_MS,
					readIdleTimeoutMs: TWILIO_RCS_MEDIA_READ_IDLE_TIMEOUT_MS,
					retry: TWILIO_RCS_MEDIA_RETRY
				});
				remainingBytes -= saved.size;
				savedPaths.push(saved.path);
				savedMedia.push({
					path: saved.path,
					contentType: saved.contentType ?? media.contentType,
					messageId: params.msg.messageSid
				});
			} catch (error) {
				abortSignal.throwIfAborted();
				if (isRetryableInboundMediaError(error)) throw error;
				unavailableCount += 1;
				params.log?.warn?.(`Failed to download Twilio RCS attachment ${index + 1}`);
			}
		}
		return {
			body: unavailableCount > 0 ? inboundMediaUnavailableBody(params.msg.body, unavailableCount) : params.msg.body,
			media: await toInboundMediaFactsWithMetadata(savedMedia),
			cleanup
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
//#endregion
export { materializeRcsInboundMedia };
