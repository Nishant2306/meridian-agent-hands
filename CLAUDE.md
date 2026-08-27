# CLAUDE.md - Project Constitution & Working Agreement

This file is the durable contract for this build. It is read at the start of every session and
updated at the end of every phase. If anything below conflicts with a phase prompt, **stop and ask**.

---

## 1. HARD RULES

1. **NEVER** `git commit`, `git push`, `git checkout -b`. `git init` and `.gitignore` only.
2. **NEVER** put secrets, API keys, or real PII in any file. `.env.example` only; `.env` is gitignored.
3. **NEVER** fabricate run evidence. Documentation is fine (including an `/evidence/README.md`
   template). Never author anything purporting to be the output of a real LLM run, replay, or log.
4. **NEVER** call the Anthropic API. The user runs every paid call.
5. **Ask** before adding a dependency not named in the phase prompt.
6. TypeScript strict. No `any` in exported signatures.
7. **BUILD ORDER IS VERTICAL.** Do not build ahead. If a phase surfaces work that belongs to a later
   phase, note it in this file and move on.
8. `[MUST]` items are non-negotiable. If one appears wrong, **STOP and tell the user** before
   implementing it.

---

## 2. WHAT WE ARE BUILDING

The backend layer that gives an AI agent "hands" inside legacy banking software with no API.

- **DISCOVERY** - an LLM drives a live UI (observe → decide → act) until a natural-language goal is met.
- **ARTIFACT** - the successful run is distilled into a typed, versioned, parameterized capability.
- **REPLAY** - that artifact re-executes deterministically with **no LLM in the decision loop**.

Cross-cutting: safety guardrails, evidence, and a real human handoff that transfers control of the
**same live session** and takes it back.

### Through-line

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the
> AI agent invokes it in production.

---

## 3. NON-NEGOTIABLE DESIGN COMMITMENTS

- Perception is **accessibility-first** (role, accessible name, nearby text). Not AX-only - we fall
  back where the AX tree is thin - but **never CSS selectors**.
- The LLM **never authors selectors**. It selects from a numbered inventory of perceived controls,
  and those numbers **never reach the artifact**.
- The LLM discovers **how to operate the UI**. It does **not** invent the business contract: types,
  sensitivity, outputs, record identity, and known conditions are **declared by a human**.
- Completion is **proposed by the model and declared by the system** after independent
  re-observation. The same rule binds the human operator.
- Replay makes **zero LLM calls**, proven architecturally (the replay package does not import the
  LLM package).
- Business outcomes and errors are **separate type hierarchies**. There is no `RECORD_NOT_FOUND`
  error.
- Only **one actor** may issue software actions at a time, enforced by **lease tokens**.

### Watch for PARALLEL ABSTRACTIONS

There is **ONE `TargetResolver`** and **ONE input path (`resolveAndPerform`)**. A second resolver, a
second policy path, or a replay-only locator implementation is a defect. If the design seems to want
one, **stop and tell the user**.

---

## 4. HONESTY COMMITMENTS (stated plainly in `REPORT.md`)

- A web-recorded artifact does **not** replay unchanged on a desktop app. The capability **contract**
  is surface-independent; **locator hints are adapter-specific**.
- The lease enforces mutual exclusion for **software-issued** actions and coordinates the
  pause/cede/resume protocol. In the headed-browser transport, **direct OS input is out of band**.
- Atomic resolve-and-act **minimizes** the resolution/action race; it does **not** eliminate it. Any
  UI may mutate between internal resolution and the input event, so we revalidate immediately before
  acting.
- Without OCR we **cannot** prove a sensitive value is absent from screenshot pixels. We mask
  declared sensitive regions **by box** and scope the claim accordingly.
- Everything stubbed or mocked is **disclosed** in `README.md` and `REPORT.md`.

---

## 5. IMPLEMENTATION CLARIFICATIONS (VERBATIM)

> The five clarifications below are reproduced verbatim from the constitution. Do not paraphrase,
> compress, or "improve" them.

