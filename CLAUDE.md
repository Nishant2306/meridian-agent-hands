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

- One phase at a time, vertically. Do **not** look ahead or build for later phases.
- After each phase: **run typecheck and tests**, **update the status checklist in this file**, and
  **STOP** for inspection before the next one begins.

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

The phase map. **Knowing the map is fine; building ahead of the current phase is not** (Hard Rule 7).
Phases 0 through 10 are complete; 11 and 12 are scope that was deliberately not taken, and
`REPORT.md` section 7 says what would come first. **GATE 3 is the evidence run itself**
(`npm run evidence:automated`, `evidence:handoff`, `evidence:verify`) - the machinery is built and
tested, and the bundle exists once somebody with an API key runs it.

| Phase | Scope                                                                                                                                       | Status                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 0     | Constitution, directory scaffold, `CLAUDE.md`, `.gitignore`, `git init`                                                                     | ✅ Complete                         |
| 1     | Scaffold + types + DiscoverySpec + target app                                                                                               | ✅ Complete                         |
| 2     | Surface / perception / lease - `resolveAndPerform` exists and enforces the **bootstrap safety minimum** from here onward                    | ✅ Complete                         |
| 3     | Artifact schema + profiles + store - the **final versioned condition + safety profile YAML** is written here and does not change afterwards | ✅ Complete                         |
| 4     | Discovery + distiller - uses a scripted fake LLM client for tests                                                                           | ✅ Complete                         |
| 5     | Replay - **GATE 1**: a real model against a live UI at the end of this phase. Also the replay import-boundary scan                          | ✅ Complete, GATE 1 PASSED          |
| 6     | Runtime outcomes - business outcomes, known conditions, fault injection in the fixture                                                      | ✅ Complete                         |
| 7     | Safety - the configurable engine runs ALONGSIDE the bootstrap minimum, which stays                                                          | ✅ Complete                         |
| 8     | Human handoff - **GATE 2**                                                                                                                  | ✅ Complete                         |
| 9     | Tests                                                                                                                                       | ✅ Complete                         |
| 10    | Evidence + README + REPORT - **GATE 3**                                                                                                     | ✅ Complete, GATE 3 bundle produced |
| 11    | Cross-tenant                                                                                                                                | ⬜ Not built                        |
| 12    | Polish                                                                                                                                      | ⬜ Not built                        |

### Companion documents

- `docs/STATUS.md` - what is built, how it works, and how to verify it. Updated every phase.
- `docs/SCHEMA.md` - the annotated capability artifact. Hand-written, and machine-checked.
- `docs/TEST_MAP.md` - every gate item and design commitment mapped to the test covering it, with an
  honest strength and a section for what is thin. `REPORT.md`'s traceability table is built from it.
- `docs/DATA_HANDLING.md` - what is stored, pseudonymized, masked, never captured, and an
  explicit LIMITS section for what it does NOT protect.
- `docs/DECISIONS.md` - thirteen decisions with their costs, distilled for a reader.
- `DECISIONS.md` - the full log those were distilled from, in the order the calls were made.
- `README.md` - the demo path. `REPORT.md` - the design write-up. `evidence/README.md` - the bundle.

### Deferred work (noted, not built)

- **GATE 1 PASSED.** Discovery 8 steps / 10 model calls; replay on member 10002 against a freshly
  seeded fixture, 1.8s, `llmCalls: 0`. It also leaked a member id and name into model-authored
  prose, which the parameterization sweep now refuses. See DECISIONS.md D39 and D40.
- **`semanticKey`** exists on `TargetDescriptor` and nothing reads it. It is present so that
  cross-tenant support is not a schema retrofit against artifacts that already exist and are already
  content-hashed - the cheapest thing to get right early and the most expensive later.
- **`fixtures/legacy-app/tenants/tenant-b.ts`** exists as a documented TODO and exports nothing. It
  names the axes a real second deployment of the same vendor product differs along. Cross-tenant is
  covered by no test; `docs/TEST_MAP.md` says so under what is thin.
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
  `tests/integration/replay.downgrade.live.test.ts` drives a real replay against a drifted screen and asserts the
  downgrade lands in the step result, the evidence file and `metrics.locatorTierDowngrades`, with a
  negative control. See DECISIONS.md D47.
