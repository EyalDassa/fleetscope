## What and why
<!-- One or two sentences. Link the milestone / issue. -->

## Plan (tasks, owner, folders)
<!-- Paste the milestone plan from the tech lead. -->

## Non-obvious decisions
<!-- Explain choices you would want to be able to defend in an interview. Link ADRs. -->

## Data honesty check
- [ ] Simulated data is labeled `source: "sim"` and never shown as real
- [ ] Engine limitations are stored as `null` and shown as "not available"

## Checklist
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] Integration tests pass (`pnpm infra:up`, then `pnpm test:integration`) if the DB or API changed
- [ ] No secrets in the diff; `.env.example` updated if env vars changed
- [ ] QA report says "ready to merge" and the reviewer approved (see `qa/` and `reviews/`)

## Screenshots
<!-- UI changes only -->