```text
1. PROFILE HASH LIFECYCLE [MUST - a correctness rule, not a convention]
   The condition profile and safety profile are pinned by { id, version, sha256 }. Those hashes are
   SEMANTIC content, not approval metadata, so they must be present before the content hash is ever
   computed.
     PHASE 3       - write the FINAL versioned profile YAML files. They do not change afterwards.
     DISTILLATION  - load the profiles, compute their SHA-256, write the hashes into the DRAFT
                     artifact, then compute the artifact content hash.
     APPROVAL      - RECOMPUTE and VERIFY the pinned hashes. Verify the artifact. Change ONLY
                     `status`, `approvedAt`, `approvedBy`. Never add or modify semantic content.
     REPLAY        - verify the pinned hashes again → PROFILE_INTEGRITY_FAILURE on mismatch.
   contentHash(artifact) excludes ONLY status/approvedAt/approvedBy. It INCLUDES the profile hashes.
   `capability:approve` VERIFIES pins; it does not introduce them.

2. STALE PROPOSAL REJECTION USES SCREEN CONTEXT, NOT JUST RESOLUTION
   Re-resolving a descriptor does not by itself catch a page change: a different screen may also
   contain a button named "Continue" or "Search". Before resolving a converted proposal, check
   isCompatibleScreenContext(sourceObservation, freshObservation) over screen identity, canonical
   screen name, and context/frame path. Incompatible → reject with STALE_OBSERVATION_CONTEXT,
   re-observe, continue the loop.

3. FIXTURE FORM CONTROLS START NEUTRAL
   Account type defaults to a placeholder ("Select an account type"); nickname and initial deposit
   start empty. If the form pre-selects Savings, then selecting Savings changes nothing, the step
   has no discriminating effect, and the distiller correctly rejects it - while you waste an hour
   debugging the agent instead of the fixture.

4. NO goalDigest
   provenance stores goalTemplate and discoveryRunId only. A plain SHA-256 of a rendered goal is
   brute-forceable: 100,000 five-digit member IDs against a known template is seconds of work.
   Traceability is already covered by discoveryRunId, specHash, the artifact content hash, model and
   promptVersion, and the discovery evidence.

5. BOOTSTRAP SAFETY POLICY IS ACTIVE BEFORE THE FIRST REAL LLM RUN
   Gate 1 runs a real model against a live UI at the end of PHASE 5, but the full policy engine is
   PHASE 7. The first genuine discovery must not rely on the prompt alone to prevent an irreversible
   action. From PHASE 2 onward, resolveAndPerform enforces a hardcoded minimum:
     allowed origin  - the single configured local fixture origin only
     allowed actions - navigate, click, type, select, read
     always blocked  - a resolved control whose name matches the irreversible patterns
                       (e.g. "Submit Request"), and any navigation outside the fixture origin
   PHASE 7 replaces this with the configurable engine. The minimum is never absent.
```

---

## 6. HOW THE BUILD IS DRIVEN

- The user pastes **the constitution plus ONE phase at a time**.
- Do **not** look ahead or build for later phases.
- After each phase: **run typecheck and tests**, **update the status checklist in this file**, and
  **STOP**.
- The user inspects the output before the next phase.

---

## 7. STACK (LOCKED)

TypeScript · Node 20+ · ESM · `tsx` · `vitest` · `zod` · `playwright` (Chromium; **action transport
only**) · `@anthropic-ai/sdk` (model from env) · `express` · `pino` · `commander` · `yaml`.

Anything not on this list requires asking first (Hard Rule 5).

---

## 8. REPOSITORY LAYOUT

```
/src
  /types        typed domain model; business outcomes vs. errors as SEPARATE hierarchies
  /config       env + configuration loading
  /surface      surface adapters (browser transport); adapter-specific locator hints
  /perception   accessibility-first observation → numbered control inventory
  /session      live session lifecycle, lease tokens, single-actor enforcement
  /artifact     capability schema, distillation, content hashing, approval
  /agent        discovery loop (observe → decide → act); the ONLY package that talks to the LLM
  /replay       deterministic re-execution; MUST NOT import /agent or the LLM SDK
  /policy       safety policy engine (PHASE 7); bootstrap minimum lives in the input path
  /redaction    BOTH halves of sensitivity handling:
                (a) persistence pseudonymization - logs, transcripts, evidence, CLI output
                (b) declared-box screenshot masking
                Masking alone is not redaction: a value scrubbed from a screenshot but written
                verbatim into a log has not been protected.
  /escalation   human handoff: pause / cede / resume on the SAME live session
  /evidence     run evidence capture and writing
  /cli          commander entry points
/fixtures/legacy-app   the local fixture UI standing in for the legacy banking app
/config                versioned condition + safety profile YAML (final as of PHASE 3)
/examples/artifacts    TRACKED example capability artifacts
/tests                 vitest suites
/docs                  design notes (INTERVIEW_PREP.md is gitignored)
/evidence              evidence output + README template
/scripts               dev/utility scripts
```

Run outputs (`/runs`, `/artifacts`, `traces`, `*.log`) are gitignored. `/examples/artifacts` is
tracked - the `/artifacts` ignore pattern is root-anchored and does not reach it.

---

## 9. PHASE STATUS CHECKLIST (0–12)

The real phase map, supplied by the user after PHASE 0. **Knowing the map is fine; building ahead of
the pasted phase is not** (Hard Rule 7).

