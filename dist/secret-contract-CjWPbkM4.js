import { collectConditionalChannelFieldAssignments, getChannelSurface, hasOwnProperty } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
//#region extensions/rcs/src/secret-contract.ts
const DEFAULT_ACCOUNT_ID = "default";
const secretTargetRegistryEntries = [{
	id: "channels.rcs.accounts.*.authToken",
	targetType: "channels.rcs.accounts.*.authToken",
	configFile: "openclaw.json",
	pathPattern: "channels.rcs.accounts.*.authToken",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}, {
	id: "channels.rcs.authToken",
	targetType: "channels.rcs.authToken",
	configFile: "openclaw.json",
	pathPattern: "channels.rcs.authToken",
	secretShape: "secret_input",
	expectedResolvedValue: "string",
	includeInPlan: true,
	includeInConfigure: true,
	includeInAudit: true
}];
function hasTopLevelRcsAccount(channel) {
	for (const field of ["accountSid", "messagingServiceSid"]) if (typeof channel[field] === "string" && channel[field].trim().length > 0) return true;
	return false;
}
function hasEnvBackedDefaultRcsAccount(env) {
	for (const name of [
		"TWILIO_ACCOUNT_SID",
		"TWILIO_AUTH_TOKEN",
		"TWILIO_RCS_MESSAGING_SERVICE_SID"
	]) if (typeof env[name] === "string" && env[name].trim().length > 0) return true;
	return false;
}
function collectRuntimeConfigAssignments(params) {
	const resolved = getChannelSurface(params.config, "rcs");
	if (!resolved) return;
	const { channel: rcs, surface } = resolved;
	const hasExplicitDefaultAccount = surface.accounts.some(({ accountId }) => accountId === DEFAULT_ACCOUNT_ID);
	const topLevelRcsAccountActive = (hasTopLevelRcsAccount(rcs) || hasEnvBackedDefaultRcsAccount(params.context.env)) && !hasExplicitDefaultAccount;
	collectConditionalChannelFieldAssignments({
		channelKey: "rcs",
		field: "authToken",
		channel: rcs,
		surface,
		defaults: params.defaults,
		context: params.context,
		topLevelActiveWithoutAccounts: true,
		topLevelInheritedAccountActive: ({ account, enabled }) => topLevelRcsAccountActive || enabled && !hasOwnProperty(account, "authToken"),
		accountActive: ({ enabled }) => enabled,
		topInactiveReason: "no enabled RCS surface inherits this top-level authToken.",
		accountInactiveReason: "RCS account is disabled."
	});
}
const channelSecrets = {
	secretTargetRegistryEntries,
	collectRuntimeConfigAssignments
};
//#endregion
export { collectRuntimeConfigAssignments as n, secretTargetRegistryEntries as r, channelSecrets as t };
