This is a read-only review task for an audit tool. Do not create, update or delete any memories, memory stores, skills, instructions or other knowledge, and do not run actions against infrastructure. Do not start background research tasks or hand work to other agents. Everything you need is in this message and the two attached files.

The attached files are named {{brief_file}} and {{records_file}}. The instructions below call them `brief.md` and `records.md`: `brief.md` is the attached file {{brief_file}}, and `records.md` is the attached file {{records_file}}. `schema.json` is the JSON Schema at the end of this message. Read both attached files in full before you answer.

<reviewer_instructions>
{{system_prompt}}
</reviewer_instructions>

<output_schema>
{{schema}}
</output_schema>

Reply with one JSON object that matches the output schema, and nothing else: no text before or after it and no markdown fence, because the app parses your reply as data. Your reply is the answer to this review, so do not save it anywhere.