| Phase | Scope                                                                                                                                       | Status                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 0     | Constitution, directory scaffold, `CLAUDE.md`, `.gitignore`, `git init`                                                                     | ✅ Complete                |
| 1     | Scaffold + types + DiscoverySpec + target app                                                                                               | ✅ Complete                |
| 2     | Surface / perception / lease - `resolveAndPerform` exists and enforces the **bootstrap safety minimum** from here onward                    | ✅ Complete                |
| 3     | Artifact schema + profiles + store - the **final versioned condition + safety profile YAML** is written here and does not change afterwards | ✅ Complete                |
| 4     | Discovery + distiller - uses a scripted fake LLM client for tests                                                                           | ✅ Complete                |
| 5     | Replay - **GATE 1**: a real model against a live UI at the end of this phase. Also the replay import-boundary scan                          | ✅ Complete, GATE 1 PASSED |
| 6     | Runtime outcomes - business outcomes, known conditions, fault injection in the fixture                                                      | ✅ Complete                |
| 7     | Safety - the configurable engine runs ALONGSIDE the bootstrap minimum, which stays                                                          | ✅ Complete                |
| 8     | Human handoff - **GATE 2**                                                                                                                  | ✅ Complete                |
| 9     | Tests                                                                                                                                       | ⬜ Not started             |
| 10    | Evidence + README + REPORT - **GATE 3**                                                                                                     | ⬜ Not started             |
| 11    | Cross-tenant                                                                                                                                | ⬜ Not started             |
| 12    | Polish                                                                                                                                      | ⬜ Not started             |

### Companion documents

- `docs/STATUS.md` - what is built, how it works, and how to verify it. Updated every phase.
- `docs/SCHEMA.md` - the annotated capability artifact. Hand-written, and machine-checked.
- `docs/DATA_HANDLING.md` - what is stored, pseudonymized, masked, never captured, and an
  explicit LIMITS section for what it does NOT protect.
- `DECISIONS.md` - the calls that could reasonably have gone the other way. Appended every phase.

### Deferred work (noted, not built - Hard Rule 7)

- **GATE 1 PASSED.** Discovery 8 steps / 10 model calls; replay on member 10002 against a freshly
  seeded fixture, 1.8s, `llmCalls: 0`. It also leaked a member id and name into model-authored
  prose, which the parameterization sweep now refuses. See DECISIONS.md D39 and D40.
- **`semanticKey`** exists on `TargetDescriptor` but is unused until PHASE 11. It is present now only
  so that cross-tenant support is not a schema retrofit against artifacts that already exist and are
  already content-hashed.
- **`tenants/tenant-b.ts`** is a documented TODO for PHASE 11.
- **[MUST] ORDERING HAZARD - THE PROFILES ARE NOW IMMUTABLE.** `config/condition-profiles/` and
  `config/safety-profiles/` were finalized in PHASE 3. Their SHA-256 is pinned into every artifact
  and forms part of the artifact content hash, so ANY edit - including editing a comment -
  invalidates every pinned hash and every artifact that referenced them, and replay refuses to run
  with PROFILE_INTEGRITY_FAILURE. **The screens their detectors match arrive in PHASE 6, so PHASE 6
  MUST MAKE THE FIXTURE TEXT MATCH THE PROFILE, NOT THE REVERSE.** The exact strings are reproduced
  in `fixtures/legacy-app/README.md` under "PHASE 6 FIXTURE CONTRACT". If they drift, the temptation
  after GATE 1 will be to "just fix the profile"; do not. A change means a new version file.
- **Deferred artifact fields** (listed in `docs/SCHEMA.md`, not built, and each needs a
  `schemaVersion` bump): tenant overrides, locator stability scores, automatic demotion, an evidence
  policy, and any approval workflow beyond a single status flip.
- ~~A step bound to an OPTIONAL parameter needs a replay skip rule~~ - DONE in PHASE 5 as
  `Step.when`, which bumped the artifact to `schemaVersion: 2`. See DECISIONS.md D16 and D28.
- **A pseudonymizer for read-only sensitive nodes** at the model boundary is written up in
  `docs/DATA_HANDLING.md` and not built. Rule 3 forbids blind substitution, and doing it properly changes
  what the model sees on every screen; doing that before GATE 1 would mean the first real discovery
  run was driven against a view nobody had validated.
- **`read_value` binds an output and emits no step**, so the distiller's read-step exemption is
  tested directly rather than by the happy path. See DECISIONS.md D19.
- **Materializing the effective detector set and the global policy hash into run evidence** has its
  helpers; a runner wires them in from PHASE 4 onward.
