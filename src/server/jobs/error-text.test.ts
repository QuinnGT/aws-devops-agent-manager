import { describe, expect, it } from "vitest";
import {
  accessDeniedText,
  APP_BUG_TEXT,
  AWS_ERROR_TEXT,
  AWS_OTHER_TEXT,
  awsErrorKind,
  connectionNextStep,
  deniedAction,
  errorDetails,
  liveErrorMessage,
  liveErrorNeedsSettings,
  plainErrorOf,
  plainErrorText,
  redactSecrets,
} from "./error-text";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

/** What the review saw on Home and in the audit banner. */
const PROFILE_MISSING = "Could not resolve credentials using profile: [dam-demo-no-aws] in configuration/credentials file(s).";
const DENIED =
  "User: arn:aws:sts::111122223333:assumed-role/DamRead/dam is not authorized to perform: aidevops:ListAssetVersions on resource: arn:aws:aidevops:us-west-2:111122223333:agentspace/as-1 because no identity-based policy allows the aidevops:ListAssetVersions action";

describe("AWS failures as the shared sentences", () => {
  it("words missing credentials the same whether thrown, stored with its name, or stored as the message alone", () => {
    const text = "This app has no AWS credentials for this space, so it can't reach AWS.";
    expect(AWS_ERROR_TEXT["no-credentials"]).toBe(text);
    expect(liveErrorMessage(named("CredentialsProviderError", PROFILE_MISSING))).toBe(text);
    expect(plainErrorText(`CredentialsProviderError: ${PROFILE_MISSING}`)).toBe(text);
    expect(plainErrorText(PROFILE_MISSING)).toBe(text);
    expect(plainErrorText("Could not load credentials from any providers")).toBe(text);
    expect(plainErrorText("AWS credential provider failed: Could not resolve credentials using profile: [x]")).toBe(text);
    expect(plainErrorText("Profile dam-demo-no-aws could not be found")).toBe(text);
    expect(plainErrorOf(named("CredentialsProviderError", "x"))).toBe(text);
    expect(awsErrorKind(PROFILE_MISSING)).toBe("no-credentials");
    expect(liveErrorNeedsSettings(PROFILE_MISSING)).toBe(true);
  });

  it("names the refused action in plain words and keeps the IAM action for Details", () => {
    expect(deniedAction(DENIED)).toBe("aidevops:ListAssetVersions");
    expect(plainErrorText(`AccessDeniedException: ${DENIED}`)).toBe("AWS refused the request: the space's read role isn't allowed to list asset versions.");
    expect(accessDeniedText("not authorized to perform: aidevops:GetAsset on resource", "write")).toBe("AWS refused the request: the space's write role isn't allowed to read asset.");
    expect(accessDeniedText("not authorized to perform: cloudtrail:LookupEvents")).toBe("AWS refused the request: the space's read role isn't allowed to look up events.");
    expect(accessDeniedText("not authorized to perform: bedrock:InvokeModelWithResponseStream")).toBe("AWS refused the request: the space's read role isn't allowed to call the model.");
    expect(accessDeniedText("User x is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::1:role/r")).toBe(
      "AWS refused the request: this app's AWS credentials aren't allowed to assume the space's read role.",
    );
    expect(liveErrorMessage(named("AccessDeniedException", "User is not authorized"))).toBe("AWS refused the request: the space's read role isn't allowed to make this call.");
    expect(liveErrorNeedsSettings(named("AccessDeniedException", "x"))).toBe(true);
    const details = errorDetails(`AccessDeniedException: ${DENIED}`);
    expect(details).toMatch(/^IAM action aidevops:ListAssetVersions\. AccessDeniedException: User: arn:aws:sts::/);
    // The sentence itself never carries the IAM action, a code or an ARN.
    expect(plainErrorText(`AccessDeniedException: ${DENIED}`)).not.toMatch(/aidevops:|arn:|Exception/);
  });

  it("words throttling, the network and expired credentials, none of which an Admin fixes in settings", () => {
    expect(plainErrorText("ThrottlingException: Rate exceeded")).toBe(AWS_ERROR_TEXT.throttled);
    expect(plainErrorText("TooManyRequestsException: slow down")).toBe("AWS is limiting requests right now. Try again in a minute.");
    expect(liveErrorMessage(new Error("getaddrinfo ENOTFOUND dp.aidevops.us-west-2.api.aws"))).toBe(AWS_ERROR_TEXT.network);
    expect(plainErrorText("TimeoutError: socket hang up")).toBe(AWS_ERROR_TEXT.network);
    expect(plainErrorText("ExpiredTokenException: The security token included in the request is expired")).toBe(AWS_ERROR_TEXT.expired);
    expect(plainErrorText("UnrecognizedClientException: The security token included in the request is invalid.")).toBe(AWS_ERROR_TEXT.expired);
    for (const e of ["Rate exceeded", "ECONNRESET", "ExpiredToken"]) expect(liveErrorNeedsSettings(e)).toBe(false);
    expect(awsErrorKind("ThrottlingException: x")).toBe("throttled");
    expect(awsErrorKind("ECONNREFUSED 127.0.0.1:443")).toBe("network");
    expect(awsErrorKind("ReleaseError: the credentials expired")).toBeNull();
  });

  it("maps text stored by older builds to the current sentences, and adds no Details for them", () => {
    expect(plainErrorText("Can't reach the Agent Space: this app has no AWS credentials for it")).toBe(AWS_ERROR_TEXT["no-credentials"]);
    expect(plainErrorText("The Agent Space refused the request: the role this app uses doesn't allow it")).toMatch(/^AWS refused the request: /);
    expect(plainErrorText("The Agent Space is limiting requests right now. Try again in a minute")).toBe(AWS_ERROR_TEXT.throttled);
    expect(plainErrorText(AWS_ERROR_TEXT["no-credentials"])).toBe(AWS_ERROR_TEXT["no-credentials"]);
    expect(errorDetails("Can't reach the Agent Space: this app has no AWS credentials for it")).toBeNull();
    expect(errorDetails(AWS_ERROR_TEXT["no-credentials"])).toBeNull();
  });

  it("never shows another SDK or runtime error's own text as the sentence; Details has it", () => {
    expect(plainErrorText("ValidationException: 1 validation error detected: Value at 'x' failed")).toBe("AWS refused the request as invalid.");
    expect(plainErrorText("ResourceNotFoundException: Asset ki-85182353 not found")).toBe("AWS couldn't find what the request asked for. It may have been deleted.");
    expect(plainErrorText("InternalServerException: oops")).toBe("AWS had a problem with the request. Try again in a minute.");
    expect(plainErrorText("SomeNewServiceException: details")).toBe(AWS_OTHER_TEXT);
    expect(plainErrorText("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(APP_BUG_TEXT);
    expect(errorDetails("ResourceNotFoundException: Asset ki-85182353 not found")).toBe("ResourceNotFoundException: Asset ki-85182353 not found");
    expect(errorDetails(`CredentialsProviderError: ${PROFILE_MISSING}`)).toBe(`CredentialsProviderError: ${PROFILE_MISSING}`);
    expect(errorDetails(PROFILE_MISSING)).toBe(PROFILE_MISSING);
  });

  it("keeps this app's own sentences and adds no Details to them", () => {
    expect(plainErrorText("ReleaseError: A release named v1 already exists.")).toBe("A release named v1 already exists.");
    expect(errorDetails("ReleaseError: A release named v1 already exists.")).toBeNull();
    expect(plainErrorText("Error: boom")).toBe("boom.");
    expect(errorDetails("Error: boom")).toBe("Error: boom");
    expect(errorDetails(null)).toBeNull();
    expect(errorDetails("  ")).toBeNull();
  });

  it("removes credentials from Details", () => {
    expect(redactSecrets("key AKIAABCDEFGHIJKLMNOP and secret_access_key=abc123 x-amz-security-token: zzz")).toBe(
      "key [redacted] and secret_access_key=[redacted] x-amz-security-token: [redacted]",
    );
    expect(errorDetails(`CredentialsProviderError: bad key ASIAABCDEFGHIJKLMNOP`)).toBe("CredentialsProviderError: bad key [redacted]");
  });

  it("words the next step for the caller's role", () => {
    expect(connectionNextStep({ canManage: true })).toBe("An Admin sets the connection in Space settings.");
    expect(connectionNextStep({ canManage: false })).toBe("Ask an Admin to check the connection in Space settings.");
    expect(connectionNextStep({ canManage: true, onSettingsPage: true })).toMatch(/^Enter an AWS profile or a read role ARN/);
  });
});
