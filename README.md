# Maxx

Maxx is now a Claude skill prototype for real-time prompt optimization.

The current prototype validates one thing:

Structured prompt transformation materially improves AI workflow quality before inference.

## Planning

- [Developer Skill v1](docs/developer-skill-v1.md)
- [Prompt pipeline](docs/prompt-pipeline.md)

## Local Run

- `npm start`

## CLI

- `npm link`
- `maxx "your prompt here"`
- `printf 'your prompt here' | maxx`
- `maxx --json --language TypeScript --repo-type app --model-type Claude "your prompt here"`
