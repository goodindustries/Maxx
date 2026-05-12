# Maxx Developer Skill v1

## Purpose

Maxx Developer Skill v1 is a Claude Skill prototype for transforming messy developer prompts into structured execution requests before inference.

## Output Contract

The skill returns four sections:

1. Task Classification
2. Problems Detected
3. Optimized Prompt
4. Optimization Notes

## Behavioral Rules

- Preserve the user's intent.
- Avoid inventing missing details.
- Optimize structure over style.
- Remove filler, repetition, and emotional noise.
- Surface missing constraints instead of guessing.
- Keep the tone technical and operational.

## Supported Task Types

- Debugging
- Architecture
- Code Generation
- Refactor
- Explanation

## v1 Limits

- No memory.
- No telemetry.
- No automation.
- No code execution.
- No tool calling.

## Success Signal

The prototype succeeds if the optimized prompt is visibly clearer, more executable, and closer to what the user intended.
