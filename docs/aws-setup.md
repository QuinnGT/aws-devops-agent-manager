# AWS setup

This page lists what DevOps Agent Manager calls in AWS, which permissions that needs, and how to set them up. The demo needs none of it.

The permission documents are in [`docs/iam/`](iam/). They were written from the AWS documentation linked below and have not been run against a live account by the project. Run **Test connection** in the space settings after you set up access. It checks the DevOps Agent read calls and the external ID, but not CloudTrail, Amazon Bedrock or the write actions.

## What the app calls

The app only reads from your Agent Space, with two exceptions: applying a plan writes assets, and an audit that uses the DevOps Agent chat as its reviewer attaches two temporary files and sends the chat a message. Each AWS call, its IAM action and the access it belongs to:

| What you do in the app | AWS service and API calls | Access |
|---|---|---|
| Register a space, sync, browse assets and history, check plans, create releases, verify releases | AWS DevOps Agent: `GetAgentSpace`, `ListAssetTypes`, `ListAssets`, `GetAsset`, `ListAssetVersions`, `ListAssetFiles`, `GetAssetFile`, `GetAssetContent` | Read |
| Export journals | AWS DevOps Agent: `ListBacklogTasks`, `GetBacklogTask`, `ListExecutions`, `ListJournalRecords` | Read |
| See who changed an asset | AWS CloudTrail: `LookupEvents` | Read |
| Pick a review model | Amazon Bedrock: `ListFoundationModels`, `ListInferenceProfiles` | Read |
| Run audits (reviews and reports) | Amazon Bedrock: `Converse` | Read |
| Apply a plan, including a restore to an earlier release | AWS DevOps Agent: `CreateAsset`, `UpdateAsset`, `DeleteAsset`, `CreateAssetFile`, `UpdateAssetFile`, `DeleteAssetFile` | Write, in the worker only |
| Run an audit with the DevOps Agent chat as the reviewer (optional) | AWS DevOps Agent: `CreateChat`, `SendMessage`, and `CreateAsset` and `DeleteAsset` for the review's temporary attachments | Write, in the worker only. Off until you add `chat-review-policy.json` |
| Register a space that uses roles | AWS STS: `AssumeRole` without the external ID, which must be refused | Your base identity |

