# TEST MAP

Which test covers which requirement, and how strongly.

This is built for PHASE 10's traceability table, so it is written to be **accurate rather than
generous**. A requirement covered by an assertion that would pass for the wrong reason is worse than
one honestly marked thin, because the first kind gets believed. Every row was checked by opening the
test named in it.

Three strengths are used, and they mean different things:

|                |                                                                                      |
| -------------- | ------------------------------------------------------------------------------------ |
| **direct**     | a test drives the real thing and asserts the specific claim                          |
| **structural** | the claim is impossible to violate by construction, and a test pins the construction |
| **thin**       | covered, but by something narrower than the claim. Named so it can be improved.      |

**Structural is stronger than direct, not weaker.** `ArtifactAction` has no field a `markId` could
occupy, so a mark id cannot reach an artifact whatever anyone writes. A test asserting "no mark ids
appear" would be checking one instance of something the type already makes impossible.

---

## The gate list

The sixteen items that must pass before PHASE 11.

| #   | Requirement                                                                            | Strength            | Where                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | hallucinated completion rejected                                                       | direct              | `integration/agent.verification.live` - the model proposes `goal_reached` while the screen shows a DIFFERENT member; completion is refused from a FRESH observation                                                                                                                       |
| 2   | stale screen context prevents the action, even when a same-named control resolves      | direct              | `unit/agent.proposal` - the "Member Search" link exists on both screens, the descriptor resolves cleanly against the new one, and the proposal is still refused `STALE_OBSERVATION_CONTEXT`                                                                                               |
| 3   | three same-screen field fills all survive distillation                                 | direct              | `unit/artifact.distill` - segment-based path reconstruction keeps all three; `integration/agent.discovery.live` produces them                                                                                                                                                             |
| 4   | runtime value in a locator rejected; contract enum accepted                            | direct              | `unit/artifact.distill` (both halves); `contract/artifact.gate1-leak` on the REAL leaked artifact                                                                                                                                                                                         |
| 5   | read/extract succeeds without a false→true transition                                  | direct              | `unit/artifact.distill` - "ACCEPTS a read step that has no expected effects"                                                                                                                                                                                                              |
| 6   | mutating step without a discriminating effect rejected                                 | direct              | `unit/artifact.states` - `NO_DISCRIMINATING_EFFECT`                                                                                                                                                                                                                                       |
| 7   | invariant may be true before and after                                                 | direct              | `unit/artifact.states` - accepted when it holds on both; `INVARIANT_FALSE_AFTER_ACTION` when it does not survive its own transition (the GATE 1 defect, D30); `INVARIANT_IS_AN_EFFECT` when it is really a transition                                                                     |
| 8   | conflicting locator signals → LOCATOR_CONFLICT, not a click                            | direct              | `unit/perception.resolver` - role+name and the stable attribute point at different controls                                                                                                                                                                                               |
| 9   | irreversible action blocked (no flag exists to allow it)                               | direct + structural | `unit/policy.engine` - refused by the bootstrap minimum AND the engine, for every action type including `read`; a source scan finds no override flag in either CLI or the engine                                                                                                          |
| 10  | maintenance recovery rechecks rather than repeating the click                          | direct              | `integration/replay.outcomes.live` - `recoveriesUsed === 1` and `attempts === 1`                                                                                                                                                                                                          |
| 11  | business outcome detected before the wait times out                                    | direct              | `integration/replay.outcomes.live` - asserts ELAPSED TIME against the step's own timeout, which is the only way to tell "detected" from "gave up and then noticed"                                                                                                                        |
| 12  | human cannot declare success                                                           | structural + direct | `allowedChoices` is typed `resume \| abort`, so `complete` will not parse (`unit/escalation.handoff`); `contract`-style route checks require 404 from `/complete`, `/success`, `/done` (`integration/escalation.console.routes`); the browser test asserts no such control is on the page |
| 13  | resume matches a unique resume-eligible state; ambiguity → human control               | direct              | `unit/escalation.handoff` - all five cases: success state, one match, partial form matching nothing, wrong record as a HARD FAILURE, two matches as AMBIGUOUS                                                                                                                             |
| 14  | `--json` stdout has no log lines; caller output usable while evidence is pseudonymized | direct              | `integration/replay.cli.live` - exactly one JSON object on stdout, the real `Avery Lin` in it, and absent from stderr                                                                                                                                                                     |
| 15  | replay dependency graph contains no model provider; `llmCalls === 0`                   | structural + direct | `contract/replay.boundary` walks the module graph from `src/replay/index.ts` WITH A NEGATIVE CONTROL; a provider-call counter is snapshotted around every run                                                                                                                             |
| 16  | profile hash tampering blocks replay; contentHash stable across approval               | direct              | `unit/replay` - a tampered pin gives `PROFILE_INTEGRITY_FAILURE` before the browser opens; `integration/artifact.store` - the hash is identical before and after the status flip                                                                                                          |