- **The async status API** for `needs_human` is deliberately not built - see the note at the bottom
  of `src/types/run.ts`.
- `npm run test:fast` excludes `**/*.live.test.ts` (the browser-driven files) and nothing else.
  `npm test` remains the full run and is what a gate requires. No test needs an API key.
- `npm run distill:demo` runs the scripted fake client end to end and writes a real distilled
  artifact to the throwaway `artifacts-demo/`. No model is called, and the artifact's provenance
  says so.
- `npm run operator` points at `scripts/not-implemented.ts` and exits 2, naming the phase that would
  build it. The handoff needs no separate command: `npm run replay` starts the console itself.
- **A pseudonymizer for read-only sensitive nodes at the model boundary** is designed and not built,
  and it is the reason a member's name can still appear in the model transcript inside an evidence
  bundle. `evidence:verify` reports that as a NOTE with a count rather than folding it into a pass.
  See DECISIONS.md D76 and `docs/DATA_HANDLING.md` LIMITS.

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
    verbatim. `tests/integration/fixture.faults.test.ts` reads the REAL profile and checks its detectors against
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
    `tests/unit/policy.engine.test.ts` asserts separately that an off-origin navigate and every action
    type on "Submit Request" - `read` included - are refused by BOTH.
  - **`--origin` is deployment configuration, not a bypass** (D50). `PolicyEngine.runOrigin` adds
    the one origin the run is already pinned to by the minimum, which knows about exactly one.
  - **[MUST] No `--approve-irreversible`, anywhere** (D53). `effectiveRisk` is the MAXIMUM of
    artifact-declared and control-derived risk, so an artifact labelling "Submit Request" SAFE is
    not believed. A test greps the CLIs and the engine for an override and finds none. The shape a
    real action-scoped grant would need is written up rather than half-built.
  - **The input-path lint test** (`tests/contract/policy.input-path.lint.test.ts`, D51) fails on `page.click`
    / `page.goto` / `page.fill` / `page.type` outside `src/surface/playwright-web/`, with two
    negative controls. It found `scripts/inventory.ts` calling `page.goto` directly.
  - **Browser-level origin backstop** (`src/policy/backstop.ts`): aborts non-allowlisted origins at
    the transport, which covers what the PAGE does rather than what the automation asks for.
  - **[MUST] THREE data mechanisms, kept apart** (D52): persistence is pseudonymized at one seam;
    artifacts are SCANNED and REJECTED, never rewritten; caller results are NOT redacted, because
    the brief requires replay to return what it read. `tests/integration/replay.cli.live.test.ts` asserts the
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
    did that. `tests/integration/escalation.console.page.live.test.ts` now drives a real browser through the
    real sequence. Where a human-facing path exists, at least one test uses it the way the human
    does.
  - **GATE 2, third block**: the attestation control did nothing. It deleted `showUnknownModal` from
    the SESSION fault store, and for member 20001 that flag comes from the SEED DATA - so it removed
    something that was never there and the modal never cleared. Attestation is now its own
    per-session fact, the code is printed ON SCREEN, and any non-empty value is accepted. D67.
  - **D66 applied to the FIXTURE, and the walkthrough audited line by line** (D68).
    `tests/integration/fixture.human-controls.live.test.ts` clicks: attestation (asserting the modal is GONE),
    Dismiss, and the whole happy path. The audit found a fourth problem nothing had caught -
    `/artifacts` is gitignored, so the documented replay command fails on a clean checkout;
    `npm run demo:store` copies the tracked example into `artifacts-demo/`. `docs/STATUS.md` now has
    one row per walkthrough step naming what covers it.
  - **Decisions recorded**: `DECISIONS.md` D58-D68.