- ~~A tier downgrade is computed and propagated but never asserted end to end~~ - DONE in PHASE 6.
  `tests/replay.downgrade.live.test.ts` drives a real replay against a drifted screen and asserts the
  downgrade lands in the step result, the evidence file and `metrics.locatorTierDowngrades`, with a
  negative control. See DECISIONS.md D47.
- **The async status API** for `needs_human` is deliberately not built - see the note at the bottom
  of `src/types/run.ts`.
- **`README.md` / `REPORT.md` / `/evidence/README.md`** are PHASE 10.
- `npm run test:fast` excludes `**/*.live.test.ts` (the browser-driven files) and nothing else.
  `npm test` remains the full run and is what a gate requires.
- `npm run distill:demo` runs the scripted fake client end to end and writes a real distilled
  artifact to the throwaway `artifacts-demo/`. No model is called, and the artifact's provenance
  says so.
- `npm run operator` still points at `scripts/not-implemented.ts` and exits 2 with the phase
  that builds it. `capability:approve` is real as of PHASE 3, `discover` as of PHASE 4, `replay`
  as of PHASE 5.

---

## 10. PHASE LOG

- **PHASE 0** - Created the directory tree, `.gitignore`, this file, and initialized an empty git
  repository. No feature code written. No dependencies installed. No commits made.

- **PHASE 1** - Scaffold, types, DiscoverySpec, target app.
  - **Scaffold**: `package.json` (ESM, `engines.node >= 20`), `tsconfig.json` (strict + NodeNext +
    `noUncheckedIndexedAccess`), `vitest.config.ts`, eslint flat config + prettier, `.env.example`
    with exactly the five mandated variables. Dependencies installed.
  - **Types** (`src/types/`): zod schemas with inferred types for `ControlRole`, `RiskClass` +
    `RISK_ORDER` + `maxRisk`, `TextMatcher` (no regex variant), `ValueBinding`, `Money` (minor units,
    never a float), `TargetDescriptor` (three-part split), `LocatorTier` (de-overlapped T1–T5),
    `SurfaceAction` (navigate is an action; no untargeted key press), `Assertion` (with
    `when.paramPresent`), the **two taxonomies** plus the separate `ProposalRejectionCode`,
    `RunResult`, `DiscoverySpec` / `DiscoveryInvocation`, and the
    Proposed / Recorded / Artifact action split.
  - **Typed comparison**: `value_matches_param` compares in the declared type's own space
    (`src/types/normalize.ts`), not by string.
  - **`specHash`**: SHA-256 of the canonical serialization of the parsed spec
    (`src/config/canonical.ts`, `src/config/spec.ts`).
  - **Spec**: `config/specs/prepare_subaccount_review.yaml`.
  - **Target app**: `fixtures/legacy-app/` - MERIDIAN Core Servicing, tenant-parameterized, iframes,
    no `data-testid`, left-`<td>` labels with a deliberate `<label for>` exception, ASP-stable
    `name=` attributes, per-boot randomized classes and ids with the seed exposed at
    `/__test__/seed`, neutral initial form state, and a real (never-to-be-pressed) `Submit Request`.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 60 passing.
  - **Decisions recorded**: `DECISIONS.md` D1–D8.

- **PHASE 2** - Surface, perception, lease.
  - **Two interfaces, one input path**: a pure read-only `TargetResolver` (no lease, because passive
    observation must not deadlock the handoff) and `Surface.resolveAndPerform`, the only way any
    software-issued action reaches the screen. The mandated eight-step sequence is implemented in
    that order, with the two PHASE 7 hook points named in place.
  - **Lease + session** (`src/session/`): one current lease, and issuing one invalidates the
    previous. Protocol violations throw; operational outcomes are returned. Illegal transitions
    throw, `COMPLETED` is reachable from `RESUME_VALIDATION`, and nothing lets a human declare
    success.
  - **Perception level 1** (`src/perception/`): one page-level CDP session, per-frame AX subtrees,
    DOM enrichment for nearbyText / `name=` / box, ephemeral markIds, a compact inventory with a
    documented truncation rule, `isCompatibleScreenContext`, and a degraded `aria_snapshot` fallback
    that is always recorded as such.
  - **Resolver cascade** (`src/perception/resolver.ts`): T1-T5, disambiguation, `AMBIGUOUS_CONTROL`
    rather than a guess, the conflict rule, and the tier-downgrade drift signal.
  - **Bootstrap safety minimum** (`src/surface/bootstrap-policy.ts`), active from this phase onward.
  - **Playwright adapter**: deterministic context, predicate polling only, every wait recorded.
  - **Evidence** (`src/evidence/logger.ts`): typed JSONL plus screenshots; secrets never written.
  - **Desktop stub** (`src/surface/desktop-stub.ts`): compiles, throws, and documents the real UI
    Automation call for every method.
  - **PHASE 1 rulings applied**: the fixture port moved into `TenantConfig`; em dashes removed
    project-wide.
  - **SPIKE (2H)**: `npm run inventory` walks the real happy path through the real input path and
    prints the inventory for every screen. It also writes the recorded observations that the
    browser-free resolver tests run against.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 112 passing.
  - **Decisions recorded**: `DECISIONS.md` D9-D13.

