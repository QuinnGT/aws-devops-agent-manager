import { describe, expect, it } from "vitest";
import { accessDeniedText, awsErrorKind, deniedAction, errorDetail, noCredentialsText } from "./error-kind";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe("awsErrorKind", () => {
  it("tells missing credentials from refused access, throttling and network failures", () => {
    expect(awsErrorKind(named("CredentialsProviderError", "Could not resolve credentials using profile: [dam-demo-no-aws] in configuration/credentials file(s)."))).toBe("no-credentials");
    expect(awsErrorKind("The model call failed: CredentialsProviderError: Could not load credentials from any providers")).toBe("no-credentials");
    expect(awsErrorKind(named("ExpiredTokenException", "The security token included in the request is expired"))).toBe("expired");
    expect(awsErrorKind(named("AccessDeniedException", "User: arn:aws:sts::111122223333:assumed-role/read/x is not authorized to perform: bedrock:InvokeModel"))).toBe("access-denied");
    expect(awsErrorKind(named("ThrottlingException", "Rate exceeded"))).toBe("throttled");
    expect(awsErrorKind(new Error("getaddrinfo ENOTFOUND bedrock-runtime.us-west-2.amazonaws.com"))).toBe("network");
    expect(awsErrorKind(named("ValidationException", "The provided model identifier is invalid."))).toBe("other");
    expect(awsErrorKind(null)).toBe("other");
  });

  it("names the refused IAM action for a Details line", () => {
    expect(deniedAction("not authorized to perform: bedrock:InvokeModelWithResponseStream on resource")).toBe("bedrock:InvokeModelWithResponseStream");
    expect(deniedAction("Rate exceeded")).toBeNull();
  });
});

describe("shared wording", () => {
  it("gives the no-credentials sentence with the next step for the reader's role", () => {
    expect(noCredentialsText(true)).toBe("This app has no AWS credentials for this space, so it can't reach AWS. An Admin sets the connection in Space settings.");
    expect(noCredentialsText(false)).toBe("This app has no AWS credentials for this space, so it can't reach AWS. Ask an Admin to check the connection in Space settings.");
    expect(accessDeniedText("list Bedrock models")).toBe("AWS refused the request: the space's read role isn't allowed to list Bedrock models.");
  });

  it("keeps credentials out of the Details line", () => {
    expect(errorDetail(named("UnrecognizedClientException", "The security token AKIAIOSFODNN7EXAMPLE is invalid"))).toBe("UnrecognizedClientException: The security token [redacted] is invalid");
    expect(errorDetail("x".repeat(500)).length).toBeLessThan(420);
  });
});