- **PHASE 9** - Tests. Consolidation, two genuine gaps, and `/tests` made readable.
  - **Laid out by what a test COSTS to run** (D69): `unit/` and `contract/` need no browser and are
    exactly what `test:fast` runs; `integration/` is the fixture, the CLIs, the console and every
    browser-driven path. A subject split reads better and answers the wrong question - the question
    a person has fifty times a day is "can I run this in ten seconds".
  - **`contract/` is about what the project PROMISES**: the golden artifact validates and its pins
    verify, the five `RunResult` shapes and their exit codes, replay's graph contains no provider,
    there is ONE input path.
  - **The sixteen gate items were audited one by one.** Fifteen already had a test, several stronger
    than asked. Item 7 - an invariant may be true before AND after - had only its inverse covered,
    and both rules from the GATE 1 defect (D30) were untested; three tests added. D71.
  - **`docs/TEST_MAP.md`** maps every gate item and design commitment to its test with a strength -
    direct, structural, or thin - and says plainly where coverage is weak: cross-tenant not at all,
    the desktop adapter a stub, discovery scripted in CI, masking declared-regions-only, the
    downgrade claim proven by one drift shape. D72.
  - **Two defects found by consolidating** (D70, D72): `RunResult` branches were not strict and zod 4
    does not strip unknown keys, so a result read back could carry an undeclared field to a caller;
    and four references in `docs/STATUS.md` pointed at test files that have never existed. Every
    documented test path is now verified mechanically.
  - **Prefer impossible-by-type over tested-for**: `ArtifactAction` has nowhere to put a `markId`,
    `allowedChoices` cannot express `complete`, the two outcome taxonomies are disjoint by
    construction. TEST_MAP marks those STRUCTURAL and says why that is stronger than direct.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 461 passing across
    44 files, and no test needs an API key.
  - **Decisions recorded**: `DECISIONS.md` D69-D72.

- **PHASE 10** - evidence, README, REPORT. **The submittable state.**
  - **Three commands** (`scripts/evidence/`): `evidence:automated` makes ONE real discovery, approves
    the result, RESTARTS the fixture so replay sees a different obfuscation seed, and runs five
    replays; `evidence:handoff` is explicitly interactive and blocks for a person; `evidence:verify`
    is the gate and needs no API key. Output lands in `/evidence/<scenario>/<runId>/` with an index in
    `/evidence/manifest.json`.
  - **It is a Node program because a shell script cannot be idempotent here** (D74): the store refuses
    to overwrite a published version, approval mutates in place exactly once, the fixture must be
    restarted, and one scenario needs a fault armed on a dedicated boot. It REFUSES to run without an
    API key rather than falling back to the scripted client. `--reuse <dir>` skips the discovery,
    because that is the only step that costs money and everything after it is free.
  - **[MUST] The tier assertion is what makes the seed restart mean anything** (D76). The fixture
    keeps its legacy-stable `name=` attributes, so a replay that resolved every control through those
    would survive a restart and prove nothing. The verifier asserts the tier each key control resolved
    at - T1 for the search box, T3 for the table-labelled fields, T5 for the row control - classifying
    by the recorded descriptor's shape rather than by step id, and reports any fall back to T4.
  - **The verifier separates what it PROVED from what it was TOLD.** Exactly two checks are marked
    `[manifest]`: which member each run used, and the fixture seed. Neither is recoverable from a
    bundle whose files are pseudonymized with a per-run random map, and saying so is the difference
    between a gate and a formality.
  - **Fault arming without a server-wide flag or a CLI test hook** (D75): the orchestrator mounts the
    unmodified fixture under a parent app that stamps ONE fault-session key on every request of ONE
    dedicated boot. `evidence.sweep.live` runs the faulted and unfaulted scenarios with IDENTICAL
    parameters against different boots, so a leak between them would be visible.
  - **Three defects found in code this phase was not about.** The human-readable channel was never
    pseudonymized and the test covering it could not fail, because every call passed `--json`, which
    suppresses that channel entirely (D73). An ordinary replay recorded no `lease_issued` event, so
    the lease claim had evidence only in runs that reached a handoff. And nothing in a run said WHICH
    artifact it had loaded, leaving the orchestrator as the sole witness to its own output (D78).
  - **The evidence machinery is tested for free** (D78). `evidence.sweep.live` drives the real sweep
    and the REAL verifier against the tracked example capability in 17 seconds, and found that
    `--import tsx` resolves from the CHILD's cwd - which would have failed every spawn immediately
    after a paid discovery. It is also the verifier's NEGATIVE CONTROL: a bundle with no discovery
    behind it must be refused by name while every replay check still passes.
  - **Documents**: `README.md` with the demo path and an explicit no-API-key route, `REPORT.md` at
    1,792 words under seven headings with a traceability table keyed to the brief, `evidence/README.md`
    as a template with `<<FILL AFTER RUN>>` markers, and `docs/DECISIONS.md` as thirteen ADRs.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 478 passing across
    46 files in about 2.5 minutes.
  - **Decisions recorded**: `DECISIONS.md` D73-D79.

