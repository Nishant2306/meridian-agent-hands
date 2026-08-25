# STATUS - what is built, how it works, and how to check it

This file is the running account of the build. It is updated at the end of every phase and is meant
to be read by someone who has just cloned the repository and wants to know what is real, what is
deliberately absent, and how to verify both for themselves.

Companion documents: [`../CLAUDE.md`](../CLAUDE.md) is the working agreement and phase checklist.
[`../DECISIONS.md`](../DECISIONS.md) records the calls that could reasonably have gone the other
way. [`SCHEMA.md`](SCHEMA.md) is the annotated capability artifact, and is the single best thing to
read. `README.md` and `REPORT.md` are PHASE 10 and do not exist yet.

---

## Quick verification

```bash
npm install
npx playwright install chromium
npm run typecheck && npm run lint && npm test
```

Expect: no type errors, no lint errors, **174 tests passing across 15 files**. One of those files
drives a real Chromium against the real fixture; the rest are fast and browser-free.

The single most useful thing to look at:

```bash
npm run inventory
```

It boots the fixture, signs on, walks the whole happy path through the real input path, prints the
perceived control inventory at every screen, and finishes by trying to press the one button that
must never be pressed. It should end with `POLICY_BLOCKED`.

---

## Phase 0 - constitution and scaffold (COMPLETE)

**What exists.** The directory tree, `.gitignore`, `CLAUDE.md`, and an initialized git repository
with no commits.

**How to check it.**

```bash
git check-ignore -v artifacts/x.json examples/artifacts/.gitkeep
```

`artifacts/x.json` is ignored; `examples/artifacts` is not. The `/artifacts` pattern is
root-anchored on purpose, so example artifacts stay tracked.

---

## Phase 1 - scaffold, types, DiscoverySpec, target app (COMPLETE)

### What exists

**Toolchain.** ESM, Node >= 20, TypeScript strict plus `noUncheckedIndexedAccess`, vitest, eslint
flat config, prettier. `.env.example` holds exactly the five mandated variables and nothing else.

**The type vocabulary** (`src/types/`). Zod schemas with inferred types. The parts worth knowing:

| Type                                   | The point of it                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ControlRole`                          | Closed, ARIA/UIA-shaped, so the same words describe a web page and a desktop window.                                                    |
| `RiskClass` + `RISK_ORDER` + `maxRisk` | Makes "effective risk is the maximum of three sources" a definition rather than a sentence.                                             |
| `TextMatcher`                          | Literal or named parameter. **No regex variant**: an over-permissive matcher is the failure mode being guarded against.                 |
| `Money`                                | Minor units, never a float. `$250.00` is `25000`.                                                                                       |
| `TargetDescriptor`                     | Three-part split: optional portable key, surface-independent semantics, advisory adapter hints. There is nowhere to put a CSS selector. |
| `LocatorTier`                          | T1 to T5, de-overlapped by WHAT EVIDENCE each relies on.                                                                                |
| `SurfaceAction`                        | `navigate` is an action. There is **no untargeted key press**.                                                                          |
| `Assertion`                            | Carries `when.paramPresent`, so an assertion about an optional input does not fire when that input was omitted.                         |
| Two taxonomies                         | `BusinessOutcomeCode` and `ErrorCode` never mix. There is no `RECORD_NOT_FOUND` error.                                                  |
| `ProposalRejectionCode`                | A third, separate type. A stale proposal is a conversational event the loop recovers from, not a run failure.                           |
| `RunResult`                            | Five statuses. No `completionMode: 'human'`, because no path produces it.                                                               |

**Typed comparison** (`src/types/normalize.ts`). `value_matches_param` compares in the declared
type own space. The caller passes `"250.00"`, the field holds `"250"`, the review screen renders
`"$250.00"`, and all three compare equal.

**`specHash`** (`src/config/`). SHA-256 of the canonical serialization of the parsed spec, so
reformatting the YAML is free and any semantic change moves the hash.

**The DiscoverySpec** (`config/specs/prepare_subaccount_review.yaml`). The declared half of the
contract: four inputs, three outputs, the record identity parameter, and the profiles it is
governed by, referenced by id and version only.

**The target app** (`fixtures/legacy-app/`). See `fixtures/legacy-app/README.md` for the full list
of what is hostile and why.

### How to check it

```bash
npm test -- tests/types.money.test.ts tests/types.normalize.test.ts tests/config.spec.test.ts
```

**The claim worth checking by hand.** Class names change on every boot; `name=` attributes do not.

```bash
npm run dev:app-a
```

Then `curl http://localhost:4180/__test__/seed`, restart, and compare. The seed changes, and with
it every CSS class and element id in the application. `tests/fixture.smoke.test.ts` asserts this
directly: two boots produce **disjoint** class-token and id sets and **identical** `name=` sets.