- **PHASE 3** - Artifact schema, profiles, store.
  - **Schema** (`src/artifact/schema.ts`): three separate versions with the reasoning in-file;
    `State` with screenAssertions / qualifiers / invariants and the resume-exclusivity rule; `Step`
    separating expected effects from invariants; `ArtifactOutput` sourced from a STATE rather than a
    step position; profile pins as semantic content; provenance with goalTemplate only and no
    goalDigest.
  - **THE FINAL PROFILES**, immutable from here: `config/condition-profiles/meridian-subaccount/`
    and `config/safety-profiles/banking-default/`. Patterns are phrases matched on whole words,
    never regex, because an over-permissive pattern in a safety profile fails OPEN.
  - **Layering** (`detectors.ts`, `policy.ts`): global engine + pinned profile + capability
    additions; effective policy is the strictest of every layer, and approval refuses a capability
    that declares anything weaker than the global ceiling.
  - **Hashing** (`hash.ts`, `approve.ts`): the content hash excludes only status/approvedAt/
    approvedBy and includes the pins, so the draft and the approved artifact hash identically.
  - **Store** (`store.ts`): `/artifacts/<id>/<version>.json`, refuses to overwrite a published
    version, and verifies the hash did not move across a status flip.
  - **CLI**: `npm run capability:approve -- <id>@<version> --by "<name>"`, repointed from the
    not-implemented stub. It prints both content hashes, so the identity property is visible rather
    than claimed.
  - **Docs**: `docs/SCHEMA.md`, hand-written and machine-checked; `docs/STATUS.md`, moved from the
    repository root.
  - **PHASE 1 fix**: the spec's profile ids were `meridian.core-servicing.*` and did not match the
    mandated profile paths. Corrected to `meridian-subaccount` and `banking-default`, which moved
    specHash. Nothing had been pinned against the old value.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 174 passing.
  - **Post-review correction**: the detector ladder now runs global safety, hard failures, known
    outcomes, recoveries, needs_human. Terminal states are evaluated before non-terminal
    remediation, because a recovery is an ACTION and we must never act on a run that is already
    decided. The demo in `docs/STATUS.md` was also repointed at a throwaway store, so it cannot
    leave a published version at the path discovery writes to at GATE 1.
  - **Decisions recorded**: `DECISIONS.md` D14-D18.

- **PHASE 4** - Discovery and the distiller. **No real model call was made.**
  - **Action space** (`src/agent/tools.ts`): mark ids only, no selector of any kind, `value` always
    a ValueBinding, no `press_key`.
  - **Conversion before acting** (`src/agent/proposal.ts`): the mandated six steps, including the
    screen-context staleness check that re-resolution alone cannot replace.
  - **Descriptor synthesis** (`src/agent/descriptors.ts`): interactive controls by accessible name,
    cells by their label, a PARAMETERIZED row key preferred whenever one exists, no ordinal
    fallback.
  - **Verified completion** (`src/agent/completion.ts`): a FRESH observation, every declared output
    extracted and validated against its declared type, and the record identity checked by the
    system.
  - **Model boundary** (`src/agent/boundary.ts`): secrets never sent, typed values shown as
    `[PARAM:name]`, inventory capped, no screenshots, and NO blind substitution over text the model
    read off the page. Written up in `docs/DATA_HANDLING.md`.
  - **Prompt** (`src/agent/prompts/v1.ts`), versioned, and deliberately silent about error states.
  - **Distiller** (`src/artifact/distill.ts`, `path.ts`, `parameterize.ts`): segment-based path
    reconstruction, the four-class parameterization sweep, states from observed screens, effects
    versus invariants, profile pins written BEFORE the content hash, and a reviewability lint.
    Fails closed throughout.
  - **CLI**: `npm run discover`, repointed from the not-implemented stub.
  - **Three real bugs found by tests, all silent**: a search classified as a no-op and deleted
    (D21), row-keyed descriptors discarded because parameters were unbound during validation (D23),
    and a literal-valued fill deriving no expected effect at all.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 209 passing (`npm run test:fast` 191 in ~5s).
  - **Decisions recorded**: `DECISIONS.md` D19-D23.

