# Minion Insights MVP Milestones

## Product Wedge

Minion Insights is an observability and coaching layer for AI power users. The MVP should help a user connect at least one AI account, see recent workflow patterns, and receive concise operational insight within five minutes.

The wedge is not orchestration, automation, prompt rewriting, or a new chat surface. Every milestone should preserve the core behavior: observe workflow entropy, explain it clearly, and coach the user toward cleaner AI work.

## Milestone 0: Scope Lock

Goal: freeze the MVP boundary before implementation work expands.

Deliverables:

- Final MVP scope statement.
- Explicit non-goals list in the product docs.
- Initial event taxonomy for AI usage and sessions.
- Definition of a "session" across providers.
- First-pass health score dimensions and labels.

Acceptance criteria:

- The product can be explained as "AI workflow observability plus coaching" in one sentence.
- No requirement depends on agent execution, memory automation, IDE replacement, or prompt rewriting.
- The team can say which telemetry fields are required, optional, and unavailable for each planned integration.

## Milestone 1: Data Foundation

Goal: ingest and normalize enough account data to power a useful first dashboard.

Deliverables:

- User auth and workspace/account model.
- Read-only OpenAI connection.
- Read-only Anthropic connection if the usage API is available for the target accounts.
- Provider usage sync jobs.
- Normalized tables for providers, models, usage events, sessions, and cost estimates.
- Basic ingestion status and error visibility.

Acceptance criteria:

- A connected user sees recent usage, model distribution, and estimated spend.
- Failed provider syncs show actionable status instead of silent failure.
- No provider credentials are exposed to the frontend or committed to source control.

## Milestone 2: Session Reconstruction

Goal: turn raw usage into coherent sessions that users can inspect.

Deliverables:

- Session grouping logic based on time, source, provider, model, and available thread metadata.
- Session duration, input tokens, output tokens, total tokens, cost estimate, model switches, and output/input ratio.
- Context growth approximation where provider data permits it.
- Retry candidate detection based on repeated requests close together in time.
- Session list and session detail API endpoints.

Acceptance criteria:

- A user can open a session and understand what happened without reading raw logs.
- The system distinguishes normal iteration from obvious repeated retry clusters.
- Missing provider fields degrade gracefully and are labeled as estimated or unavailable.

## Milestone 3: First Dashboard

Goal: make value visible immediately after connection.

Deliverables:

- Dashboard with spend trends, model distribution, session health summary, and top inefficiency patterns.
- Connection empty states and post-connection loading states.
- Time filters for recent usage.
- Basic charts for token and cost trends.

Acceptance criteria:

- A new user gets a useful dashboard within five minutes of a successful connection.
- The dashboard emphasizes workflow patterns, not just cost totals.
- The UI stays quiet and operational: no gamification, streaks, or productivity-guru copy.

## Milestone 4: Detection Heuristics

Goal: ship transparent, conservative signals before advanced recommendations.

Deliverables:

- Recursive loop detection using semantic similarity or conservative text fingerprints where content is available.
- Context drift detection using context growth versus progress proxies.
- Oversized model detection using task/category heuristics and model cost tiers.
- Retry friction detection based on repeated attempts before a likely completion.
- Context pollution detection where stale or inactive context can be inferred.
- Confidence score and evidence fields for every detected event.

Acceptance criteria:

- Every coaching event is traceable to observable evidence.
- Low-confidence detections are hidden or labeled cautiously.
- The system avoids claiming intent when it can only observe behavior.

## Milestone 5: Coaching Feed

Goal: convert detections into concise operational guidance.

Deliverables:

- Chronological coaching feed.
- Session-level coaching events.
- Dashboard-level aggregate insights.
- Copy style guide for calm, high-signal observations.
- Feedback controls such as useful, not useful, and dismiss.

Acceptance criteria:

- Coaching messages are short, specific, and operational.
- Messages prioritize observation before prescription.
- Example output matches the PRD tone: "Session drift increasing," "Repeated semantic retry loop," "Branch recommended."
- User feedback is stored for later calibration.

## Milestone 6: Session Health Score

Goal: provide a simple composite readout without hiding the underlying evidence.

Deliverables:

- Health score model using context relevance, retry patterns, routing efficiency, context growth rate, and task coherence.
- Health labels: Healthy, Degrading, Chaotic, Recursive.
- Session Inspector explanation of score drivers.
- Dashboard aggregate health distribution.

Acceptance criteria:

- Users can see why a session received its label.
- Health score does not collapse into "cheap is good, expensive is bad."
- Edge cases with sparse data fall back to "insufficient signal" instead of false certainty.

## Milestone 7: MVP Hardening And Launch

Goal: make the product reliable enough for early power users.

Deliverables:

- Onboarding checklist from account connection to first insight.
- Privacy and data retention settings.
- Provider reconnect and token refresh handling.
- Basic billing or access control if needed for launch.
- Instrumentation for product success metrics.
- Launch cohort feedback loop.

Acceptance criteria:

- Early users can connect accounts, inspect sessions, and review coaching without manual support.
- Success metrics are captured: daily active usage, dashboard opens, session inspections, and coaching interactions.
- Known provider limitations are documented inside the product or onboarding flow.

## Post-MVP Guardrails

Do not add these until the MVP has repeat usage and enough feedback data:

- Agent orchestration.
- Autonomous task execution.
- Automatic prompt rewriting.
- Memory engine.
- Workflow automation.
- IDE replacement.
- Chat interface.
- Enterprise collaboration.

Future expansion should be driven by observed user behavior, especially repeated coaching patterns that users consistently accept or act on.

## PRD Tightening Notes

- The PRD is correctly disciplined around the wedge: observability plus coaching.
- The biggest missing detail is telemetry feasibility. Cursor, Claude Code, and provider APIs may expose different levels of content, cost, and session metadata, so the MVP should classify each signal as confirmed, estimated, or unavailable.
- "Semantic similarity" and "low signal density" can become expensive or privacy-sensitive. The MVP should start with conservative heuristics and store evidence summaries, not unnecessary raw content.
- "Session health" should be explainable. A black-box score would undermine trust before the product earns it.
- Cursor integration should be treated as a separate feasibility spike unless a stable telemetry path is already known.
