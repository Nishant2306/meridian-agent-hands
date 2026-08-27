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

Expect: no type errors, no lint errors, and **444 tests passing across 43 files**.

### Two test commands

| Command             | What it runs                                               | Time  |
| ------------------- | ---------------------------------------------------------- | ----- |
| `npm run test:fast` | everything except the browser-driven files                 | ~8s   |
| `npm test`          | all of it, including NINE files that drive a real Chromium | ~125s |

**How long `npm test` takes, honestly.** It varies by a factor of three on the same code and the
same machine: measured runs at the end of PHASE 8 came back at 148s, 343s, 373s and 380s, with the
number of tests changing by ten between the first and the rest. `test:fast` is stable at 9-11s.

The suite is almost entirely CPU-bound on real Chromium, so it is very sensitive to whatever else
the machine is doing - and after several hours of running browsers, that includes the machine's own
state. Earlier versions of this file quoted single figures measured under load (295s, 215s), and one
measured on an idle machine (124s); none of them was wrong so much as unrepeatable.

**So take a range, not a number**: roughly 2 minutes on an idle machine, up to 6 under load. If
yours is much worse than that, check what else is running before believing it is the code.
`test:fast` is the one to use inside a phase. Earlier versions of this file quoted 215s and 295s, both of
which were measured while browsers from other work were running alongside - a full suite that is
almost entirely CPU-bound on Chromium roughly doubles under that. If your number is much larger,
check what else is using the machine before believing it.

Files run SERIALLY (`fileParallelism: false` in `vitest.config.ts`). Parallelism was measured at
about 17% faster and is not enabled by default; the reasoning is in that file.

`test:fast` excludes `**/*.live.test.ts` and nothing else. **No test is weakened or skipped to
achieve it** - the same assertions run, in fewer files. Use the fast one while working inside a
phase and the full one at every gate; the browser-driven files are where perception, the input path
and the discovery loop are actually proven, so they are not optional before a gate.

### Environment and .env

Copy `.env.example` to `.env` at the repository root and fill it in. Node does not read `.env` on
its own, so each entry point that touches the environment loads it explicitly through
`src/config/env.ts`:

| Entry point         | Needs                                                  |
| ------------------- | ------------------------------------------------------ |
| `npm run discover`  | `ANTHROPIC_API_KEY` and `LLM_MODEL`, both required     |
| `npm run replay`    | nothing required; reads `OPERATOR_ID` etc. if present  |
| `npm run dev:app-a` | nothing required; reads `FIXTURE_SEED` and `LOG_LEVEL` |

The root is located by walking up from the module, not from the working directory, so it behaves
the same under `npm run ...`, under a bare `tsx src/cli/discover.ts`, and from any directory in
either PowerShell or Git Bash. A variable already set in the shell wins over the file, so
`LLM_MODEL=... npm run discover` overrides for a single run.

A missing variable names itself and says whether a file was read at all:

```text
Missing required environment variable: LLM_MODEL

  LLM_MODEL  present but empty (there is nothing after the "=")

Read .env from: <repo>\.env
```

`tests/config.env.test.ts` pins that behaviour, including the case that caused the confusion: a
`.env` that exists and is never read must not produce the same message as a `.env` that was read and
is missing a line. See DECISIONS.md D33.

### Reading real distiller output

```bash
npm run distill:demo
```

Runs the scripted happy path against the real fixture and writes a distilled artifact to the
throwaway `artifacts-demo/`. Everything except the choice of action is genuine - real browser, real
accessibility tree, real input path, real guardrails, real distiller - and **no model is called**.
The artifact says so about itself: its provenance records
`model: "scripted-fake-NO-MODEL-WAS-CALLED"`.

