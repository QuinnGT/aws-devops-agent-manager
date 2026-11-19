# Review files for {{incident_id}}

DevOps Agent Manager prepared these files for the audit "{{audit_name}}" ({{profile_label}}). They hold one investigation. An agent that can read and write files, such as the Kiro CLI or Claude Code, reads them and writes the review. You then import the review into the app, where a person accepts, edits or rejects each finding.

## The files

- `system.md`: the reviewer's instructions.
- `brief.md`: the brief for this investigation: the questions to answer, the ground truth, measurements the app computed, and a condensed trace of the journal.
- `records.md`: every record of the investigation's journal, each under a heading `## R<n> <TYPE> <UTC time>`. R<n> is the record number the review cites.
- `schema.json`: the JSON Schema the review must match.
- `manifest.json`: which audit, investigation and journal version these files were made from. Do not edit it. The app uses it to refuse a review that was made from an older version of the journal.
- `review.json`: the review. It does not exist yet. The agent writes it.

## Run it

Start the agent in this folder and give it this prompt:

> Read README.md, then system.md, brief.md, records.md and schema.json in this folder. Follow system.md and brief.md. Write your review as one JSON object that matches schema.json, and save it as review.json in this folder. Do not change any other file.

The review is one JSON object and nothing else, with no markdown fence. Quotes in it must be copied exactly from records.md, because the app checks each one against the journal.

## Before you send these files anywhere

The files contain journal text from your company's systems: what the agent read, what people wrote to it, and the output of its tools. They can hold customer data, internal names and account details. Give them only to a tool and a model your company has approved for that data. Do not paste them into a service you have not checked.

## Import the review

Open the audit in DevOps Agent Manager. To import one review, open this investigation and choose Import review, then select review.json. To import many, zip the investigation folders (each with its review.json and manifest.json) and import the zip from the audit's Investigations tab. Type a reviewer label that says who or what wrote the review, for example "Claude Code, Opus 5.5". The label is shown with the review.

The app refuses a review that does not match schema.json or that was made from files of another audit or an older journal, and says why. Quotes that cannot be found in the records are not refused: the app flags the findings that rely on them for a person to check.