---

## Phase 2 - surface, perception, lease (COMPLETE)

### What exists

**Two interfaces, one input path** (`src/types/surface.ts`).

- `TargetResolver.resolve` is pure and read-only. It takes no lease, because it sends no input.
  That matters: if observation required a lease, the operator console could not poll the screen
  while a person holds control, and the handoff would deadlock.
- `Surface.resolveAndPerform` is **the only way any software-issued action reaches the screen**.

**The eight-step sequence**, in `src/surface/playwright-web/surface.ts`, in this order every time:

1. validate the lease token: current lease, correct owner, unexpired, session state admits it
2. **bootstrap safety minimum**, static half (allowed action types, allowed origin)
3. static policy precheck - the PHASE 7 engine plugs in here, alongside the minimum
4. resolve, through the one resolver
5. **resolved-control policy** - cannot run earlier: no policy can classify "click Delete Member"
   before it knows what resolved
6. revalidate that the control is still present, still unique enough, still visible, and still
   carrying the same `name` attribute
7. perform
8. return the result together with the `ResolutionTrace`

**Honest limit, stated in the code and repeated here.** Steps 4 to 7 inside one adapter operation
_minimize_ the resolve/act race and keep ownership of the chosen candidate in one place. They do
**not** eliminate it. The page can still change between step 6 and step 7, and no browser API closes
that gap. What revalidation buys is that a control which has ALREADY drifted fails the action
instead of being clicked.

**Lease tokens and the session machine** (`src/session/`). Holding a token is the capability to act;
there is no ambient permission. Issuing a lease invalidates the previous one, so ceding control to a
person makes the automation token stop working immediately. Illegal state transitions throw.
`COMPLETED` is reachable from `RESUME_VALIDATION` because the human may already have finished the
job, and the system re-observes rather than taking their word for it. There is no transition by
which a human declares success.

**Perception, level 1** (`src/perception/`). Accessibility-FIRST, not accessibility-only:

- Chrome own accessibility tree over CDP gives role, accessible name and value.
- Each control is then enriched from the DOM for the three things the AX tree does not carry:
  `nearbyText` (the cell to the LEFT and the heading ABOVE), the legacy `name=` attribute, and the
  bounding box. The box is for PHASE 7 screenshot masking and is never used to locate anything.
- Nothing mutates the page. No injected attributes, no markers, no test hooks.
- `aria_snapshot` is a documented DEGRADED fallback, and every observation records which path
  produced it, so a thin inventory is never mistaken for a thin screen.
- **markIds are ephemeral**: valid only inside one observation, and structurally incapable of
  reaching an artifact.

**The resolver cascade** (`src/perception/resolver.ts`). One candidate wins. Several candidates get
narrowed by container hints, then nearby text, then ordinal. Still ambiguous is
`AMBIGUOUS_CONTROL`, because in a banking application guessing is the worst available behaviour.
Two independent high-confidence signals that disagree is `LOCATOR_CONFLICT`, not a safe resolution.
Resolving at a weaker tier than the one recorded is a **drift signal**: the action proceeds and the
downgrade is recorded.

**The bootstrap safety minimum** (`src/surface/bootstrap-policy.ts`). Active from this phase onward
and not configurable off. One allowed origin, five allowed action types, and any action on a control
whose name matches the irreversible patterns is refused. GATE 1 runs a real model against a live UI
at the end of PHASE 5 and the full policy engine is PHASE 7; this is what stands in the gap.

**Evidence** (`src/evidence/logger.ts`). Typed JSONL events plus screenshots under `/runs/<runId>/`.
Secret VALUES never enter an event: bindings are described by name. PII pseudonymization and
screenshot masking are PHASE 7, behind a single `redactForPersistence` hook.

