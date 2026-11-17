# Campus Policy Agent

> **Archive status:** research prototype. This repository preserves a general policy-question answering engine and synthetic examples.

A small, local-first JavaScript engine for retrieving text from Markdown knowledge cards, composing evidence-aware answers, and marking uncertainty. It was separated from a course project so this public snapshot contains no course records, official policy documents, screenshots, private prompts, or private benchmark materials.

## Included

- Zero-dependency ESM retrieval and answer-composition modules
- Command-line interface
- Two invented Markdown examples under examples/knowledge/

## Run

Requires Node.js 20 or newer.

~~~sh
node engine/cli.mjs stats
node engine/cli.mjs ask "When is the fictional learning room open?"
~~~

Supply a different Markdown knowledge directory with --kb <directory>.

## Boundaries

The bundled documents are fabricated software examples, not official policy. This archive has no institutional affiliation, no course datasets, and no production service. The HTTP server and private source materials are omitted. Answers from a real knowledge base still require current authoritative sources and human review.

No API credentials are included. Optional model integrations must be configured locally through environment variables.

## License

Source code is licensed under AGPL-3.0-only. See [LICENSE](LICENSE).