- **PHASE 5** - Replay. The end-to-end slice works; **GATE 1 has NOT been run.**
  - **No-LLM proof, three layers**: `ReplayDeps` has no client field; an import-boundary test walks
    the module graph from `src/replay/index.ts` and carries a NEGATIVE CONTROL; a provider-call
    COUNTER (never a mode flag) is snapshotted around every run and `metrics.llmCalls` asserted 0.
  - **SessionBroker**: authenticate via secret references, verify the precondition, hand over.
    Credentials stay out of the artifact; sign-on descriptors live in `src/config/sign-on.ts` and
    both CLIs share them.
  - **Execution order**: params, pins, fingerprint, preconditions, steps, success state. The first
    two reach a verdict before anything is observed, proven with a surface that throws if touched.
  - **Integrated observation loop**: detectors on EVERY pass, so MEMBER_NOT_FOUND returns a
    business outcome in 586ms instead of a ten-second TIMEOUT.
  - **Retry safety**: re-observe before any retry; if the effect already holds, do not repeat.
  - **Recoveries**: the real no-match path, falling through to failure. Not stubbed.
  - **CLI**: `npm run replay`, one JSON writer on stdout, exit codes 0 / 10 / 20 / 25 / 30.
  - **Addendum work**: D16 delivered as `Step.when` (schemaVersion 2); D26 closed by making rowKey
    a CONSTRAINT ON EVERY TIER, with three added resolver tests.
  - **Three defects found by the first real replay**, all of which distilled and validated cleanly:
    an invariant that did not survive its own transition (D30), row-keyed targets failing the
    loop's diagnostic resolve, and the distiller still emitting the old schema version.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 231 passing
    (`npm run test:fast` 205 in ~5s).
  - **Decisions recorded**: `DECISIONS.md` D28-D32.

- **PHASE 6** - Runtime outcomes. Business outcomes, known conditions, recoveries, fault injection.
  - **[MUST] The PINNED profile was not touched.** Every detector phrase in
    `config/condition-profiles/meridian-subaccount/1.0.0.yaml` is now rendered by the fixture
    verbatim. `tests/fixture.faults.test.ts` reads the REAL profile and checks its detectors against
    the REAL HTML, never against a copied string. Two fixture changes were needed and both were
    PERCEPTION problems rather than wording ones (D43): a detector phrase in a bare `<div>` is
    StaticText and invisible to its own detector, and a `<div role="dialog">` is not exposed as a
    dialog by Chrome. Neither was fixed by editing the profile.
  - **Fault injection, per SESSION** (`fixtures/legacy-app/faults.ts`): keyed by the
    `MERIDIAN_SESSIONID` cookie or an `X-Fault-Session` header, never a server-wide flag, because a
    global flag makes parallel vitest files interfere intermittently. Members 10003 (`restricted`)
    and 10004 (`knownNotice`) carry their behaviour in the SEED DATA with nothing armed. D42.
  - **Detector ladder rung 5 can now fire.** An unrecognised BLOCKING dialog returns `needs_human`,
    detected structurally by role for the same reason the validation detector matches an alert
    region rather than a wording.
  - **Recovery continuation** (D45): apply remediation, RE-OBSERVE, run TERMINAL detectors on what
    the recovery revealed, and only then recheck the interrupted step's effect. Runs regardless of
    the retry budget. Only `retry_action` repeats the action, so the maintenance notice - which
    appears AFTER the click that worked - never causes a second navigation. The continuation type
    was widened; the YAML was not touched, so every pinned hash still verifies.
  - **`SURFACE_UNAVAILABLE`** (D46): a dead browser is a result, not an exception. Anything not
    recognisable as surface death is RETHROWN, so a real defect stays loud. The test closes a real
    Chromium mid-run.
  - **`formatResultForHuman`** (`src/replay/report.ts`, D48): capability id and version, step id and
    recorded intent, expected beside observed, tiers attempted with downgrades marked, recoveries
    attempted, session liveness, evidence path. A hard failure now carries `expected`; it was
    `null`.
  - **[ADDENDUM C] The tier-downgrade gap is closed** (D47). `relabelContinueButton` rewords a
    button and leaves its legacy-stable `name=` alone, so a recorded T1 descriptor resolves at T4 -
    one tier weaker, run still succeeds, drift recorded. Asserted in the step result, the evidence
    file AND `metrics.locatorTierDowngrades`, with a negative control proving an unchanged screen
    reports zero.
  - **[ADDENDUM D] The timing assertion is kept and is the load-bearing test of the phase.** 99999
    returns `MEMBER_NOT_FOUND` in about 2.5s, asserted as elapsed < the step's own timeout. A
    status-only assertion would pass even if detectors ran after the wait.
  - **A perception bug found here, not in Phase 6 code** (D44): `isNoiseStructure` dropped any
    non-interactive node containing an interactive one. Correct for a wrapper, wrong for a dialog,
    and LATENTLY wrong for the `alert` region `APPLICATION_VALIDATION_REJECTED` depends on - an
    alert carrying a button would have vanished and the detector would have silently stopped
    working.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 341 passing across
    33 files (`npm run test:fast` 266 in ~20s).
  - **Decisions recorded**: `DECISIONS.md` D42-D48.