---

## The design commitments

From `CLAUDE.md` section 3. These are the claims the project is actually making.

| Commitment                                             | Strength            | Where                                                                                                                                                               |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Perception is accessibility-first, never CSS selectors | direct              | `integration/surface.live` observes through the real AX tree; `fixture.smoke` asserts the fixture emits no `data-testid` and regenerates every class name per boot  |
| The LLM never authors a selector                       | structural          | the tool schema accepts a `markId` and nothing else (`src/agent/tools.ts`); there is no field for a selector                                                        |
| Mark ids never reach an artifact                       | structural          | `ArtifactAction = SurfaceAction`, which has nowhere to put one; `unit/types.taxonomies` pins that a smuggled `markId` is dropped                                    |
| Completion is declared by the SYSTEM                   | direct              | items 1 and 12 above                                                                                                                                                |
| Replay makes zero LLM calls                            | structural + direct | item 15                                                                                                                                                             |
| Business outcomes and errors are separate hierarchies  | structural          | two disjoint zod enums with a compile-time proof of no overlap; `unit/types.taxonomies` asserts there is no `RECORD_NOT_FOUND` error                                |
| One actor at a time, enforced by lease tokens          | direct              | `unit/session`, and `unit/escalation.handoff` asserts an AUTOMATION action throws `LEASE_VIOLATION` for two independent reasons while a person holds control        |
| ONE `TargetResolver`, ONE input path                   | structural          | `contract/policy.input-path.lint` fails on `page.click` / `page.goto` / `page.fill` outside the transport, with two negative controls and two named-file exemptions |
| Typed comparison, never string equality                | direct              | `unit/types.normalize` - `250.00` / `250` / `$250.00` are the same currency value                                                                                   |
| Declared-sensitive regions are masked in screenshots   | direct              | `unit/redaction` on pixels; `integration/redaction.masking.live` on a real screen with real frame-offset boxes                                                      |
| The human path works the way a human uses it           | direct              | `integration/escalation.console.page.live` and `integration/fixture.human-controls.live` drive a real browser and click                                             |

---

## Where coverage is thin, stated plainly

Nothing below is claimed as covered anywhere else in this document.

**Cross-tenant is not covered at all.** `semanticKey` exists on `TargetDescriptor` and nothing reads
it; `tenants/tenant-b.ts` does not exist. That is PHASE 11, and until then the surface-independence
claim rests on the desktop stub compiling rather than on a second tenant running.

**The desktop adapter is a stub.** It compiles and throws, and it documents the real UI Automation
call for every method. It proves the `Surface` contract is expressible without a browser; it proves
nothing about whether the contract is right for a desktop app.

**Discovery is exercised with a scripted client in CI.** Two real model runs happened at GATE 1 and
both are written up, but no test in this suite calls a provider - deliberately, because a test suite
that costs money per run is a test suite people stop running. What the scripted client cannot catch
is anything about how a real model behaves, which is exactly what both GATE 1 runs caught.

**Screenshot masking covers DECLARED regions only.** There is no OCR. A sensitive value rendered
somewhere nobody declared is still in the pixels, and no test asserts otherwise because the claim is
not made. `docs/DATA_HANDLING.md` says so in its LIMITS section.

**The tier-downgrade evidence claim is covered end to end but by one drift scenario.** A relabelled
button falls from `T1_EXACT_ROLE_NAME` to `T4_STABLE_ATTRIBUTE`. Other drift shapes - a moved row, a
renamed frame - are not exercised.

**The policy engine's route patterns are tested through the engine, not through a real navigation
to a denied route.** The bootstrap minimum and the browser backstop are both tested directly; the
route allow/deny list is asserted at the decision level only.

**`npm run operator` does not exist.** It exits 2 and names PHASE 12. The handoff needs no separate
command, so nothing is missing from the mechanism - but if a reviewer runs that script expecting a
console, they get an honest refusal rather than one.

---

## Reconciling this with the brief

The rows above are keyed to the sixteen gate items and to the design commitments in `CLAUDE.md`,
because those are the requirement lists this build has been driven against phase by phase.

PHASE 10 builds the traceability table for `REPORT.md` from this document, and should key it to the
brief's own section-3 numbering. Where a brief requirement has no row here, the honest answer is that
it is uncovered, not that it maps loosely onto a nearby row.
