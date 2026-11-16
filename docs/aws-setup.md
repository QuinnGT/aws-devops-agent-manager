# AWS setup

This page lists what DevOps Agent Manager calls in AWS, which permissions that needs, and how to set them up. The demo needs none of it.

The permission documents are in [`docs/iam/`](iam/). They were written from the AWS documentation linked below and have not been run against a live account by the project. Run **Test connection** in the space settings after you set up access. It checks the DevOps Agent read calls and the external ID, but not CloudTrail, Amazon Bedrock or the write actions.

## What the app calls

The app only reads from your Agent Space, with one exception: applying a plan writes assets. Each AWS call, its IAM action and the access it belongs to:

| What you do in the app | AWS service and API calls | Access |
|---|---|---|
| Register a space, sync, browse assets and history, check plans, create releases, verify releases | AWS DevOps Agent: `GetAgentSpace`, `ListAssetTypes`, `ListAssets`, `GetAsset`, `ListAssetVersions`, `ListAssetFiles`, `GetAssetFile`, `GetAssetContent` | Read |
| Export journals | AWS DevOps Agent: `ListBacklogTasks`, `GetBacklogTask`, `ListExecutions`, `ListJournalRecords` | Read |
| See who changed an asset | AWS CloudTrail: `LookupEvents` | Read |
| Pick a review model | Amazon Bedrock: `ListFoundationModels`, `ListInferenceProfiles` | Read |
| Run audits (reviews and reports) | Amazon Bedrock: `Converse` | Read |
| Apply a plan, including a restore to an earlier release | AWS DevOps Agent: `CreateAsset`, `UpdateAsset`, `DeleteAsset`, `CreateAssetFile`, `UpdateAssetFile`, `DeleteAssetFile` | Write, in the worker only |
| Register a space that uses roles | AWS STS: `AssumeRole` without the external ID, which must be refused | Your base identity |

The IAM action for each call has the same name as the call. The prefix is `aidevops` for AWS DevOps Agent, `cloudtrail` for CloudTrail, `bedrock` for Amazon Bedrock and `sts` for STS. The [Service Authorization Reference for AWS DevOps Agent](https://docs.aws.amazon.com/service-authorization/latest/reference/list_devops-agent.html) lists every DevOps Agent action above. The same names are in the machine-readable references for [CloudTrail](https://servicereference.us-east-1.amazonaws.com/v1/cloudtrail/cloudtrail.json), [Amazon Bedrock](https://servicereference.us-east-1.amazonaws.com/v1/bedrock/bedrock.json) and [STS](https://servicereference.us-east-1.amazonaws.com/v1/sts/sts.json), which the policies here were checked against. The one exception to the same-name rule is `Converse`: [it needs the `bedrock:InvokeModel` action](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html). The app calls `Converse` and not `ConverseStream`, so `bedrock:InvokeModelWithResponseStream` is not needed.

Resource-level limits:

- The DevOps Agent actions in the table, except `ListAssetTypes`, apply to the `agentspace` resource type, so the policies name your Agent Space: `arn:aws:aidevops:<region>:<account-id>:agentspace/<agent-space-id>`. `ListAssetTypes` supports no resource type and uses `*`.
- `cloudtrail:LookupEvents`, `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` support no resource type either and use `*`.
- `bedrock:InvokeModel` accepts foundation model and inference profile ARNs. The shipped policy allows any model. Narrow it to the models you choose (see [Amazon Bedrock](#amazon-bedrock)).
- [`LookupEvents` returns events from the last 90 days and allows two requests per second per account per Region](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html). The app runs it in the Region of the space.

## Two ways to give the app access

**A profile with the permissions, no roles.** Attach [`read-policy.json`](iam/read-policy.json) to the identity behind your AWS profile. Attach [`write-policy.json`](iam/write-policy.json) as well if you want to apply plans. Leave all role fields empty when you register the space. The same identity does reads and writes. Writes happen only in the worker process. This is the simplest setup and fits a personal or test account.

**Two roles that the app assumes.** A read role and a write role, each with a trust policy that requires an external ID. The write role exists only for applying plans, so people and processes that need to browse never hold write permission. Use this for a shared or production space. The rest of this page describes it.

With roles, the app assumes the read role for everything except applying plans, and the write role only inside worker jobs. It sets the signed-in user's email as the [source identity](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_monitor.html) of each session, so CloudTrail shows who acted. Sessions last one hour (`roleSessionSeconds` in `policy/api.yaml`).

## Set up the roles

You need the identity the app runs as (the principal), and the external ID, which the app generates when you save a role ARN.

1. Find the principal. Run `aws sts get-caller-identity --profile <profile>` and read the `Arn` field.
   - For an IAM user, use that ARN.
   - For an assumed role, use the ARN of the role itself, not the `assumed-role` session ARN. For an IAM Identity Center profile, [the role is named `AWSReservedSSO_<permission set>_<suffix>` and has the path `/aws-reserved/sso.amazonaws.com/`](https://docs.aws.amazon.com/singlesignon/latest/userguide/referencingpermissionsets.html). Its suffix changes if every assignment of the permission set is removed and added again, so the trust policy must then be updated.
2. Register the space in the app (`/spaces/new`). Enter the role ARNs you are about to create, `arn:aws:iam::<account-id>:role/DevOpsAgentManagerRead` and `arn:aws:iam::<account-id>:role/DevOpsAgentManagerWrite`. The connection test fails until the roles exist. That is expected.
3. Open the space's settings and copy the **External ID**. It starts with `dam-`. It stays the same when you edit the roles.
4. Create the roles with the [CloudFormation template](iam/cloudformation.yaml). It creates both roles with the names above. Add `CreateWriteRole=false` to skip the write role.

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

   To create the roles by hand, give each role the trust policy in [`trust-policy.json`](iam/trust-policy.json), the read role [`read-policy.json`](iam/read-policy.json) and the write role [`write-policy.json`](iam/write-policy.json). Replace `<account-id>`, `<agent-space-arn>`, `<principal-arn>` and `<external-id>` first.
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

## Files in `docs/iam/`

| File | What it is |
|---|---|
| [`read-policy.json`](iam/read-policy.json) | Permissions for the read role, or for your profile's identity when you use no roles |
| [`write-policy.json`](iam/write-policy.json) | Permissions for the write role, or for your profile's identity when you apply plans without roles |
| [`trust-policy.json`](iam/trust-policy.json) | Trust policy for both roles |
| [`caller-policy.json`](iam/caller-policy.json) | Lets the principal assume the two roles. Needed only for a principal in another account |
| [`cloudformation.yaml`](iam/cloudformation.yaml) | Creates both roles from the documents above |

## Containers and AWS credentials

How the containers get credentials for your profile is in [Getting started](getting-started.md#aws-credentials-in-containers). With the AWS CLI installed, `./scripts/stack.sh up --profile <name>` gets credentials for any profile type (access keys, an assumed role, IAM Identity Center, `credential_process`) and keeps them renewed in the containers. The identity behind the profile needs the permissions in this guide, and nothing else changes for the containers.
