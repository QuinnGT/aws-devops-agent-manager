# Journal markdown templates

These files render each cached investigation as one markdown file in a journal export. A customer's history repository can override any file in its own `policy/journal-templates/`.

The defaults reproduce the record-created export format:

```
# Journal Log: INCIDENT-20201


---
## Record: mitigation_summary_md
**Created:** 2026-10-12 18:36:05.759000+00:00

...
```

## How a file is assembled

1. `_document.md` is the whole file. `{{records}}` is replaced by every rendered record, in the order set by `markdown.order` in `journals.yaml` (newest first by default). Record types in `markdown.skipRecordTypes` are left out of the markdown and kept in the raw JSON.
2. `_record.md` is the frame around each record. `{{body}}` is replaced by the record's body template.
3. The body template is the first file that exists of `<recordType>.<kind>.md`, `<recordType>.md`, `_default.<kind>.md` and `_default.md`. `kind` is `json` when the record content is JSON, `text` when it is plain text, and `markdown` for records imported from a markdown file.
4. For JSON message records, `{{parts}}` is each item of `content.content` rendered with `_part.<type>.md` (or `_part.default.md`), joined by `markdown.partSeparator`.

## Rules

- Templates are logic-less. A placeholder is `{{path}}` or `{{path|filter}}`; there are no conditionals, loops or code. The app never runs anything from a template.
- The file's final newline is not part of the template. To end a template with a newline, end the file with a blank line.
- Names starting with `_` are reserved for these app templates; record types never map to them.

## Placeholders

Document: `incidentId` (the task ID when no incident ID is known), `taskId`, `title`, `status`, `taskType`, `priority`, `createdAt`, `executionCount`, `recordCount`, `records`.

Record and body: `recordType`, `recordId`, `executionId`, `taskId`, `seq`, `createdAt`, `kind`, `text` (plain-text content), `role`, `content` (parsed JSON content, so `content.title` works), `parts`, and in the frame `body`.

Message part: `part` (the content item, so `part.text`, `part.tool_name`, `part.input`), `type`, `index`.

## Filters

`json`, `json-ascii` (non-ASCII escaped, like Python's `json.dumps(indent=2)`), `length`, `python-datetime`, `iso`, `hashes`, `join-text`, `truncate:N` (adds `markdown.truncationNotice`), `ui-tree` (renders a `ui_investigation_summary` tree with the `uiTree` settings).