The IAM action for each call has the same name as the call. The prefix is `aidevops` for AWS DevOps Agent, `cloudtrail` for CloudTrail, `bedrock` for Amazon Bedrock and `sts` for STS. The [Service Authorization Reference for AWS DevOps Agent](https://docs.aws.amazon.com/service-authorization/latest/reference/list_devops-agent.html) lists every DevOps Agent action above. The same names are in the machine-readable references for [CloudTrail](https://servicereference.us-east-1.amazonaws.com/v1/cloudtrail/cloudtrail.json), [Amazon Bedrock](https://servicereference.us-east-1.amazonaws.com/v1/bedrock/bedrock.json) and [STS](https://servicereference.us-east-1.amazonaws.com/v1/sts/sts.json), which the policies here were checked against. The one exception to the same-name rule is `Converse`: [it needs the `bedrock:InvokeModel` action](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html). The app calls `Converse` and not `ConverseStream`, so `bedrock:InvokeModelWithResponseStream` is not needed.

Resource-level limits:

- The DevOps Agent actions in the table, except `ListAssetTypes`, apply to the `agentspace` resource type, so the policies name your Agent Space: `arn:aws:aidevops:<region>:<account-id>:agentspace/<agent-space-id>`. `ListAssetTypes` supports no resource type and uses `*`.
- `cloudtrail:LookupEvents`, `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` support no resource type either and use `*`.
- `bedrock:InvokeModel` accepts foundation model and inference profile ARNs. The shipped policy allows any model. Narrow it to the models you choose (see [Amazon Bedrock](#amazon-bedrock)).
- [`LookupEvents` returns events from the last 90 days and allows two requests per second per account per Region](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html). The app runs it in the Region of the space.

## Two ways to give the app access

**A profile with the permissions, no roles.** Attach [`read-policy.json`](iam/read-policy.json) to the identity behind your AWS profile. Attach [`write-policy.json`](iam/write-policy.json) as well if you want to apply plans, and [`chat-review-policy.json`](iam/chat-review-policy.json) if you want audits reviewed by a DevOps Agent chat. Leave all role fields empty when you register the space. The same identity does reads and writes. Writes happen only in the worker process. This is the simplest setup and fits a personal or test account.

**Two roles that the app assumes.** A read role and a write role, each with a trust policy that requires an external ID. The write role exists only for applying plans, so people and processes that need to browse never hold write permission. Use this for a shared or production space. The rest of this page describes it.

With roles, the app assumes the read role for everything except applying plans, and the write role only inside worker jobs. It sets the signed-in user's email as the [source identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html) of each session, so CloudTrail shows who acted. Sessions last one hour (`roleSessionSeconds` in `policy/api.yaml`).

## Set up the roles

You need the identity the app runs as (the principal), and the external ID, which the app generates when you save a role ARN.

1. Find the principal. Run `aws sts get-caller-identity --profile <profile>` and read the `Arn` field.
   - For an IAM user, use that ARN.
   - For an assumed role, use the ARN of the role itself, not the `assumed-role` session ARN. For an IAM Identity Center profile, [the role is named `AWSReservedSSO_<permission set>_<suffix>` and has the path `/aws-reserved/sso.amazonaws.com/`](https://docs.aws.amazon.com/singlesignon/latest/userguide/referencingpermissionsets.html). Its suffix changes if every assignment of the permission set is removed and added again, so the trust policy must then be updated.
2. Register the space in the app (`/spaces/new`). Enter the role ARNs you are about to create, `arn:aws:iam::<account-id>:role/DevOpsAgentManagerRead` and `arn:aws:iam::<account-id>:role/DevOpsAgentManagerWrite`. The connection test fails until the roles exist. That is expected.
3. Open the space's settings and copy the **External ID**. It starts with `dam-`. It stays the same when you edit the roles.
4. Create the roles with the [CloudFormation template](iam/cloudformation.yaml). It creates both roles with the names above. Add `CreateWriteRole=false` to skip the write role. Add `AllowChatReviews=true` to let the write role run DevOps Agent chat reviews (see [DevOps Agent chat reviews](#devops-agent-chat-reviews)); it is off by default.

   ```sh
   aws cloudformation deploy \
     --stack-name devops-agent-manager-roles \
     --template-file docs/iam/cloudformation.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides \
       AgentSpaceArn=<agent-space-arn> \
       TrustedPrincipalArn=<principal-arn> \
       ExternalId=<external-id>
   ```

   To create the roles by hand, give each role the trust policy in [`trust-policy.json`](iam/trust-policy.json), the read role [`read-policy.json`](iam/read-policy.json) and the write role [`write-policy.json`](iam/write-policy.json), plus [`chat-review-policy.json`](iam/chat-review-policy.json) if you want chat reviews. Replace `<account-id>`, `<agent-space-arn>`, `<principal-arn>` and `<external-id>` first.
5. If the principal is in a different account than the roles, give it [`caller-policy.json`](iam/caller-policy.json) too. [Source identity needs `sts:SetSourceIdentity` in both the principal's policy and the role's trust policy when the role is in another account](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html#id_credentials_temp_control-access_monitor-perms).
6. In the space settings, choose **Test connection**. A passing test means the read calls work and both roles refuse `AssumeRole` without the external ID.

### How the trust policy works

- The first statement allows `sts:AssumeRole` only when the request carries the space's external ID. The [external ID](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html) is a condition on `sts:ExternalId`. The app proves the condition is enforced by calling `AssumeRole` without it and expecting `AccessDenied`. If a role can be assumed without the external ID, the space is rejected.
- The second statement allows `sts:SetSourceIdentity`. The app sends a source identity with every `AssumeRole`, and [without this permission the call fails](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html#id_credentials_temp_control-access_monitor-know). It is a separate statement because `sts:ExternalId` is not a condition key of `sts:SetSourceIdentity` in the [STS reference](https://servicereference.us-east-1.amazonaws.com/v1/sts/sts.json).
- Roles are assumed with the credentials of your base identity. If that identity is itself an assumed role (IAM Identity Center, for example), AWS treats the call as [role chaining](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html#iam-term-role-chaining), which caps a session at one hour. The app asks for one hour, so it fits.

## Amazon Bedrock

Audits send journal text to a model and read the answer. The app picks no model for you. You choose a Bedrock model ID or an inference profile ID in each audit, or set a default in the space settings. Inference runs in the space's Region unless you set another one under the space's inference settings.

- **Permissions.** The read role needs the `bedrock:InvokeModel` statement in `read-policy.json`. To limit it to chosen models, replace the three `Resource` entries with the ARNs of those models and profiles.
- **Inference profiles.** A cross-Region profile ID, such as one that begins with `us.`, routes a request to several Regions. [The policy must allow the inference profile and the foundation model in every Region the profile uses](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html). The shipped policy allows foundation models in all Regions (`arn:aws:bedrock:*::foundation-model/*`) for that reason.
- **Model access.** [Most models switch on at the first call. The identity making the first call needs `aws-marketplace:Subscribe`, `aws-marketplace:Unsubscribe` and `aws-marketplace:ViewSubscriptions`. Anthropic models older than Claude Opus 4.7 also need the one-time use case form in the Bedrock console](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html). If an audit fails with `AccessDeniedException`, check this first. After a model is enabled in the account, the Marketplace permissions are no longer needed to call it. Add them to the read role temporarily, or enable the model once from the console with your own identity.

## DevOps Agent chat reviews

An audit can use a chat in the audited Agent Space as its reviewer instead of an Amazon Bedrock model. The audit form offers it as **DevOps Agent chat**, with a model tier of smart (the default), balanced or fast. It is off until the identity the worker uses is allowed to start a chat. For each investigation the worker does this:

1. Creates two temporary `attachment` assets, `brief.md` and `records.md`, named `dam-review-<incident>-<token>-brief.md` and `dam-review-<incident>-<token>-records.md`. The chat cannot read an investigation's journal with its own tools, so the journal has to be attached.
2. Creates a chat and sends one message. It holds the reviewer instructions, the output schema and the two attachment IDs. If the reply is not JSON, one more message in the same chat asks for the JSON again.
3. Reads the answer from the stream, checks it against the schema and checks every record it cites, as it does for a Bedrock review.
4. Deletes both attachments, whether the review succeeded or not. If a delete fails, the worker log names the file, and you can delete it by hand: its name starts with `dam-review-`.

The message tells the chat not to change memories, skills, instructions or other assets, not to act on infrastructure and not to start background research. That is an instruction to a model, not a control the app enforces. The app does enforce one thing: if the stream asks for an approval or an interrupt, the review fails and nothing is approved.

### Permissions

- Add [`chat-review-policy.json`](iam/chat-review-policy.json) (`aidevops:CreateChat` and `aidevops:SendMessage`, on the Agent Space) to the identity that does writes. With roles, that is the write role: deploy the template with `AllowChatReviews=true`, or attach the document by hand.
- The attachments use `CreateAsset` and `DeleteAsset`, which [`write-policy.json`](iam/write-policy.json) already allows. A read-only setup without a write role cannot run chat reviews.
- Both new actions apply to the `agentspace` resource type, like the asset actions. [The Service Authorization Reference lists them](https://docs.aws.amazon.com/service-authorization/latest/reference/list_devops-agent.html).
- The app never calls `UpdateApprovalAction`, so it cannot approve anything the chat asks for.
- The sessions carry the signed-in person's email as the source identity when the space uses roles, so CloudTrail shows who started each chat review.

### What to know before you turn it on

- **The chat sees the space's instructions.** It loads the space's own instructions (`AGENTS.md`) like any chat in that space, and it has the tools and connections the space has. A review of the agent's work is therefore written by a chat that follows the same instructions. For a more independent review, and a smaller set of tools within reach, register a separate Agent Space for reviews that has no instructions or connected accounts of its own, export the journals from the audited space and import them there, and run the audit in that space.
- **Chats stay in the space.** The API has no call to delete a chat, so each review leaves one chat in the space's chat history. Its first message holds the reviewer instructions and names the incident.
- **Attachments are temporary.** They exist for the length of one review, about 2 minutes in testing. They are `attachment` assets, so the app's own sync leaves them out of history: `ignoredAttachmentPrefixes` in [`policy/sync.yaml`](../policy/sync.yaml) lists the file name start, and `review.chat.attachmentPrefix` in the audit profile sets it. Keep the two the same. Someone browsing the space in the console during a review can see them. Other attachments are tracked as usual.
- **It costs DevOps Agent time.** [DevOps Agent charges $0.0083 per agent-second](https://repost.aws/articles/ARCVOaW7ZDSjeLYPl5nMeeVg/how-do-i-monitor-and-control-aws-devops-agent-costs) for tasks that include chat, with nothing charged while it is idle. A review took between 100 and 140 seconds in testing, which is about $1 at today's price. Paid AWS Support plans include [monthly credits that apply only to DevOps Agent charges](https://www.repost.aws/articles/AR0juLZf1VT8yQD_kj4QEK3Q/forecasting-aws-devops-agent-costs-for-your-organization). A Bedrock review costs model tokens instead.
- **Size limits.** One message holds at most 32,768 characters, and the app checks that before it calls anything. The attached files are limited to 1.5 MB together (`review.chat.attachmentBytesCap`). In testing a chat read 1.8 MB in full, returned an empty answer for 2.6 MB and failed with an internal error for 3.9 MB. A review above the limit fails before any call, and its error names the setting to lower, usually `review.files.recordCharsCap`.
- **Speed and tier.** The numbers above come from one test space in November 2026: smart and balanced both took about 2 minutes, and fast took 28 seconds but 7 of 31 quotes cited the wrong record. The timeout of the audit profile (`review.timeoutSeconds`) covers the whole review.
- **Reviews run side by side.** Four chats in parallel worked in testing. The profile's `review.concurrency` decides how many run at once.

## Files in `docs/iam/`

| File | What it is |
|---|---|
| [`read-policy.json`](iam/read-policy.json) | Permissions for the read role, or for your profile's identity when you use no roles |
| [`write-policy.json`](iam/write-policy.json) | Permissions for the write role, or for your profile's identity when you apply plans without roles |
| [`chat-review-policy.json`](iam/chat-review-policy.json) | Optional. Adds `CreateChat` and `SendMessage` to the write role, or to your profile's identity, so an audit can use a DevOps Agent chat as the reviewer. It needs `write-policy.json` too, for the temporary attachments |
| [`trust-policy.json`](iam/trust-policy.json) | Trust policy for both roles |
| [`caller-policy.json`](iam/caller-policy.json) | Lets the principal assume the two roles. Needed only for a principal in another account |
| [`cloudformation.yaml`](iam/cloudformation.yaml) | Creates both roles from the documents above. `AllowChatReviews=true` adds the chat review statement to the write role |

## Containers and AWS credentials

How the containers get credentials for your profile is in [Getting started](getting-started.md#aws-credentials-in-containers). With the AWS CLI installed, `./scripts/stack.sh up --profile <name>` gets credentials for any profile type (access keys, an assumed role, IAM Identity Center, `credential_process`) and keeps them renewed in the containers. The identity behind the profile needs the permissions in this guide, and nothing else changes for the containers.
