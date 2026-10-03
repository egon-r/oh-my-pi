Store ≥1 fact in long-term memory for future sessions.

Use: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.

{{#if globalScope}}`scope: global` stores an item in the shared bank every project recalls; reserve it for cross-project preferences and facts.
{{/if}}Each item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.

{{#if hindsight}}`tags` scopes each item in Hindsight; `context` is source text, NOT tags. Explicit nonempty tags replace (do not merge with) session defaults. Omitted tags use session defaults, or remain untagged when none exist. Banks with a scope guard can require tags; never omit the required scope in those banks. Tagged items use combined observation scope so all their tags stay together.
{{/if}}