**The desktop stub** (`src/surface/desktop-stub.ts`). Compiles, throws, and documents the real UI
Automation implementation for every method. It exists to make one claim checkable rather than
rhetorical: the Surface contract is genuinely surface-independent.

### How to check it

```bash
npm run inventory
```

Read the output. What it demonstrates, in order:

| What you see                                           | Why it matters                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `type operator id: ok via T3_EXTERNAL_LABEL_OR_NEARBY` | The sign-on fields have **no accessible name**. They were found by the cell to their left.            |
| `[16] textbox "Member ID"` under `frame: contentFrame` | The one field with a real `<label for>` resolves at T1. Two different tiers on the first two screens. |
| Four `link "Open"` lines on the results screen         | Identical names. Only the row key separates them.                                                     |
| `click Open for 10001: ok via T5_STRUCTURAL_ROW`       | The structural-row tier working on real data.                                                         |
| `[19] combobox "" = "Select an account type"`          | The neutral initial state, seen through the accessibility tree.                                       |
| `select Savings: ok via T3_EXTERNAL_LABEL_OR_NEARBY`   | A control with no name at all, operated correctly.                                                    |
| `cell "$250.00"` after typing `250.00`                 | One value, two renderings. This is why typed comparison exists.                                       |
| `click Submit Request: BLOCKED POLICY_BLOCKED`         | The guardrail, on the real screen, at the real moment.                                                |

Then the automated suite:

```bash
npm test -- tests/session.test.ts
npm test -- tests/perception.observe.test.ts tests/perception.resolver.test.ts
npm test -- tests/surface.bootstrap-policy.test.ts tests/surface.live.test.ts
```

**What each file is for.**

- `session.test.ts` - a stale token throws, an expired token throws, and a perfectly valid
  AUTOMATION token is worthless while the session is in `HUMAN_CONTROL`. Illegal transitions throw,
  and no transition lets a human declare success.
- `perception.observe.test.ts` - runs against **recorded** observations in
  `tests/fixtures/observations/`. Checks that the search box is found inside `contentFrame`, that
  the LEFT-adjacent cell is picked up as the label for the fields that have no name, that the form
  is perceived as neutral, and that the only attribute ever recorded as stable is `name`.
- `perception.resolver.test.ts` - each tier resolving on real captures, the refusal to guess, the
  conflict rule, and the tier-downgrade drift signal.
- `surface.bootstrap-policy.test.ts` - off-origin navigation blocked (including an absolute URL
  smuggled in as a path segment), every action type on `Submit Request` blocked, and the pattern
  list proven broader than this one fixture button.
- `surface.live.test.ts` - the only test that drives a real browser, because everything above
  proves the LOGIC and none of it proves the EXTRACTION.
- `evidence.test.ts` - the JSONL file is LF-delimited on every host, and a binding is describable
  without its value ever appearing.

**Evidence from the spike.** `npm run inventory` writes a real run to `/runs/<runId>/`. Worth
opening `events.jsonl` for two lines in particular:

```bash
grep valueBinding runs/*/events.jsonl
grep action_blocked runs/*/events.jsonl
```

The first shows `"valueBinding":"secret:operatorPasscode"` and never the passcode itself. The
second is the guardrail refusing the click, recorded with its reason.

**About `tests/fixtures/observations/`.** Those files are real captures, written verbatim by
`npm run inventory`. Nothing there is hand-authored. They exist so the resolver tests need no
browser, which is only possible because the resolver is pure.

**Debugging perception.** `PERCEPTION_DEBUG=1 npm run inventory` prints the reason for any fallback
to the degraded path. Three separate CDP behaviours make perception return an empty screen rather
than an error; all three are recorded in `DECISIONS.md` D13.

---

## Phase 3 - artifact schema, profiles, store (COMPLETE)

### What exists

**The capability artifact** (`src/artifact/schema.ts`). Read [`SCHEMA.md`](SCHEMA.md) instead of the
zod file: it is the annotated walkthrough, and it is machine-checked. The one-paragraph version: an
artifact is the declared contract, plus the observed path, plus a pinned condition profile, and
removing any one leaves something that is not a capability.

