# Review: fix-public-engine-rotation

Scope: `git diff main...fix-public-engine-rotation`: `assignPublic` in `apps/fleet-runner/src/assign.ts`, new tests in `apps/fleet-runner/src/public.test.ts`. Timeboxed quick review.

## What I checked

- **Bijection.** For fixed S sites and E engines, `p -> (site, engine)` with `site = p mod S`, `engine = (floor(p/S) + site) mod E` is invertible: given (site, engine), `q = (engine - site) mod E` and `p = q*S + site`. So every block of S*E consecutive ordinals hits every pair exactly once. I brute-forced S = 1..9, E = 1..6 with start ordinals 0, 1, -1, -17, 123456789, 9 999 999 999, MAX_SAFE_INTEGER - 100 and -2^40: 0 failures, all indices in range.
- **Negative ordinals.** `((o % n) + n) % n` normalises correctly. They can't actually happen: `--seed` is `^\d{1,10}$` and the random seed is in [0, 2^31).
- **Huge ordinals.** The largest seed is 9 999 999 999, far below 2^53, so `publicCounter.next++` stays exact. Past 2^53 `%` still returns an in-range integer, so you get no crash and no undefined index.
- **S = 1 / E = 1.** S = 1 gives one site that cycles through all engines. E = 1 gives the single engine. `sites.length === 0` throws as before. `engines.length === 0` would give `NaN` and an undefined engine, but `parseEngines` already rejects an empty `--engines` (options.ts:103), so it can't happen.
- **Paused sites (S changes between runs).** Each run reduces its ordinal modulo its own S*E, so the mapping is a bijection for the S of that run. With a random seed per run (live loop, `--public 1`) every pair currently active is equally likely. The bias of 2^31 mod 15 is negligible.
- **Tests catch the old bug.** I ran the old formula through the new tests' inputs. The "any block" test finds 5 distinct pairs, not 15. In the live-loop test, the seeds `0, 7, ...` (step 7 is coprime with 15) reach only 5 pairs under the old formula, and the per-site check sees 1 engine instead of 3. All three new assertions fail on `main` and pass here. The existing tests ("5 sessions mixed engines", "3x3 meets every pair") still pass with the new formula.
- **Callers.** `run.ts:119` is the only call site. It passes `activeSites()` and `publicCounter.next++`, and `main.ts:272` seeds the counter. Neither depends on which engine a given ordinal gets. No other code or test hard-codes the old (site, engine) order.
- **Tests:** `pnpm --filter ./apps/fleet-runner test`: 23 files passed, 1 skipped. 314 tests passed, 26 skipped.

## Findings

### R1: doc comment says neighbouring ordinals always move the engine. Nit, backend
`apps/fleet-runner/src/assign.ts:101`: "Neighbouring ordinals move both the site and the engine." This is false when the site index wraps from S-1 to 0 and S ≡ 2 (mod E). The engine then changes by `1 - (S-1) = 2 - S ≡ 0`. That is exactly the shipped 5 sites x 3 engines case: ordinals 4->5, 9->10 and 14->15 keep the same engine. For S = 1 the site never moves. Coverage is not affected; only the sentence is wrong.
Fix: reword to "Neighbouring ordinals usually move both the site and the engine", or drop the sentence.

### R2: "whenever sites + 1 shared a factor with engines" overstates the old bug. Nit, backend
`apps/fleet-runner/src/assign.ts:102-103`. Under the old formula the engine for site r is `((S+1)q + r) mod E`. Each site is pinned to a single engine only when E divides S+1, as with 5 and 3. When they only share a factor (S = 3, E = 4) each site is restricted to a subset of the engines, not pinned to one.
Fix: "tied each site to one engine whenever engines divided sites + 1 (5 sites, 3 engines), and to a subset of them whenever the two shared a factor."

### R3: within one batch with `--public > 1` the site list shrinks between picks. Note, unsure it matters, no action needed
`run.ts:118` takes `activeSites()`, which excludes busy sites, so consecutive ordinals in one batch use S, S-1, ... The per-block bijection then only holds across batches for the first pick. This was the same on `main`, so it is not a regression. The live loop uses `--public 1`, where it doesn't apply. Mention it in the PR description if anyone relies on the "every block" property for `traffic --public N`.

## Verdict

**Approve with nits.** The fix is correct for any S ≥ 1 and E ≥ 1. The tests would have caught the old bug, and nothing else depends on the old order. R1 and R2 are comment wording only.
