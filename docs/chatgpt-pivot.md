# ChatGPT Pivot

Maxx is now being shaped as a ChatGPT app backend rather than a standalone OpenAI login screen.

## What OAuth Means Here

The OAuth flow is for ChatGPT signing into Maxx, not for OpenAI to sign into Maxx.
That is the supported path for GPT Actions and ChatGPT apps.

## Where Token Usage Comes From

Token usage still comes from OpenAI org usage APIs.
That requires an OpenAI API/admin key connected to Maxx and synced server-side.

This means:

- ChatGPT OAuth gives us the app login surface
- OpenAI org usage APIs give us the token and cost data
- Maxx combines them into a single coaching experience

## Current Backend Surface

- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /api/usage/summary`
- `POST /api/openai/connect`
- `POST /api/brain/optimize`

## Product Shape

The end-user surface becomes a ChatGPT app or GPT Action.
The web UI stays useful as a local admin/debug surface for usage sync and prompt coaching.