**Three versions, three questions.** `schemaVersion` (what shape is this file), `capabilityVersion`
(which revision of this capability), `target.compatibility.versionRange` (which versions of the
vendor application). Collapsing any pair gives a number that answers neither.

**States and the resumption rule.** Only RESUME-ELIGIBLE states must be mutually exclusive. A
non-resumable state may be a strict prefix of a resumable one, because nothing ever has to choose
between them. The consequence is the right one and it is cheap: a half-filled form matches no
resumable state, so the run goes back to a human rather than guessing which half of the work was
already done. Exclusivity cannot be proven statically, so it is checked against the observations a
real walk produced.

**Steps separate effects from invariants.** A mutating step needs at least one DISCRIMINATING
expected effect: false before the action, true after. A flip is evidence, not proof of causality; we
require it because its ABSENCE is conclusive, and "the click was swallowed by a modal" is the most
common way legacy automation reports a false success. An invariant that has to flip is an effect
wearing the wrong label, and is rejected as one.

**The immutable profiles** (`config/condition-profiles/`, `config/safety-profiles/`). Written here,
never edited again. Their SHA-256 is pinned into every artifact and is part of the artifact content
hash. Patterns are PHRASES matched on whole words, not regular expressions: a safety rule a reviewer
cannot read is not a safety rule, and an over-permissive pattern in a safety profile fails OPEN.

**Detector and policy layering** (`src/artifact/detectors.ts`, `policy.ts`).

```
effective detectors = GLOBAL ENGINE + PINNED CONDITION PROFILE + capability additions
effective policy    = global INTERSECT tenant INTERSECT capability
```

A capability may be STRICTER, never weaker: approval refuses an artifact that tries, and at run time
the strictest layer wins, so a later global tightening binds capabilities approved under a looser
ceiling.

The detector ladder runs **global safety, hard failures, known outcomes, recoveries, needs_human**.
The order is the design: **terminal states are evaluated before non-terminal remediation**, because
a recovery is an ACTION and we must never act on a run that is already decided. A screen carrying
both a dismissible maintenance notice and a genuine `MEMBER_NOT_FOUND` returns the OUTCOME rather
than dismissing and retrying. Within the terminal rungs, hard failures precede known outcomes: a
screen showing both a permission denial and a stale "No member found" is a permission problem, and
calling it a clean business outcome would tell a caller the member does not exist when the truth is
that we were not allowed to look.

**The hashing lifecycle** (`src/artifact/hash.ts`, `approve.ts`). `contentHash` excludes exactly
`status`, `approvedAt` and `approvedBy`, and INCLUDES the profile pins. Approval recomputes and
verifies the pins, verifies the artifact, and changes only those three fields. So the content hash
of the draft and of the approved artifact are identical, which is what PHASE 10 provenance is built
on.

**The store** (`src/artifact/store.ts`). `/artifacts/<id>/<version>.json`. A published version is
immutable: `put` refuses to overwrite one, and `setStatus` verifies the content hash did not move
before it writes.

### How to check it

The most direct demonstration, start to finish:

```bash
mkdir -p artifacts-demo/prepare_subaccount_review && cp "examples/artifacts/prepare_subaccount_review@1.0.0.example.json" artifacts-demo/prepare_subaccount_review/1.0.0.json && npm run capability:approve -- prepare_subaccount_review@1.0.0 --by "your.name" --artifacts artifacts-demo
```

It prints the content hash before and after. **They are the same number.**

> **Why `artifacts-demo` and not `artifacts`.** `/artifacts` is the real store, and it is the exact
> path discovery will write to at GATE 1. A published version there is IMMUTABLE, so leaving the
> hand-authored example sitting at `artifacts/prepare_subaccount_review/1.0.0.json` would make the
> first real distillation fail with a refuse-to-overwrite error that looks exactly like a distiller
> bug. The demo therefore uses a throwaway store, gitignored. Delete it when you are done:
>
> ```bash
> rm -rf artifacts-demo
> ```

Then try the variations:

