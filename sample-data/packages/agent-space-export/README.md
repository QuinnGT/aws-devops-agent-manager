# AnyCompany-Tickets-Sample: Agent Space export

A sample export of the Agent Space `AnyCompany-Tickets-Sample` (ID `00000000-0000-4000-8000-0000000000aa`) in the Agent Space folder layout. It holds the v2 instruction package as the space has it today, plus two custom agents and one older INACTIVE copy of the `cache-path-check` skill.

| Folder | What it holds |
|---|---|
| `agents_md/<agent>/` | The instructions of one agent type (`AGENTS.md`) and its `_asset.json` descriptor |
| `skill/<name>/` | One skill with its files and descriptor. `skill/cache-path-check.v1/` is the older INACTIVE copy of `cache-path-check` |
| `custom_agent/<name>/` | One custom agent (`<name>.md`) and its descriptor. Its `skills` are asset IDs of skills in this export |
| `memory/<store>/` | Memory stores in the package layout (`STORE.md`, `INDEX.md`, one file per memory). Memory has no descriptors |
| `INDEX.json` | Lists every asset folder. Checked against the folders and never uploaded |

Asset IDs look like `ki-00000000-0000-4000-8000-0000000001NN`. The descriptors carry the service's bookkeeping keys (`version`, `createdAt`, `updatedAt`, `creator`, `editor`), which the app drops on import.
