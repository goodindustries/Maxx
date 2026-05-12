# Maxx Prompt Pipeline

Maxx now treats prompt cleanup as a pipeline instead of one opaque function.

## Stages

1. Text normalization
2. Sentence cleanup
3. Grammar correction
4. Condensing
5. Embedding
6. Intent classification
7. Template selection
8. Prompt reconstruction
9. Quality scoring
10. Fallback question when confidence is low

## Default Behavior

The server and CLI work without any external services.
They use deterministic JS cleanup and a local embedding fallback so the prototype stays light and private.

## Optional External Services

- `MAXX_LANGUAGE_TOOL_URL` for a LanguageTool-compatible grammar service
- `MAXX_EMBEDDING_URL` for a sentence-transformers embedding service
- `MAXX_EMBEDDING_MODEL=all-MiniLM-L6-v2` by default

## Intent Library

- write
- decide
- learn
- plan
- research
- create
- fix
- extract
- organize
- act

## Output

The CLI prints:

`now maxxed - "clean prompt"`

When confidence is low, Maxx also returns a follow-up question in the structured JSON response so the caller can ask for one missing detail instead of pretending certainty.