- **GATE 3, run 1** - the evidence discovery FAILED, and found a real defect.
  - 8 steps, 14 model calls, `MAX_STEPS_EXCEEDED` on the repeated-action rule. The flow worked: it
    reached the review screen with every step performed at its recorded tier, zero downgrades, zero
    conflicts. It stalled re-binding the RECORD IDENTITY.
  - **[MUST] LAST-WRITE-WINS ON THE RECORD IDENTITY WAS THE BUG** (D80). The model bound the identity
    on the Member Record cell (which resolves on the review screen), then REBOUND it to a summary
    line on the New Sub-Account form (which does not), and only the last one counted. The run had a
    binding that verifies and threw it away. Candidates are now kept and `verifyCompletion` chooses
    one that resolves against the FRESH observation; the run record keeps the one that verified, so
    the artifact carries a descriptor proven on the success screen.
  - **The obvious alternative does not work.** "Refuse a replacement that does not resolve where the
    first one did" fixes nothing: the first binding does not resolve on the form screen either. The
    screen a binding is CHECKED on is not the screen it is MADE on, and the test asserts both
    directions of that because it is the design a reviewer reaches for first.
  - **"Stale", not "absent"** (D81). The old message read as the identity being missing; it was on
    screen the whole time. The refusal now names the screen the binding came from.
  - **Feedback on SUCCESS, reason-specific** (D82). The model fixed the blocker and was told the same
    bland line it had already had twice, so it never re-proposed. `src/agent/outstanding.ts` tracks
    the refusal's reasons and speaks once, when a NAMED one becomes false. Generic would turn
    completion into polling at a model call per round.
  - **The goal was sent UNRENDERED** (D83), my defect in the orchestrator: a real model was told to
    "find member {{memberId}}". `renderGoal` now renders it; provenance still stores the template.
  - **`transcript.jsonl` cannot answer "what did the model see"** (D84). It is pseudonymized on the
    way to disk, so it shows a label where the model saw the value. Diagnosis started from that wrong
    conclusion and had to be corrected against the raw `run.json`. `evidence/README.md` says so where
    a reviewer will look.
  - **Diagnosed with no second API call.** The whole failure reproduces offline from recorded
    observations; `tests/unit/agent.completion.identity.test.ts` is that reproduction and fails if
    the fix is reverted.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 496 passing across
    49 files.
  - **Decisions recorded**: `DECISIONS.md` D80-D84.

- **GATE 3, run 2** - the discovery SUCCEEDED and the gate found two leaks in its own bundle.
  - 8 steps, 9 model calls, all five replays correct, every tier assertion passing.
    `evidence:verify` reported 22 of 25: the handoff is not yet driven, and TWO REAL LEAKS.
  - **`10001` in a screenshot's `.mask.json`** (D86). `MaskRegion.descriptorRef` describes the
    control that was covered, and the natural way to describe a control showing a member id is to
    quote it - so the file RECORDING the masking carried the value in text, beside the image where
    it had been correctly painted over. Written through the pseudonymizer now.
  - **`Avery Lin` in the discovery `result.json`** (D86). The replay CLI has completed its
    declaration with the values a run READ since D73; the discovery CLI never did, because the two
    blocks were written separately. Fixed as ONE `declarationFor()` in
    `src/redaction/declaration.ts`, used by both - the duplication was the actual cause.
  - **The bundle is NOT scrubbed** and still fails those checks. Evidence is never rewritten; the
    fixes land in the next run.
  - **The goal was never sent pseudonymized** (D85). The console line looked like it, which is why it
    was worth checking rather than assuming. `run.json` carries the rendered goal with real values;
    `say()` writes a SEPARATE labelled copy to the transcript. The console line now prints what was
    sent, on a stated rule: **the CLI does not redact the invocation back to the person who typed
    it.** Values the run READ are still labelled everywhere, which is what D73 was about.
  - **The raw record outlives the temp runtime** (D87). `run.json` is the only file that answers
    "what did the model SEE" and it cannot be published, so it was living only in an OS temp
    directory that a cleanup deletes - while `evidence/README.md` pointed at it. It is copied to
    `runs/evidence-raw/<runId>/` now, and the README states that a reviewer holding only this
    repository cannot answer that question.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 501 passing across
    51 files.
  - **Decisions recorded**: `DECISIONS.md` D85-D87.