- **PHASE 7** - Safety, redaction, console security.
  - **[MUST] The bootstrap minimum was NOT removed** (D49). `config/allowlist.yaml` drives a
    configurable engine (`src/policy/`) that runs at the same two enforcement points in
    `resolveAndPerform`, AFTER the minimum, so the effective decision is the strictest of the two.
    `tests/policy.engine.test.ts` asserts separately that an off-origin navigate and every action
    type on "Submit Request" - `read` included - are refused by BOTH.
  - **`--origin` is deployment configuration, not a bypass** (D50). `PolicyEngine.runOrigin` adds
    the one origin the run is already pinned to by the minimum, which knows about exactly one.
  - **[MUST] No `--approve-irreversible`, anywhere** (D53). `effectiveRisk` is the MAXIMUM of
    artifact-declared and control-derived risk, so an artifact labelling "Submit Request" SAFE is
    not believed. A test greps the CLIs and the engine for an override and finds none. The shape a
    real action-scoped grant would need is written up rather than half-built.
  - **The input-path lint test** (`tests/policy.input-path.lint.test.ts`, D51) fails on `page.click`
    / `page.goto` / `page.fill` / `page.type` outside `src/surface/playwright-web/`, with two
    negative controls. It found `scripts/inventory.ts` calling `page.goto` directly.
  - **Browser-level origin backstop** (`src/policy/backstop.ts`): aborts non-allowlisted origins at
    the transport, which covers what the PAGE does rather than what the automation asks for.
  - **[MUST] THREE data mechanisms, kept apart** (D52): persistence is pseudonymized at one seam;
    artifacts are SCANNED and REJECTED, never rewritten; caller results are NOT redacted, because
    the brief requires replay to return what it read. `tests/replay.cli.live.test.ts` asserts the
    real value on stdout and its absence from stderr in one test.
  - **The pseudonym map is per-run and random**, not a truncated hash: 100,000 five-digit member ids
    are enumerable in under a second. `PSEUDONYM_SECRET` switches to HMAC-SHA-256 at 8 bytes
    minimum, refused below. Card detection Luhn-validates first so the logs stay readable.
  - **[MUST] Screenshot masking, checked in PIXELS** (D56). Only the masked image is written; the
    unmasked bytes never get a filename. Boxes are offset into page space and anything that cannot
    be offset is REFUSED and recorded rather than drawn in the wrong place. PNG decode/draw/encode
    is hand-rolled on Node's `zlib` rather than adding a dependency.
  - **[MUST] Operator console security, built before the console does anything** (D55): loopback
    only with the host a constant, a per-run token that is NEVER in a URL, exchanged for an
    HttpOnly SameSite=Strict intervention-scoped cookie, CSRF checks, unguessable ids, and NO
    list-all endpoint - an unknown id gets the same answer as a bad token.
  - **`docs/DATA_HANDLING.md`** rewritten and moved into `/docs`, with a LIMITS section: regex PII
    detection has false negatives, screenshots may capture data outside declared regions and we do
    not OCR, an allowlist does not prevent a harmful in-app action, a human operator with control is
    unconstrained, and model-boundary minimization covers values we TYPED and not everything the
    model reads.
  - **Two defects found in code this phase was not about**: the session broker discarded the results
    of its own sign-on actions, turning a precise refusal into "Member Search never appeared" (D57);
    and `frame.evaluate(string)` needs an EXPRESSION, so the first frame-offset implementation
    silently left every box in frame coordinates - masks would have landed in the wrong place with
    nothing failing (D56).
  - **One requirement that could not be met** (D54): the PINNED `banking-default 1.0.0` irreversible
    list contains bare words like `transfer`, so "Transfer history" is refused. The contextual
    requirement is met by the allowlist, which this phase controls; the profile is immutable and the
    real fix is a new version. The false positive is asserted out loud rather than hidden.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 401 passing across
    38 files.
  - **Decisions recorded**: `DECISIONS.md` D49-D57.