| What you do                                                                                  | What you get                                                                                                                            |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| approve it once                                                                              | pins verified, status flipped, identical content hash                                                                                   |
| approve it again                                                                             | refused: approval is not idempotent, a second one would overwrite who signed it and when                                                |
| append a comment to `config/condition-profiles/meridian-subaccount/1.0.0.yaml`, then approve | `PROFILE_INTEGRITY_FAILURE`, naming both hashes (restore the file afterwards)                                                           |
| omit `--by`                                                                                  | refused. An approval with nobody's name on it is not an approval, and quietly filling in the logged-in user would make it look like one |

Then the automated suite:

```bash
npm test -- tests/artifact.profiles.test.ts tests/artifact.states.test.ts
```

```bash
npm test -- tests/artifact.store.test.ts tests/artifact.docs.test.ts
```

**What each file is for.**

- `artifact.profiles.test.ts` - the profiles load and hash; the profile-to-fixture contract below;
  the safety profile refuses at least everything the PHASE 2 bootstrap minimum refuses; whole-word
  matching, so `Undeleted items` is not a delete; contextual deny; and the detector ladder,
  including a screen that carries both a recovery and a terminal outcome.
- `artifact.states.test.ts` - resume-eligible exclusivity checked against every recorded
  observation; a half-filled form matching no resumable state; the discriminating-effect rule and
  the invariant-is-an-effect rule, checked against real before and after screens; a conditional
  assertion skipped when its parameter is absent.
- `artifact.store.test.ts` - round trip; refuse-overwrite; version-diff classification; the content
  hash identical across a status flip and moving when a pin changes; approval refusing a bad pin, a
  weaker-than-global policy, and a second approval.
- `artifact.docs.test.ts` - the complete artifact embedded in `SCHEMA.md` parses, validates, passes
  the structural rules, and its pins verify against the real profile files. The documentation
  cannot drift from the code without a test failing.

### The profile-to-fixture contract

The profiles are immutable from now on, but most of the screens their detectors match arrive in
PHASE 6. The ordering only goes one way, and it is recorded in
[`fixtures/legacy-app/README.md`](../fixtures/legacy-app/README.md) under **PHASE 6 FIXTURE
CONTRACT**:

> PHASE 6 must make the fixture match these strings verbatim. Not the reverse.

Two detectors are **already satisfied today** and are tested against real captures, so part of the
contract is proven honoured before the hashes were pinned into anything:

| Condition                         | Detector                  | What the fixture really renders                      |
| --------------------------------- | ------------------------- | ---------------------------------------------------- |
| `MEMBER_NOT_FOUND`                | text `No member found`    | `No member found for that ID.` (member 99999)        |
| `APPLICATION_VALIDATION_REJECTED` | control with role `alert` | the validation region already carries `role="alert"` |

### About the example artifact

`examples/artifacts/prepare_subaccount_review@1.0.0.example.json` is **hand-authored for
documentation and was not produced by a discovery run.** Its provenance block says so in plain
text. Its profile pins and its specHash are COMPUTED from the real files, every locator in it came
out of a real capture, and it passes the same schema, structural rules and approval checks as any
distilled artifact would. See `examples/artifacts/README.md`.

---

## Deliberately absent

Not oversights. Each belongs to a later phase, and building it now would be building ahead.

| Absent                                                                             | Phase |
| ---------------------------------------------------------------------------------- | ----- |
| Artifact schema, profile YAML with pinned hashes, capability store                 | 3     |
| The discovery loop and the distiller                                               | 4     |
| `ReplayEngine`, and the import-boundary scan proving replay makes zero LLM calls   | 5     |
| Business outcomes at runtime, known conditions, fault injection in the fixture     | 6     |
| The configurable policy engine, PII pseudonymization, screenshot masking           | 7     |
| The human handoff protocol (pause / cede / resume)                                 | 8     |
| Cross-tenant support and `tenants/tenant-b.ts`; `semanticKey` is unused until then | 11    |
| `README.md`, `REPORT.md`, `/evidence/README.md`                                    | 10    |

`npm run discover | replay | operator` currently exit 2 and name the phase that builds them.
`capability:approve` is real as of PHASE 3. That is deliberate: a script that fails loudly beats one that is missing.

**Also disclosed:** screenshots captured today are UNMASKED. Without OCR it is not possible to prove
a sensitive value is absent from screenshot pixels. PHASE 7 masks declared boxes, and the claim will
be scoped to exactly that.