- **GATE 3, run 3** - the handoff bundle. Two failures, and one of them was a pattern.
  - **[MUST] THE REDACTION SEAM WAS PER-WRITER** (D88). `20001` reached two published
    `observation-*.json` files, because the handoff path captures AX dumps the unattended path never
    does. Third instance in two phases of a NEW writer bypassing an EXISTING seam. The cause was the
    shape: `EvidenceWriter` had `writeJson` beside `writeRedactedJson` and `transcript` beside
    `transcriptRedacted`, so safety was a variant you had to choose and the unsafe half had the
    shorter name. One private `#write` now, both twins deleted, plus
    `tests/contract/evidence.seam.lint.test.ts` failing on any bare write into a run directory in
    `src/` - one named exemption, a negative control, mutation-tested.
  - **The lint found a fourth immediately**: `writeScreenshot` had a branch writing the RAW png when
    no declaration was supplied. No production caller took it and D56 forbids it. Gone.
  - **[MUST] THE EVIDENCE CONTAINED A TRANSITION THAT NEVER HAPPENED** (D89). The replay engine wrote
    `session_transition` events with a hardcoded `from`, having no reference to the state machine. A
    duplicate on the first intervention; FALSE on the second, where the machine was in
    RESUME_VALIDATION. The engine records none now. `reclaim` also re-issued the AUTOMATION lease
    without recording it, so a two-intervention run read `AUTOMATION -> HUMAN -> HUMAN`.
  - **The handoff check accepted only one intervention** (D90), so it failed the D62 path - the most
    interesting handoff evidence the project can produce. It tests a CHAIN now: starts in
    AUTOMATION_RUNNING, every edge legal, each edge starting where the last ended. N interventions
    pass; a fabricated transition still does not, which is what caught D89.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 525 passing across
    55 files.
  - **Decisions recorded**: `DECISIONS.md` D88-D90.

- **GATE 3, run 4** - one real leak, one phantom, and a bundle holding three runs.
  - **[MUST] A BUNDLE HOLDS ONE RUN OF EACH SCENARIO** (D91). `/evidence` had accumulated three
    discoveries and two handoffs while the manifest named one of each. Cleared now, after approval
    so a failed discovery does not cost the previous bundle. **The handoff is cleared too**: it
    replays the artifact the discovery produced, so a fresh discovery beside a stale handoff is a
    bundle that lies about which capability the person operated. The gate then fails "not run" until
    it is re-driven.
  - **The reported member-id leak was a FALSE POSITIVE** (D92): every hit was a substring of a float
    box measurement, `783.2000122070312`. The scan parses JSON and searches strings now. A false FAIL
    is the worst thing a gate can produce, and this one sent the first diagnosis after a bug that was
    not there.
  - **Chasing it found a real hole** (D93): the pseudonymizer left object KEYS alone. Nothing in the
    evidence is shaped that way, which is why it had survived.
  - **The real leak was the member NAME** (D94), and it is NOT the transcript's documented limit.
    `memberName` is a declared output and the artifact says which control shows it; the run simply
    stopped before reading it. "The system could not know" and "the system had not looked" are
    different, and only the first is a limit. The engine now resolves declared-sensitive output
    descriptors against an observation before persisting it.
  - **It was reported as a NOTE because the classifier defaulted to lenient** (D95) - a LIST of
    system files, with everything else treated as model prose. Inverted. A regex bug in the same
    three lines would also have misread every path on Windows.
  - **Verification**: `npm run typecheck` clean, `npm run lint` clean, `npm test` 525 passing across
    55 files.
  - **Decisions recorded**: `DECISIONS.md` D91-D95.