- **PHASE 8** - Human handoff. The MECHANISM, and the console is minimal by design.
  - **Control transfer** (`src/escalation/handoff.ts`): AUTOMATION_RUNNING -> PAUSING -> [lease
    revoked, HUMAN lease issued] -> HUMAN_CONTROL -> RESUME_VALIDATION. The run process stays alive
    and the browser context is NOT recreated. Mutual exclusion is the lease AND the session state,
    independently, so one being wrong does not mean two actors can drive at once.
  - **[MUST] The same-session guarantee is EVIDENCE** (D60). `browserContextId` and page `targetId`
    are captured before control is ceded and again when it comes back, written as two events plus an
    explicit `handoff_same_session` comparison. A handoff that opened a fresh browser would look
    identical in a screenshot, a log and a demo. There is a NEGATIVE control where the id changes
    and `sameSession()` must be false.
  - **[MUST] There is no `/complete`** (D59). `allowedChoices` is typed `resume | abort`, so the
    absence is in the schema rather than the UI, and a test requires 404 from `/complete`,
    `/success` and `/done`. `resume` subsumes it: the system re-observes, validates every declared
    output and declares success itself with `completionMode: 'human_assisted'`. "Only the system may
    declare success" binds the operator exactly as it binds the model.
  - **[MUST] Safe resume is ANCHOR MATCHING** (D58), never "the furthest checkpoint that holds".
    Checkpoints are not monotonic. Exactly one resume-eligible state must match; zero or two go back
    to the person. A PARTIALLY filled form matches nothing and returns to the human - correct, and
    cheaper than a run that types over work somebody just did. Identity invariants are checked FIRST,
    so a wrong record is reported as a wrong record and never as "please look again".
  - **Human acts are WITNESSED, because they cannot be gated** (D61). The lease governs
    software-issued actions; a person at a real keyboard is out of band, and REPORT.md says so. So
    listeners record click/input/change/submit/navigation per frame, re-injected after every
    navigation. `HumanActionEvidence` has NOWHERE to put a raw value - `valueChanged` plus a one-way
    correlation token. Desktop equivalent: OS accessibility event hooks.
  - **Console** (`src/escalation/console.ts`): four routes, plain HTML, behind the PHASE 7 security
    shell. The CLI prints the URL and - on a SEPARATE line - the token, then blocks. `--no-operator`
    makes a needs_human condition terminal again for an unattended caller.
  - **Member `20001` is seeded with `attestationRequired`** (D64) so the handoff can be driven by
    hand with one command. Its id avoids `1000` on purpose: `q=1000` returning exactly four `Open`
    links is what makes T5_STRUCTURAL_ROW necessary rather than theoretical.
  - **Three defects found in this phase's own design**: escalate-reconcile was straight-line and
    "carried on" into a screen it could not place (D63); `cede` could not be entered from
    RESUME_VALIDATION, which the PHASE 2 state table had anticipated and the code had not (D63); and
    resuming while the blocker was still on screen resumed INTO it, found by pressing Resume without
    fixing anything (D62).
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 444 passing across
    43 files. The CLI handoff was also driven end to end over HTTP: two interventions, the second
    reporting "that is still in the way", then abort with exit code 25.
  - **GATE 2 fix**: the console could not be OPENED. Two routes existed for one page - a PHASE 7
    placeholder returning JSON and the real page - the banner pointed at the placeholder, and the
    page was mounted behind the very cookie it exists to obtain. There is now one
    `interventionPath()` shared by the banner and the route, and the page is served unauthenticated
    while every data and state-changing route still requires the cookie. D65.
  - **The lesson, and it is the more important half** (D66): the mechanism worked and had an
    end-to-end test; the thing a PERSON touches did not work at all. Route-level tests ask the
    server questions. The first thing a person does is a GET on the URL in the banner, and no test
    did that. `tests/escalation.console.page.live.test.ts` now drives a real browser through the
    real sequence. Where a human-facing path exists, at least one test uses it the way the human
    does.
  - **GATE 2, third block**: the attestation control did nothing. It deleted `showUnknownModal` from
    the SESSION fault store, and for member 20001 that flag comes from the SEED DATA - so it removed
    something that was never there and the modal never cleared. Attestation is now its own
    per-session fact, the code is printed ON SCREEN, and any non-empty value is accepted. D67.
  - **D66 applied to the FIXTURE, and the walkthrough audited line by line** (D68).
    `tests/fixture.human-controls.live.test.ts` clicks: attestation (asserting the modal is GONE),
    Dismiss, and the whole happy path. The audit found a fourth problem nothing had caught -
    `/artifacts` is gitignored, so the documented replay command fails on a clean checkout;
    `npm run demo:store` copies the tracked example into `artifacts-demo/`. `docs/STATUS.md` now has
    one row per walkthrough step naming what covers it.
  - **Decisions recorded**: `DECISIONS.md` D58-D68.