It exists so the distiller can be examined while it is the ONLY variable. At GATE 1 the model
becomes a variable too, and debugging two things at once is how a gate turns into an afternoon.

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
3. static policy precheck - the configurable engine, ALONGSIDE the minimum (added in PHASE 7)
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
  bounding box. The box is what screenshot masking draws (PHASE 7) and is never used to locate
  anything.
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
whose name matches the irreversible patterns is refused. It was written to stand in the gap before
the configurable engine existed, and it is what actually stood behind both real model runs at
GATE 1. PHASE 7 added the engine ALONGSIDE it rather than in place of it, and it is still enforced
first on every action - see [Phase 7](#phase-7---safety-redaction-console-security-complete).

**Evidence** (`src/evidence/logger.ts`). Typed JSONL events plus screenshots under `/runs/<runId>/`.
Secret VALUES never enter an event: bindings are described by name - a stronger property than
redaction, because there is nothing present to redact. PII pseudonymization and screenshot masking
were deferred to PHASE 7 behind a single `redactForPersistence` seam, and PHASE 7 filled both in at
that seam rather than auditing every call site.

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

The profiles became immutable at the end of this phase, and most of the screens their detectors
match did not exist yet. The ordering only ever went one way, and it is recorded in
[`fixtures/legacy-app/README.md`](../fixtures/legacy-app/README.md) under **PHASE 6 FIXTURE
CONTRACT**:

> PHASE 6 must make the fixture match these strings verbatim. Not the reverse.

**PHASE 6 honoured it**: the fixture was changed to match the profile twice, and the profile was not
touched. See [Phase 6](#phase-6---runtime-outcomes-complete) and DECISIONS.md D43.

Two detectors were **already satisfied at the time this phase closed** and are tested against real
captures, so part of the contract was proven honoured before the hashes were pinned into anything:

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

## Phase 4 - discovery and the distiller (COMPLETE)

**No real model call was made in this phase.** Every behaviour below is exercised with a scripted
fake client and no API key. The first genuine discovery run was GATE 1, at the end of PHASE 5; see
[GATE 1](#gate-1---the-first-real-model-against-a-live-ui) for what it found.

### What exists

**The action space** (`src/agent/tools.ts`). No tool accepts a CSS selector, an XPath or
coordinates: there is nowhere to put one. The model may reference exactly one kind of thing, a
`markId` from the inventory it was just shown, and the system converts that into a full
`TargetDescriptor` before anything is recorded. Mark ids never reach an artifact, and `value` is
always the `ValueBinding` union - `{kind:'literal',value:'memberId'}` and
`{kind:'param',name:'memberId'}` are different things, and a bare string cannot tell them apart.
There is no `press_key` in v1.

**Conversion and validation before acting** (`src/agent/proposal.ts`). Six steps, in order: look the
mark up in the exact observation the model saw, build a descriptor, capture a FRESH observation,
check screen-context compatibility, resolve the DESCRIPTOR through the same resolver replay uses,
and only then act. Step 4 does more than it looks like: it proves DURING DISCOVERY that every
descriptor about to be recorded is resolvable by the replay engine.

**Descriptor synthesis** (`src/agent/descriptors.ts`). Interactive controls are identified by their
accessible NAME; cells and text by their nearby LABEL, never by their own text. The member-name cell
is called "Avery Lin", and identifying it that way would produce a capability that only worked for
Avery Lin and would write a member's name into a stored artifact. A control sitting in a row keyed
by an invocation value gets a PARAMETERIZED row key, preferred over the plain name even when the
name resolves uniquely today: a search for one member returns one row, so "the link named Open" is
unambiguous now and wrong on the next invocation that returns four. There is no ordinal fallback.

**Verified completion** (`src/agent/completion.ts`). `propose_goal_reached` does not end the run.
The system captures a FRESH observation, extracts every declared output from its bound source,
validates each against its DECLARED type, and re-checks the record identity itself.

**The model boundary** (`src/agent/boundary.ts`, and [`DATA_HANDLING.md`](DATA_HANDLING.md)).

**The system prompt** (`src/agent/prompts/v1.ts`), versioned, with `promptVersion` recorded in every
artifact. It does NOT tell the model to go looking for error states: known error semantics come from
the reviewed condition profile and controlled fault injection, not from a model improvising what an
error looks like.

**Stopping conditions** (`src/agent/loop.ts`), all bounded and all recorded: 30 steps, 5 minutes,
3 consecutive no-progress steps, a repeated-action loop, one tolerated parse failure, `give_up`,
`request_human`.

**The distiller** (`src/artifact/distill.ts`, `path.ts`, `parameterize.ts`). Fails closed at every
stage: a run that cannot be distilled into something satisfying every rule produces no artifact at
all, with the reasons listed. It has no access to a model - its only input is a
`DiscoveryRunRecord`.

### The two things worth checking closely

**1. Verified completion is genuinely independent.** It takes a FRESH observation, not the cached
one the model reasoned over - a model that has convinced itself it is finished has by construction
been reasoning over a screen that supports that conclusion.

`tests/agent.verification.test.ts` runs a discovery that does everything right **on the wrong
member**. Every declared output extracts and validates: the member name is a real name, the account
type is a declared enum member, the status really is `PENDING REVIEW`. The only thing wrong is the
identity, which is precisely the failure no output check would catch. Discovery does not succeed,
`successObservationId` stays null, and the reason names it:

```
THE RECORD ON SCREEN IS NOT THE RECORD THAT WAS REQUESTED.
```

**2. Path reconstruction is segment-based.** The tempting algorithm - "drop any action whose
resulting state was already visited" - deletes two of three field fills, because three fills all
leave you on the same screen. The artifact still distils and still looks plausible; replay then
fails on Continue, several steps from the two that were quietly removed, and the failure looks
nothing like a distiller bug.

So the unit of reasoning is the SEGMENT. Within a retained segment, the ONLY thing removed is an
action the run itself RECORDED as a no-op. `tests/agent.discovery.test.ts` asserts against a real
scripted run that all three parameter bindings survive; `tests/artifact.distill.test.ts` tests the
algorithm directly, including a branch the run backed out of.

A third signal had to be added to make "no-op" mean something precise: `changedInventory`. Running a
search changes neither the screen name nor the button that ran it, so on screen identity and target
value alone a search looks like a no-op and would be deleted.

### How to check it

```bash
npm test -- tests/agent.discovery.test.ts tests/agent.verification.test.ts
```

```bash
npm test -- tests/agent.proposal.test.ts tests/artifact.distill.test.ts
```

**What each file is for.**

- `agent.discovery.test.ts` - a full scripted run against the real fixture and a real browser: the
  goal is reached and the SYSTEM declares it; the model is never shown a value it typed or any
  secret; the model IS still shown values it read (rule 3); all three fills survive distillation;
  the artifact carries verified pins and no runtime values; a condition the run merely MET stays out
  of the artifact.
- `agent.verification.test.ts` - the hallucinated completion, the wrong-member completion, and the
  no-progress stopping condition.
- `agent.proposal.test.ts` - conversion, including the STALE_OBSERVATION_CONTEXT case where a
  same-named control exists on the new screen so re-resolution alone would have succeeded; row-key
  parameterization; a value cell identified by its label rather than its value.
- `artifact.distill.test.ts` - the segment algorithm, the parameterization sweep (four classes), and
  the reviewability lint including the read-step exemption.

**The real run**, once you have a key in `.env`:

```bash
npm run discover -- --spec config/specs/prepare_subaccount_review.yaml --goal "Find the member identified by parameter memberId, prepare the requested sub-account, and reach the review screen without submitting." --target tenant-a --inputs '{"memberId":"10001","accountType":"Savings","nickname":"Vacation","initialDeposit":"250.00"}'
```

It writes `/runs/<runId>/` with `events.jsonl`, `transcript.jsonl`, screenshots,
`proposed-conditions.json`, `result.json`, `metrics.json` and `run.json` - the full run record, so a
distillation can be re-done without paying for another run - and puts a **draft** artifact in the
store. It is the only command in this repository that spends money, and the fixture must be running
(`npm run dev:app-a`). It was first run at GATE 1.

Sign-on is a PRECONDITION, not part of the capability: the CLI authenticates and then hands over. A
capability that carried a credential would be a capability that could be replayed into an account.

---

## Phase 5 - replay (COMPLETE)

The end-to-end slice works: **the model discovers, the artifact becomes a capability, replay
invokes it** - with no model anywhere in the replay loop. Happy path only, as scoped.

### The no-LLM proof, three layers

| Layer      | Where                                  | What it proves                                                                                                             |
| ---------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Structural | `ReplayDeps` in `src/replay/engine.ts` | no client field, so there is nothing to inject                                                                             |
| Test       | `tests/replay.boundary.test.ts`        | walks the module graph from `src/replay/index.ts`; fails if `src/agent/` or a provider SDK appears anywhere in the closure |
| Runtime    | `src/observability/provider-calls.ts`  | a counter snapshotted around every replay; `metrics.llmCalls` is asserted zero before a result is returned                 |

It is a COUNTER, not a "replay mode" flag: a flag describes the process and breaks the moment
discovery and replay share one. The boundary test carries a **negative control** - it also walks
`src/agent/index.ts` and asserts the walker DOES find the forbidden imports there, because a broken
walker returning nothing looks exactly like a clean boundary.

### Session bootstrap: authentication is not part of the capability

`SessionBroker` opens the allowlisted origin, authenticates via SECRET REFERENCES, navigates to the
entry point, and VERIFIES the authenticated precondition before handing the session over. The
capability begins at "authenticated, on member search", and there is no field in the artifact
schema that could hold a credential. The sign-on descriptors live in `src/config/sign-on.ts`,
which is deployment configuration.

**Corrected after PHASE 5.** This section previously claimed both CLIs used that one definition.
They did not: `SessionBroker` used `MERIDIAN_SIGN_ON` while `src/cli/discover.ts` carried its own
copy of the same descriptors, and the doc comment in `src/config/sign-on.ts` asserted the sharing
that was not happening. The copies agreed, which is the dangerous form of that bug - nothing fails
and the copies drift later. Discovery and replay authenticating by different paths is precisely the
drift that makes a recorded capability not match the thing that replays it. The duplicate is now
removed and the claim is enforced by `tests/config.sign-on.test.ts`, which reads the source rather
than running discovery. See DECISIONS.md D35.

### Execution order

1. every caller parameter against OUR contract -> `INPUT_VALIDATION_FAILED`, **before the browser opens**
2. the pinned profiles -> `PROFILE_INTEGRITY_FAILURE`
3. fingerprint pre-flight -> `FINGERPRINT_MISMATCH` (block, do not guess)
4. declared preconditions -> `PRECONDITION_FAILED`
5. per step: resolve and perform -> integrated observation loop -> verify effects and invariants -> extract outputs due at the reached state
6. the success state, and every invariant

Steps 1 and 2 reach a verdict without observing anything, and the test proves it with a surface
that throws if touched.

**Discovery now has step 1 too.** It did not until after PHASE 5. `runDiscovery` calls the same
`validateInvocationParams` as its first statement and returns `INPUT_VALIDATION_FAILED` before it
observes anything or calls the provider; `npm run discover` calls it again before constructing the
client or launching Chromium. This was found the expensive way: `--inputs '{}'` opened a browser,
signed on, and spent three model calls before the missing parameter surfaced as
`EFFECT_NOT_OBSERVED`, which is a true statement about the symptom three actions after the cause.

```bash
npx vitest run tests/agent.loop.inputs.test.ts
```

Seven tests, a surface and a client whose every method throws, asserting neither is reached - plus a
negative control where a valid invocation must get PAST the gate and reach the surface. See
DECISIONS.md D34. One validator serves both halves: it takes declared inputs rather than an
artifact, and lives in `src/artifact/params.ts` because `DiscoverySpec.inputs` and
`CapabilityArtifact.inputs` are the same schema.

### The integrated observation loop

After an action, on EVERY pass until the deadline: observe, then safety detectors, then hard
failures, then known business outcomes, then recoveries, then the expected effect - and only then
poll again.

**Why detectors are inside the wait and not after it.** Search for a member who does not exist. The
next step's expected effect is a member-details screen, and that predicate will never become true.
A wait-then-check design sits there until the timeout and reports `TIMEOUT` - a FAILURE, escalated
to a human - for a run in which everything worked and the answer was simply "no such member".

Measured, end to end through the CLI:

```
--params '{"memberId":"99999",...}'
{"status":"business_outcome","outcome":"MEMBER_NOT_FOUND",...}   exit 10, 586ms
```

Not a ten-second timeout, and not exit 30.

### Retry safety

Before ANY retry, re-observe and check whether the expected effect ALREADY holds; if it does, the
step is marked complete and the action is NOT repeated. Stated honestly: this capability is
deliberately non-mutating end to end, so a duplicate action here is merely wasteful. On a
capability that submits anything, re-observing first is the difference between one request and two.

### Recoveries when nothing matches

At the time this phase closed, the recovery detectors referenced screens the fixture did not yet
render, so nothing matched them. A step declaring `try_recoveries_then_fail` therefore took the real
no-match path: detectors were consulted on every pass of the observation loop, nothing applied, and
the step fell through to failure saying so. The path was never stubbed away, which is why PHASE 6
could add a matching screen and exercise the other branch without touching this code.

### How to check it

```bash
npm run dev:app-a
```

Then, in another shell:

```bash
npm run distill:demo
```

```bash
npm run replay -- --artifact prepare_subaccount_review@1.0.0 --params '{"memberId":"10002","accountType":"Checking","initialDeposit":"99.00"}' --artifacts artifacts-demo --json
```

**Exit codes** (these belong in README.md, which is PHASE 10):

| Code | Status             | Meaning                                                              |
| ---- | ------------------ | -------------------------------------------------------------------- |
| 0    | `success`          |                                                                      |
| 10   | `business_outcome` | the automation worked and the answer is negative. **Not** a failure. |
| 20   | `needs_human`      |                                                                      |
| 25   | `cancelled`        |                                                                      |
| 30   | `failed`           |                                                                      |

Variations worth trying:

| Params                               | What you get                                                             |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `memberId: "99999"`                  | `business_outcome` / `MEMBER_NOT_FOUND`, exit 10, in well under a second |
| `memberId: "abc"`                    | `INPUT_VALIDATION_FAILED`, exit 30, and **no browser opens**             |
| no `nickname`                        | success, and the nickname step is reported `skipped`                     |
| append a comment to a pinned profile | `PROFILE_INTEGRITY_FAILURE` before anything is observed                  |

Then the tests:

```bash
npm test -- tests/replay.boundary.test.ts tests/replay.test.ts
```

```bash
npm test -- tests/replay.live.test.ts tests/replay.cli.live.test.ts
```

**What each file is for.**

- `replay.boundary.test.ts` - the module-graph walk, plus its negative control.
- `replay.test.ts` - the execution order proven with a surface that throws if touched: a bad
  member id and a tampered profile both reach a verdict without observing anything.
- `replay.live.test.ts` - **the end-to-end slice.** Discovery drives the real fixture with a
  scripted client, the distiller produces a capability, and replay executes it: happy path with
  typed outputs and zero llm calls; **member 10002, whom discovery never saw**; the nickname step
  SKIPPED and recorded when no nickname is supplied; and determinism across three runs with
  identical steps, tiers and outputs - each against a freshly booted fixture that regenerated every
  class name and element id.
- `replay.cli.live.test.ts` - the `--json` contract, run as a real subprocess: exactly one JSON
  object on stdout, no log lines, on both a successful run and one that fails before the browser
  opens; and exit 10 for a business outcome.

### Three defects the first real replay found

Worth recording, because all three distilled and validated cleanly first:

1. **An invariant that does not survive its own transition.** The distiller took the strong
   identity check from the FROM screen; that cell does not exist on the TO screen. Fixed by
   choosing an invariant that holds on both, and by a new distiller rule that rejects an invariant
   which is false before or after the action. See DECISIONS.md D30.
2. **Row-keyed targets stopped resolving in the discovery loop's diagnostics**, because the row key
   became a constraint on every tier and the diagnostic resolve was not binding parameters. The
   symptom was cosmetic - step ids degrading to `step-3-click` - and the cause was not.
3. **The distiller was still emitting `schemaVersion: 1`** after the bump, which the replay test
   caught immediately.

---

## Phase 6 - runtime outcomes (COMPLETE)

What happens when the application does not cooperate. Every condition here is described by the
condition profile that was PINNED IN PHASE 3 and is never edited: the fixture was made to match it.

### Fault injection is per SESSION, never a server-wide flag

```bash
curl -X POST http://localhost:4180/__test__/faults \
  -H 'content-type: application/json' -H 'cookie: MERIDIAN_SESSIONID=...' \
  -d '{"showKnownNotice":true}'
```

| Flag                        | What it does                                                    |
| --------------------------- | --------------------------------------------------------------- |
| `slowLoadMs`                | delays every servicing response. A BOUNDED wait, not a failure. |
| `showKnownNotice`           | the scheduled-maintenance notice - a RECOVERY                   |
| `showUnknownModal`          | a blocking modal the profile deliberately does not describe     |
| `expireSession`             | every screen answers with the session-expired page              |
| `validationErrorOnContinue` | the application refuses the form -> review transition           |
| `http500OnRoute`            | one route answers 500 with a readable page                      |
| `denyPermission`            | member screens answer with the permission-denied panel          |
| `relabelContinueButton`     | DRIFT: the label changes, the legacy-stable `name=` does not    |

Keyed by the `MERIDIAN_SESSIONID` cookie, or `X-Fault-Session` for a caller that has not signed on
yet - which `expireSession` needs, since it must be armed before the session it affects is used.

A server-wide flag would let the vitest file testing SESSION_EXPIRED break the file testing a slow
load, intermittently, and the failure would move when tests were reordered. See DECISIONS.md D42.

**Two members carry their behaviour in the seed data, with nothing armed**: 10003 is `restricted`
and answers PERMISSION_DENIED; 10004 is `knownNotice` and shows the maintenance notice.

### The detector ladder, unchanged since PHASE 3 and now exercised

1. global safety -> failed
2. hard failures -> failed
3. known business outcomes -> **business_outcome, not failed**
4. recoveries - the first rung that TAKES AN ACTION
5. unrecognised blocking state -> needs_human
6. continue

Rung 5 had no way to fire before this phase. It now detects a blocking dialog STRUCTURALLY, by role,
for the same reason `APPLICATION_VALIDATION_REJECTED` is detected by the alert region: the wording
of a modal belongs to the application, and a role does not.

### How to check it

```bash
npx vitest run tests/fixture.faults.test.ts          # no browser, ~1s
npx vitest run tests/replay.outcomes.live.test.ts    # real Chromium, ~35s
npx vitest run tests/replay.downgrade.live.test.ts   # real Chromium, ~22s
```

| Claim                                                            | Test                                             |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| a fault in one session is invisible to another                   | two sessions, one app instance                   |
| every fault screen matches the PINNED detector                   | reads the real profile, not a copy               |
| 99999 -> `MEMBER_NOT_FOUND`, and NOT `failed`                    | `replay.outcomes.live`                           |
| **99999 detected BEFORE the timeout**                            | asserts elapsed < the step's own timeout         |
| 10004 recovers once, `recoveriesUsed === 1`                      | `replay.outcomes.live`                           |
| **the interrupted click is NOT repeated**                        | asserts `attempts === 1`                         |
| 10003 -> `PERMISSION_DENIED` with expected AND observed          | `replay.outcomes.live`                           |
| `validationErrorOnContinue` -> `APPLICATION_VALIDATION_REJECTED` | `replay.outcomes.live`                           |
| `expireSession` -> `SESSION_EXPIRED`, session reported gone      | `replay.outcomes.live`                           |
| `http500OnRoute` -> `APPLICATION_UNAVAILABLE`, not `UNKNOWN`     | `replay.outcomes.live`                           |
| a killed browser -> `SURFACE_UNAVAILABLE`, not an exception      | closes a REAL Chromium mid-run                   |
| `showUnknownModal` -> `needs_human`                              | `replay.outcomes.live`                           |
| a tier downgrade reaches step, evidence AND metrics              | `replay.downgrade.live`, with a negative control |

### The timing assertion is the load-bearing one

```
99999 -> {"status":"business_outcome","outcome":"MEMBER_NOT_FOUND"}   in ~2.5s
```

If detectors ran AFTER the wait rather than inside it, this would still report `MEMBER_NOT_FOUND`
eventually. The code would look correct and a status-only test would pass. What would differ is the
clock: every "no such member" would cost a full timeout. So the assertion is on ELAPSED TIME against
the step's own timeout, which is the only way to tell "detected" from "gave up and then noticed".

### The failure report

`formatResultForHuman` is what `npm run replay` prints on stderr when a run does not succeed:

```
prepare_subaccount_review@1.0.0 FAILED: PERMISSION_DENIED

capability:         prepare_subaccount_review@1.0.0
step:               step-3-open
  intent:           Click Open in the row identified by memberId ...

expected:           the Member Record screen is shown
observed:           The signed-on operator is not entitled to view this member ...

tiers attempted:    step-1-search -> T1_EXACT_ROLE_NAME
                    step-3-open -> T5_STRUCTURAL_ROW
recoveries:         none
session:            still alive
evidence:           runs/replay-...
```

The test of it is whether somebody who did not watch the run can decide what to do next without
opening the artifact, the evidence bundle, or the code. See DECISIONS.md D48.

### Three defects this phase found, none of them in the code it was about

1. **A detector phrase in a bare `<div>` is invisible to its own detector.** The inventory drops
   StaticText deliberately; the phrase has to be in a `<p>`. Found by observing the screen.
2. **A container whose PRESENCE is the signal was dropped as noise.** `isNoiseStructure` drops a
   non-interactive node that contains an interactive one - correct for a wrapper, wrong for a
   dialog, and latently wrong for the `alert` region the validation detector depends on. D44.
3. **A recovery on a step with `retries.max: 0` never rechecked anything.** The recheck was reached
   only by continuing into the next retry iteration. D45.

---

## Phase 7 - safety, redaction, console security (COMPLETE)

### The policy engine sits ALONGSIDE the bootstrap minimum

`config/allowlist.yaml` is deployment configuration - origins, routes, action types, deny patterns,
a risk ceiling and a run budget. It is NOT pinned by hash into artifacts, because it describes the
deployment rather than the capability, and two deployments legitimately differ here.

**The PHASE 2 minimum was not removed.** It runs first at both enforcement points inside
`resolveAndPerform`; the engine runs second. The effective decision is the strictest of the two, and
a configuration that switches the minimum off is not expressible because the minimum is not
configuration.

```bash
npx vitest run tests/policy.engine.test.ts
```

| Claim                                                       | Asserted                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| an off-origin navigate is refused                           | by the minimum AND by the engine, separately               |
| every action type on "Submit Request" is refused            | by the minimum AND by the engine, `read` included          |
| the engine can only tighten                                 | `/subaccount/submit` passes the minimum, engine refuses it |
| an artifact declaring "Submit Request" SAFE is not believed | `effectiveRisk` takes the MAXIMUM                          |
| there is no override flag anywhere                          | greps the CLIs and the engine for one                      |

### One input path, enforced mechanically

```bash
npx vitest run tests/policy.input-path.lint.test.ts
```

Fails if `page.click`, `page.goto`, `page.fill`, `page.type` or their relatives appear outside
`src/surface/playwright-web/`. One such call bypasses the lease, the minimum, the engine, the single
resolver and the revalidation step - and in a diff it looks like a shortcut in a test helper.

It found one the day it was written: `scripts/inventory.ts` called `page.goto` directly. See
DECISIONS.md D51.

### THREE data mechanisms, and they are not the same thing

|                | Where                                        | What happens                              |
| -------------- | -------------------------------------------- | ----------------------------------------- |
| Persistence    | logs, transcript, evidence, human CLI output | pseudonymized in place                    |
| Artifacts      | distillation                                 | **scanned and REJECTED**, never rewritten |
| Caller results | `replay --json` on stdout                    | **not redacted**                          |

The third is the one that gets "helpfully" broken. The brief requires replay to RETURN what it read;
an agent that asked for the review status and got `[reviewStatus:subject-01]` has been given
nothing. `tests/replay.cli.live.test.ts` asserts both halves in one test: the real value on stdout,
absent from stderr.

**The pseudonym map is per-run and random.** A truncated hash of a five-digit member id is
enumerable in under a second. `PSEUDONYM_SECRET` switches to HMAC-SHA-256 at 8 bytes minimum,
refused below that. Card detection Luhn-validates first, so account numbers and references survive
and the logs stay readable.

### Screenshot masking, checked in pixels

```bash
npx vitest run tests/redaction.test.ts              # no browser
npx vitest run tests/redaction.masking.live.test.ts # real Chromium, real boxes
```

Only the masked image is written; the unmasked bytes never get a filename. Regions come from
`PerceivedControl.box`, captured since PHASE 2 and unused until now, offset into page space and
recorded in a `.mask.json` manifest beside the image.

The live test decodes the written PNG, samples the centre of a masked region and requires the mask
colour, then requires that less than a quarter of the image is mask-coloured - otherwise "we painted
the whole screenshot" would pass. PNG decode/draw/encode is hand-rolled on Node's `zlib` rather than
adding a dependency. See DECISIONS.md D56.

**Honest limitation, stated here and in `DATA_HANDLING.md`:** we mask DECLARED regions. We do not
OCR and we do not claim the value is absent from the pixels.

### Operator console security, before the console does anything

`src/escalation/console-security.ts`. The handoff protocol is PHASE 8; this is the shell it runs
inside, built first because access control retrofitted onto a working console is access control that
ships without any.

Loopback-only (the host is a constant, not a parameter) · 32-byte per-run token · **the token is
never in a URL** - the CLI prints them on separate lines · token exchanged for an HttpOnly,
SameSite=Strict, short-lived, intervention-scoped cookie · CSRF checks on every state-changing
request · unguessable intervention ids · **no list-all endpoint**, and an unknown id gets the same
answer as a bad token so it is not an oracle.

```bash
npx vitest run tests/escalation.console.test.ts
```

**Not implemented, and REPORT.md will say so:** enterprise identity, RBAC, per-operator accounts,
remote operator auth. What it must not say is that the console has no access protection.

### Two defects this phase found in code it was not about

1. **The session broker ignored whether sign-on worked.** It fired four actions and discarded every
   result, so a blocked step surfaced as "signed on, but Member Search never appeared" - a
   description of the symptom that points away from the cause. D57.
2. **`frame.evaluate(string)` evaluates an EXPRESSION.** Handed a function declaration it returned a
   function object, the call threw, the throw was caught, and every box silently stayed in frame
   coordinates - so masks would have landed in the wrong place with nothing failing. Only the live
   test could catch it. D56.

### One requirement that could not be met, and why

`banking-default 1.0.0` - PINNED, hashed into the GATE 1 artifact - contains bare words like
`transfer` in its irreversible list, so "Transfer history" is refused. The PHASE 7 requirement that
deny patterns be contextual is met by the allowlist, which this phase controls; it cannot be met by
the profile, which is immutable. The false positive is asserted out loud in
`tests/policy.engine.test.ts` rather than hidden, and the real fix is a `2.0.0` profile. See
DECISIONS.md D54.

---

## Phase 8 - human handoff (COMPLETE)

The run stops, a person takes control of **the same live browser session**, does something the
automation cannot, hands control back, and the SYSTEM decides the outcome.

### Drive it yourself

```bash
npm run demo:store        # only needed on a fresh clone - see below
npm run dev:app-a         # the fixture, on http://localhost:4180

npm run replay -- --artifact prepare_subaccount_review@1.0.0   --artifacts artifacts-demo   --params '{"memberId":"20001","accountType":"Savings","initialDeposit":"250.00"}'
```

`/artifacts` holds run output and is gitignored, so a fresh clone has no capability to replay.
`npm run demo:store` copies the TRACKED example into `artifacts-demo/`, which is a throwaway store -
never into `artifacts/`, because a published version there is immutable and would refuse the next
real discovery. If you have run `npm run discover` yourself, drop the `--artifacts` flag and it uses
your own approved artifact instead.

Member `20001` raises a blocking modal the pinned condition profile deliberately does not describe.
The run stops, prints the console URL and - **on a separate line** - the token, and blocks:

```
An operator is needed.
  url:          http://127.0.0.1:58220/i/iv_6bd9d88ae1f349e0976b39
  token:        xTxpsxHiz2kGIXL-YZsH7l3VNTkV6awQB5EpmHmTjvI
  why:          a blocking dialog ("Compliance attestation required") is displayed...
  step:         step-3-open-member - Open the member record from the results row for this member id.
  screen:       Member Record
```

Open the URL, paste the token, look at the masked live view. Then, **in the browser window that is
already open**, type the attestation code shown in the modal and submit it - the code is printed on
screen, because a demo that needs knowledge a reviewer does not have is a demo a reviewer cannot run.
The modal clears. Press Resume. The system re-observes, works out where it is, finishes the form, and
reports `success` with `completionMode: 'human_assisted'`.

`--no-operator` turns the handoff off, and a needs_human condition is terminal again - the right
behaviour for an unattended caller with nobody to ask.

### Every step of that walkthrough is exercised by a browser

Not by an API call. The mechanism was proven three times while the path a person takes was broken -
the fixture seeding, the console page, and the attestation control - so each line above is now
covered by something that clicks.

| Walkthrough step                                                | Covered by                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run demo:store` puts a replayable capability in place      | run, and the CLI loads it                                              |
| `npm run dev:app-a` serves on 4180                              | run: `GET /` 200, `/__test__/seed` answers                             |
| `npm run replay` stops and prints URL + token on separate lines | run; `escalation.console.page.live` asserts the URL is the page's      |
| opening the URL with no cookie shows a token prompt             | `escalation.console.page.live` - real browser GET                      |
| pasting the token reveals the operator view                     | `escalation.console.page.live` - fills and clicks                      |
| the masked live view renders                                    | `escalation.console.page.live`                                         |
| **typing the code and submitting CLEARS the modal**             | `fixture.human-controls.live` - real click, asserts the screen changed |
| the member record stays clear afterwards                        | `fixture.human-controls.live` - three revisits                         |
| pressing Resume hands control back                              | `escalation.console.page.live`                                         |
| the run then finishes as `human_assisted`                       | `escalation.handoff.live` - real browser, same session                 |
| the whole happy path is clickable by a person                   | `fixture.human-controls.live` - search, open, form, review             |

### Control transfer

```
AUTOMATION_RUNNING
  -> PAUSING            automation has stopped; NO actor may act
  -> [AUTOMATION lease revoked, HUMAN lease issued]
  -> HUMAN_CONTROL      the person acts in the window already on their screen
  -> RESUME_VALIDATION  human lease released, the system re-observes and decides
```

The run process stays alive and the browser context is **not** recreated. Mutual exclusion is the
lease and the session state, independently: issuing the HUMAN token invalidates the AUTOMATION token,
AND `HUMAN_CONTROL` admits HUMAN actions only. One of them being wrong must not mean two actors can
drive at once.

**The evidence that it was the same session.** `browserContextId` and page `targetId` are captured
before control is ceded and again when it comes back, written as two events plus an explicit
`handoff_same_session` comparison. A handoff that closed the browser and opened a fresh one would
look identical in a screenshot, a log and a demo - and would have thrown away the authenticated
session. This is the only hard fact in the handoff story; everything else is a claim about code.

### [MUST] There is no /complete

The console offers `resume` and `abort`. `allowedChoices` is typed as those two, and a test asks the
server for `/complete`, `/success` and `/done` and requires 404 from each.

`resume` subsumes completion: the system re-observes, evaluates the success condition, validates every
declared output against its declared type, and declares success itself. "Only the system may declare
success" has bound the model since PHASE 4; this is where it either binds the operator too or is a
claim about models only.

A run a person helped with reports `completionMode: 'human_assisted'`, permanently.

### [MUST] Safe resume is anchor matching

Not "the furthest checkpoint that still holds". Checkpoints are not monotonic: a member id appears on
four screens, a heading can appear inside a modal, a person can jump to a later route without filling
what the earlier one required, and two states can hold at once.

| The screen the human left   | What happens                                                       |
| --------------------------- | ------------------------------------------------------------------ |
| the review screen           | the SUCCESS state -> validate outputs -> success, `human_assisted` |
| the member record           | exactly one resume point -> continue from the step leaving it      |
| a **partially** filled form | matches NOTHING -> back to the human                               |
| a **different member**      | HARD FAILURE. Never continue on the wrong record                   |
| two resume points match     | AMBIGUOUS -> back to the human                                     |
| the blocker is still there  | the same question, asked again                                     |

The partial-form row is the one worth reading twice. `subaccount-form` is not resume-eligible;
`subaccount-form-complete` is, and it requires every value. A half-filled form matches neither, so it
returns to the person - one more question, instead of a run that types over work somebody just did by
hand.

### Human acts are witnessed, because they cannot be gated

The lease governs SOFTWARE-issued actions. A person typing on a real keyboard into a real window does
not pass through `resolveAndPerform`, and nothing here can stop them. So listeners record click,
input, change, submit and navigation during HUMAN_CONTROL, re-injected after every navigation.

**Never a raw typed value.** `HumanActionEvidence` has nowhere to put one: `valueChanged: boolean` and
an optional one-way `redactedValueToken` for correlating the same value across two events.

An observation diff is kept as supplemental evidence. It records the NET result and cannot tell "the
operator typed it" from "the application autofilled it".

### How to check it

```bash
npx vitest run tests/escalation.handoff.test.ts          # no browser, ~0.1s
npx vitest run tests/escalation.console.routes.test.ts   # no browser, ~1s
npx vitest run tests/escalation.handoff.live.test.ts     # real Chromium, ~15s
```

| Claim                                                              | Test                                           |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| the intervention carries every field a person needs                | schema, and `complete` will not parse          |
| the lease moves; automation throws LEASE_VIOLATION                 | both the token AND the state refuse it         |
| same session before and after                                      | plus a NEGATIVE control where it must be false |
| all five resume cases above                                        | against recorded observations                  |
| no `/complete`, no list endpoint, cookie required                  | route-level                                    |
| the token is in no URL the page constructs                         | route-level                                    |
| **end to end**: modal -> escalate -> operator -> resume -> success | real browser, asserts `sameSession`            |

### The console is opened, not called

```bash
npx vitest run tests/escalation.console.page.live.test.ts   # real Chromium, ~1.5s
```

It drives a browser through what a person does: GET the banner URL with **no cookie** and require
HTML and 200, type the token, require the HttpOnly SameSite=Strict cookie, require the operator view
to render the reason and the step and the live masked screenshot, click Resume and require the run
to be told.

That file exists because the console shipped unopenable. The banner URL returned
`{"error":"no valid console session"}` and there was nowhere to enter a token - while the route-level
tests all passed, because every one of them asked the server a question and none of them did the
first thing a person does. See DECISIONS.md D65 and D66.

### Four defects this phase found in its own design

1. **Escalate-reconcile was written straight-line.** When a resume failed to place the run, it
   "carried on" - re-running a step from a screen the system had just said it could not place, which
   fails as a locator error. It is a loop. D63.
2. **`cede` could not be entered from `RESUME_VALIDATION`.** The second-question case threw an
   illegal-transition error. The PHASE 2 state table had anticipated it; the code had not. D63.
3. **Resuming while the blocker was still there resumed into it.** Found by pressing Resume without
   fixing anything, which is the first thing any operator will do. D62.
4. **The console could not be opened at all.** Two routes existed for one page - a PHASE 7
   placeholder and the real one - the banner pointed at the placeholder, and the page was mounted
   behind the very cookie it exists to obtain. There is now ONE `interventionPath()` shared by the
   banner and the route. D65.

---

## GATE 1 - the first real model against a live UI

Two runs against a real model. Both found something; the second passed. Every model call in
this project is made by a person, never by the build.

### Run 1 - failed, and found an addressing defect

`MAX_STEPS_EXCEEDED` after 8 model calls and 40 seconds.

**What worked, six steps deep on a real model.** The `Open` link resolved at `T5_STRUCTURAL_ROW`,
`New Sub-Account` at `T1_EXACT_ROLE_NAME`, and the unnamed combobox and deposit field at
`T3_EXTERNAL_LABEL_OR_NEARBY`. `cdp_ax` throughout, zero tier downgrades, zero locator conflicts.
The stopping condition fired correctly.

**The defect: a control that was perceived, described, resolved, and could not be addressed.**
`<p>Member Name: Avery Lin (10001)</p>` is ARIA role `paragraph`. Chrome's accessibility tree gives
that node a name; ARIA does not give `paragraph` a name from its content; so a role-plus-name
locator matched nothing while the control sat plainly on the screen. The model was told the control
was "no longer present", re-proposed the same read four times, and the run stopped.

```
getByRole('paragraph')                                     -> 1
getByRole('paragraph', { name: <the text>, exact: true })  -> 0     <- the bug
getByText(<the text>, { exact: true })                     -> 1
```

The same bug also affected `No member found for that ID.`, which is the screen the
`MEMBER_NOT_FOUND` business outcome is read from. That second instance was found by the new test,
not by another paid run. See DECISIONS.md D36.

**Two invariants came out of it, at two layers, because one of them could not have caught this.**

```bash
npx vitest run tests/agent.descriptors.invariant.test.ts   # no browser, milliseconds
npx vitest run tests/perception.addressing.live.test.ts    # real Chromium
```

| Invariant                                                         | Layer      | Would it have caught GATE 1? |
| ----------------------------------------------------------------- | ---------- | ---------------------------- |
| A synthesized descriptor resolves back to its own control         | resolver   | **No.** It did resolve.      |
| Every perceived control can be `read` through the real input path | addressing | **Yes.**                     |

The first is exhaustive over every recorded observation and every control on it, and it is enforced
inside `buildDescriptor` as a throw rather than merely observed by a test. The second needs a browser
because a Playwright locator is only real against a live page. Reverting the D36 fix makes it fail
with the exact GATE 1 message, which is how that test is known to test what it claims. D37.

**Rejections now say what to do.** `src/agent/guidance.ts` turns each failure code into a next move,
and the loop counts failures per (code, mark) so a repeat says it is a repeat. Four identical
proposals was not the model being stubborn: every rejection described the SCREEN, on a screen that
had not changed, so there was nothing to act on. The repeated-action rule was the only signal, and
it is meant to be the backstop. D38.

### Run 2 - passed, and leaked

Discovery took 8 steps and 10 model calls. Replay then ran the distilled capability on member
**10002**, whom discovery never saw, against a freshly seeded fixture with no nickname: 1.8s,
`llmCalls: 0`, correct typed outputs.

**The artifact it produced reached the store approved carrying a member id and a member's name.**

```
steps[2](step-3-open).intent
  "Click 'Open' link in the search results row for member 10001 (Avery Lin) ..."
steps[2](step-3-open).expectedEffects[1].description
  "Navigated from Member Search to Member Record screen for member 10001 (Avery Lin), ..."
```

`grep -rn "10001" artifacts/` catches it. That grep is on the GATE 1 checklist, and the artifact had
already passed distillation, validation and approval.

**The sweep did not miss a site it knew about.** It covers every place a value can be BOUND - action
values, navigate segments, row keys, expected values, locator hints, output patterns, provenance -
and the guarantee held at every one of them. The gap was conceptual: the model writes PROSE, and a
model narrates what it sees. The value was never bound anywhere. It was described.

The sweep now covers model-authored free text - `step.intent`, `step.notes`, every
`assertion.description`, `state.description` - and REFUSES rather than rewriting, because an edited
intent is a step whose recorded reasoning no longer says what the model meant. `PROMPT_VERSION` is
`v2` and tells the model that its own words are stored in a reusable capability. D39, D40.

```bash
npx vitest run tests/artifact.gate1-leak.test.ts
```

That test runs against the real GATE 1 artifact, kept verbatim at
`tests/fixtures/artifacts/gate1-leaked-prose@1.0.0.json` with its genuine provenance
(`discover-1787709809977-e0d9047b`, `claude-sonnet-5`, `promptVersion: v1`, `status: approved`).

**Two more instances of the same class, in our own files, found by the new sweep rather than by a
run**: the tracked example artifact and the embedded artifact in `docs/SCHEMA.md` both illustrated
currency comparison with the literal `"250.00"`. Both rewritten.

**One thing the leak exposed that was not about the leak.** The discovery run record was never
written to disk, so the distillation could not be re-run against a fixed distiller without paying
for another discovery. `src/cli/discover.ts` now writes `run.json`. D41.

### Where it stands

|                                        |                                                       |
| -------------------------------------- | ----------------------------------------------------- |
| Discovery against a real model         | passes: 8 steps, 10 calls                             |
| Replay of the distilled capability     | passes: 1.8s, `llmCalls: 0`, typed outputs            |
| Replay on a member discovery never saw | passes (10002)                                        |
| The contaminated artifact              | removed from the store; kept as a test fixture        |
| The prose leak                         | refused by the sweep, and the prompt was bumped to v2 |

Everything the two runs found is fixed and has a test behind it. `/artifacts` is gitignored, so the
capability in a given checkout is whatever that checkout's most recent approved discovery produced;
`examples/artifacts/` holds the tracked, reviewable example.

---

## Deliberately absent

Not oversights. Each belongs to a later phase, and building it now would be building ahead.

| Absent                                                                             | Phase |
| ---------------------------------------------------------------------------------- | ----- |
| `README.md`, `REPORT.md`, `/evidence/README.md`                                    | 10    |
| Cross-tenant support and `tenants/tenant-b.ts`; `semanticKey` is unused until then | 11    |

`capability:approve`, `discover` and `replay` are real as of PHASES 3, 4 and 5.

`npm run operator` still exits 2, and now names PHASE 12 rather than 8. The handoff shipped without
it: `npm run replay` starts the console itself when a run actually stops and prints where to go, so
a separate command would only be needed to ATTACH to a run that is already waiting - a convenience,
not part of the mechanism. A script that fails loudly beats one that is missing.

**Also disclosed - what screenshot masking does and does not claim.** Declared-sensitive regions and
the record identity ARE masked: only the masked image is written, and a `.mask.json` manifest beside
it names every region covered and every region that could not be. That is a claim about DECLARED
regions and nothing more. There is no OCR, so a sensitive value rendered somewhere nobody declared -
a summary line, a tooltip, a page title, a neighbouring row - is still in the pixels. "These declared
regions are covered" and "the screenshot is redacted" are different promises and only the first one
is made here. `docs/DATA_HANDLING.md` says the same in its LIMITS section.
