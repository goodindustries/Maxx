# Integration Plan For Token Usage Tracking

## Goal

Build the smallest integration stack that can reliably answer:

- how many tokens were used
- which model was used
- when the session happened
- how much it cost
- whether the workflow is getting noisy or inefficient

The integrations should support observability first. They should not try to control the user’s workflows.

## Integration Principles

- Prefer provider usage APIs over inferred estimates.
- Treat missing provider fields as `estimated` or `unavailable`, never as fact.
- Keep secrets server-side.
- Use read-only scopes wherever possible.
- Separate direct provider data from local telemetry and UI-derived inference.
- Make each connector independently degradable so one source can fail without breaking the dashboard.

## Feasibility Snapshot

### OpenAI

Feasible for MVP:

- organization-level usage data
- token counts
- model names
- request counts
- project, user, and API-key grouping
- separate cost data from the Costs endpoint

What it does not give us directly:

- per-session conversation structure
- prompt or completion text
- thread-level context history

Implication:

- OpenAI is a real first-class source for token tracking, but session reconstruction will be our own inference layer. The usage endpoint is aggregated into time buckets and grouped dimensions, so anything session-like is an approximation.

### Anthropic

Feasible for MVP:

- organization-level usage data
- uncached input tokens
- cached input tokens
- cache creation tokens
- output tokens
- model, workspace, API-key, service-tier, and context-window grouping
- separate cost data from the cost endpoint

What it does not give us directly:

- individual account support on the Admin API
- per-session conversation structure
- prompt or completion text

Implication:

- Anthropic is also a solid first-class source, but only for organizations, not individual accounts. Like OpenAI, it gives us usage and cost, not true chat/session telemetry.

### Cursor

Feasible for MVP:

- team dashboard usage summaries
- usage analytics and reporting in the dashboard
- enterprise AI code tracking API for AI-generated code analytics

What it does not give us directly:

- a clearly documented public token-usage API for all plans
- prompt-level or chat-session-level telemetry
- general-purpose session usage records comparable to OpenAI or Anthropic

Implication:

- Cursor should be treated as a secondary connector. The documented API we found is enterprise-only and focused on code analytics, not token usage. That makes it useful for adjacent workflow signals, but not something we should depend on for the MVP token ledger.

### Bottom Line

- OpenAI: yes, usable now for token and cost tracking.
- Anthropic: yes, usable now for org-level token and cost tracking.
- Cursor: partial at best for our goal, and likely not a primary token source.
- Session-level understanding will need our own reconstruction layer on top of provider aggregates and local telemetry.

## Integration Stack

### 1. App Core

Purpose:

- user auth
- workspace/account linking
- provider connection status
- sync scheduling
- normalized storage for usage events and sessions

Required pieces:

- authentication layer
- account connection records
- provider credential storage
- background sync jobs
- ingestion logs
- normalized usage tables

This layer is the foundation for every later integration.

### 2. OpenAI Usage Integration

Purpose:

- import token usage and cost-adjacent metadata from OpenAI accounts

What we need:

- provider account connection
- API credential or OAuth equivalent if supported
- usage sync job
- model identifier capture
- session timestamp capture
- total/input/output token capture when available

What we should expect:

- strong token and model data for supported API usage
- some sessions may need aggregation into our own session model
- not every chat surface will expose the same granularity

MVP output:

- recent usage trends
- session detail rows
- estimated spend

### 3. Anthropic Usage Integration

Purpose:

- import token usage and model metadata from Anthropic accounts

What we need:

- provider account connection
- supported API credentials
- usage sync job
- request/session timestamp capture
- input/output token capture when available
- model identifier capture

What we should expect:

- reliable usage visibility for supported API traffic
- possible gaps around thread-level reconstruction

MVP output:

- token totals
- provider/model mix
- session grouping where timestamps allow it

### 4. Cursor Telemetry Integration

Purpose:

- capture local IDE usage signals that help explain context growth and retry behavior

Likely shape:

- browser extension if the source is web-based
- desktop telemetry if an existing local path is available
- light client-side event relay if no direct API exists

What we need:

- last active time
- model selection
- request count
- approximate turn count
- local session boundaries when available

Risk:

- telemetry may be partial or unavailable depending on the path available from Cursor
- this should not block the rest of the product

MVP rule:

- treat Cursor as a separate feasibility track until we confirm a stable telemetry source

### 5. Optional Local Model Telemetry

Purpose:

- include usage from local or self-hosted models when available

Possible sources:

- gateway logs
- local proxy
- desktop client telemetry

What we need:

- model name
- prompt and completion token counts
- timestamp
- session or request identifier

MVP rule:

- support this only if the data path is already easy and read-only
- do not introduce a complex local gateway just to make the dashboard look more complete

### 6. Session Reconstruction Layer

Purpose:

- turn provider events into user-readable sessions

Inputs:

- provider events
- timestamps
- model switches
- retry clusters
- task coherence signals

Outputs:

- session duration
- total tokens
- input tokens
- output tokens
- cost estimate
- model distribution
- retry count
- context growth estimate

### 7. Coaching And Health Scoring

Purpose:

- interpret token usage in operational terms

Inputs:

- session shape
- token growth
- retry patterns
- model choice
- context drift indicators

Outputs:

- coaching feed items
- session health labels
- explanation fields for each signal

This layer should remain downstream of ingestion. It must never be required to make the raw usage data work.

## Build Order

### Phase 1: Core Platform

- auth
- workspace model
- provider connection records
- background sync framework
- normalized usage tables

### Phase 2: Primary Provider APIs

- OpenAI usage integration
- Anthropic usage integration
- cost estimation
- session grouping

### Phase 3: Secondary Telemetry

- Cursor telemetry feasibility spike
- local model telemetry if low friction
- partial or estimated data labeling

### Phase 4: Productization

- dashboard cards
- session inspector
- coaching feed
- health score
- connection health UI

## Data Fields To Normalize

Minimum shared schema:

- provider
- account_id
- workspace_id
- model
- session_id
- request_id
- start_time
- end_time
- input_tokens
- output_tokens
- total_tokens
- cost_estimate
- source
- confidence
- raw_metadata pointer

Optional fields:

- thread_id
- conversation_id
- branch_id
- retry_group_id
- context_length
- context_growth
- prompt_type
- task_category

## Failure Handling

- If a sync fails, preserve the last good dataset and surface the failure in the UI.
- If a provider lacks a field, store `null` plus a confidence label.
- If the session boundary is uncertain, mark it as inferred.
- If a connector becomes unavailable, the dashboard should still show the other providers.

## What Not To Build Yet

- unified AI gateway
- automatic prompt rewriting
- memory systems
- autonomous routing
- IDE replacement
- chat replacement
- custom model hosting

Those belong after the product has real usage and trusted telemetry.
