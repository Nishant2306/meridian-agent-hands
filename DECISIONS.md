# Decisions

Design decisions that a reader could reasonably have expected to go the other way. Each records
what was decided, why, and what it would cost to change.

---

## D1 - Documented domain validation is a FAILURE, not a business outcome

**Decision.** When the application rejects a form transition because the submitted data violated one
of its own documented rules - "initial deposit must be at least $25" - we classify it as
`APPLICATION_VALIDATION_REJECTED`, an **error**, not as a business outcome.

**Why this is arguable.** A caller-correctable rule looks a lot like a legitimate domain answer:
the automation worked, the app said no, the caller can fix it and retry. By that reading it belongs
with `MEMBER_NOT_FOUND`.

**Why we chose the other way.** The capability contract does not enumerate the application's
validation rules, and without that enumeration a caller **cannot distinguish** "your value was bad"
from "the application changed". Reporting both as a clean business outcome would hide genuine drift
in the target application behind a message that reads like normal operation. Classifying it as a
failure keeps drift visible; the cost is that a caller-correctable mistake shows up in the error
rate.

**What would change this.** If a future spec declares the application's validation rules as part of
the contract, then a rejection that matches a declared rule becomes a business outcome, and only
unrecognised rejections stay errors.

---

## D2 - `specHash` covers the parsed spec, not the file bytes

**Decision.** `specHash` is the SHA-256 of the **canonical serialization of the parsed, validated
`DiscoverySpec`** (sorted keys, `undefined` dropped, array order preserved) - not a hash of the YAML
file's bytes.

**Why.** Raw-byte hashing makes reindenting a file, adding a comment, or changing a line ending a
**breaking change** to every artifact built from it. That trains people to ignore hash mismatches,
which is the opposite of what a pinned hash is for. Canonicalizing means the hash tracks the
_contract_: reformatting is free, and any semantic change moves the hash.

**Cost.** The hash depends on our parser and canonicalizer. If either changes, historical hashes
stop reproducing. Canonicalization therefore lives in one file (`src/config/canonical.ts`) and is
used by every hash in the project.

---

## D3 - Pattern-typed normalization is a narrow heuristic in v1

**Decision.** For an input declared `type: string` with a `pattern`, `value_matches_param`
normalizes by stripping non-digits - but **only** when the pattern is recognised as digits-only by a
deliberately conservative test, and **only** if the stripped result still satisfies the pattern.
Everything else falls through to plain trimmed comparison.

**Why.** "Normalize per the declared pattern" in full generality means deriving the alphabet a
regex admits, which is a research project. A wrong answer silently mangles values before comparing
them, which is worse than not normalizing at all. The narrow version handles the real case - a
screen rendering `Member #10001` against a param of `10001` - and refuses to guess otherwise.

**Cost.** A non-digit identifier format (`AB-12345`) gets no normalization and may need an explicit
assertion instead.

---

## D4 - `navigate` is not model-proposable

**Decision.** `SurfaceAction` includes `navigate`, but `ProposedActionKind` does not. The model may
propose `click`, `type`, `select` and `read`; the executor navigates to the spec's declared
`entryPoint`, and thereafter the model operates the UI the way a person would.

**Why.** Every proposal addresses a **mark** from the numbered inventory of perceived controls.
`navigate` addresses a URL, which is not a perceived control - a proposal carrying a required
`markId` for a URL-addressed action is a lie in the type system. Separately, letting the model
author URLs is letting it author locators through a side door.

Parameterized `navigate` actions still exist in artifacts, because the **distiller** may produce
them from an observed path. The distiller works from what was actually traversed; the model does
not get to invent a deep link it never visited.

**Cost.** A UI whose only route to a screen is a typed URL cannot be discovered. No such screen
exists in this fixture. If one appears, the fix is a _declared_ entry point in the spec, not a model
capability.

---

## D5 - `RunResult.failed` uses `expected: string | null`, not an optional field

**Decision.** `expected` and `observed` are always present on a failure and are explicitly `null`
when there is nothing to compare (`TIMEOUT`, `SURFACE_UNAVAILABLE`).

**Why.** Optional fields let a producer omit the two most diagnostic fields on the type without
saying anything. `null` forces the producer to state "there is nothing to compare here", and makes
the difference between "we did not check" and "we checked and it was empty" visible in the data.

---

## D6 - `exactOptionalPropertyTypes` is off

**Decision.** `tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals` and `noUnusedParameters`, but
**not** `exactOptionalPropertyTypes`.

**Why.** Nearly every optional in this codebase is inferred from a zod schema, and
`exactOptionalPropertyTypes` fights zod's `.optional()` at almost every construction site. The
friction it would add is spread across the whole project; the class of bug it prevents -
distinguishing an absent property from one explicitly set to `undefined` - is already handled where
it actually matters, in `canonicalize()`, which drops `undefined` properties so both forms hash
identically.

---

## D7 - The member-search field keeps its ASP `name`, with a `q` alias

**Decision.** The fixture's search input is named `ctl00$Main$txtMemberId` (legacy-stable, as the
brief specifies), and the server additionally accepts a short `q` query parameter so the documented
deep link `/search?q=10001` still works.

**Why.** The brief pins both the ASP-style `name` example and the `/search?q=` URL. Real legacy apps
routinely accept more than one name for the same parameter. Both forms are tested.

---

## D8 - Import-boundary enforcement is a vitest scan, not workspaces

**Decision.** "Replay makes zero LLM calls, proven architecturally" will be enforced by a static
import scan in vitest (specified in PHASE 5), not by npm workspaces or eslint boundary rules.

**Why.** The scan is one readable file a reviewer verifies in ten seconds; workspaces add build
complexity to a submission that must run from a clean clone. The strongest layer is not the test
anyway - `ReplayEngine`'s constructor takes no `LlmClient`, so there is nothing to inject.

**Status.** Nothing is built for this yet. `ReplayEngine` does not exist until PHASE 5.

---

## D9 - PerceivedControl carries `containers` and `rowCellTexts`

**Decision.** The PHASE 2 brief specifies `PerceivedControl` as
`{ markId, role, name, value?, enabled, contextPath, nearbyText[], stableAttributes, box }`. Two
fields were added: `containers` (the ancestor chain, as role plus name) and `rowCellTexts` (the
text of every cell in the containing table row).

**Why.** Without them, two mandated locator tiers cannot be implemented at all:

- `T2_NORMALIZED_IN_CONTAINER` evaluates `containerHints`, which asks what a control is INSIDE of.
  Nothing else on the control answers that.
- `T5_STRUCTURAL_ROW` finds the row whose key cell matches, then the control within it. For the
  four identical "Open" links in this fixture, the key cell is the member id three cells to the
  left. `nearbyText` reaches one cell to the left and returns "Active", so it cannot do this job.

The alternative was a second lookup path inside the resolver that reaches back into the raw capture
for ancestry, which is the parallel abstraction the constitution warns about.

**Cost.** Two more fields on every perceived control, and a slightly larger saved observation.

---

## D10 - ONE ResolutionTrace, reshaped in PHASE 2

**Decision.** PHASE 1 sketched `ResolutionTrace` as
`{ observationId, markId, tiersAttempted: LocatorTier[], tierUsed, candidateCount, resolvedAt }`
before a resolver existed. PHASE 2 replaced it with what the real cascade produces:
`{ observationId, tiersAttempted: {tier, candidateCount, ms}[], tierUsed, conflicts, downgraded }`.
`markId` was dropped from it.

**Why.** Per-tier candidate counts and timings are the drift signal; a single aggregate
`candidateCount` cannot say which tier saw how many. `markId` left the trace because the trace is
produced by `resolveAndPerform`, which resolves a DESCRIPTOR, not a mark - the mark belongs to the
proposal, which already records it. Keeping both shapes would have been two trace types for one
concept.

---

## D11 - Addressing recipes are transport, and one of them uses an attribute selector

**Decision.** After resolution picks a control, the adapter points the browser at it with one of
four recipes: the `name=` attribute, role plus accessible name with a positional index, exact
visible text with a positional index, or nothing. The first is a CSS attribute selector.

**Why this is not a violation of "never CSS selectors".** The commitment is about PERCEPTION and
about what the model authors. Resolution here uses role, accessible name and nearby text and
nothing else; the model never sees a recipe; no recipe is ever written into an artifact. The
`name=` attribute is already blessed as the T4 adapter hint, and it is used here as a HANDLE rather
than as evidence. On this fixture the unnamed form controls have no accessible name at all, so
without an attribute handle they would be perceivable and unclickable.

**Safeguard.** Every recipe is revalidated against the perceived control immediately before the
action fires, including a comparison of the `name` attribute. A recipe that has drifted onto a
different element fails the action instead of acting on the wrong control.

---

## D12 - The conflict check ignores the declared role; resolution does not

**Decision.** `LOCATOR_CONFLICT` compares role-plus-name resolution against stable-attribute
resolution, and the stable-attribute side deliberately does NOT filter by the descriptor's role.
The `T4_STABLE_ATTRIBUTE` tier, which actually resolves, does filter by role.

**Why.** The two have opposite jobs. Conflict detection should be as SENSITIVE as possible, because
its output is "stop and tell someone"; if the attribute now points at a control of a different role
than the contract declares, that is precisely the disagreement worth catching, and a role filter
hides it. Resolution should be as CONSERVATIVE as possible, because its output is "act".

This was found by a test that could not fail: with the role filter on both sides, the attribute tier
returned zero candidates whenever the roles disagreed, so the conflict rule was unreachable in
exactly the case it existed for.

---

## D13 - Three CDP details that silently degrade perception

**Decision.** The extractor creates one CDP session per PAGE, primes it with
`DOM.getDocument({ pierce: true })`, and requests `Accessibility.getFullAXTree` once per frame id
from `Page.getFrameTree`.

**Why each one.** All three failed silently rather than loudly, which is why they are recorded:

- A same-process iframe has NO CDP session of its own in Chromium; asking for one throws. Only a
  cross-origin frame gets its own session, and that path is handled separately.
- Backend node ids are only populated once the document has been requested, and without `pierce`
  the ids inside iframes are missing. Every `DOM.resolveNode` inside a frame then fails and
  perception falls back to the degraded path while the accessibility tree was available all along.
- `getFullAXTree` with no argument returns the MAIN frame only. Iframe content is simply absent,
  and the result looks like a page with no controls rather than like an error.

**Consequence.** `PERCEPTION_DEBUG=1` prints the reason for any fallback. A silent fallback is a
lie by omission, and all three of these failures presented as an empty screen.

---

## D14 - Profile pins hash the file TEXT; specHash hashes the PARSED spec

**Decision.** A profile pin is `sha256` of the profile file's text with line endings normalized to
LF. `specHash` (D2) is the SHA-256 of the canonicalized PARSED spec. The two hash different things
on purpose.

**Why the difference.** A spec is EDITED; a profile is FROZEN.

Reformatting a spec must be free, or people learn to ignore hash mismatches, which is the opposite
of what a pinned hash is for. A profile is written once in PHASE 3 and never touched again, so
whitespace stability buys nothing - while covering every byte buys something real. The comments in
those profile files carry the reasoning a reviewer relies on ("why is `transfer` irreversible"), and
hashing only the parsed content would let that reasoning be rewritten without moving the pin.

**Why LF-normalized.** git checks out CRLF on Windows and LF elsewhere. A pin computed on one
platform has to verify on the other, or the integrity check degenerates into a platform check.

**Cost.** Reformatting a profile is a breaking change. That is the intended behaviour, and the
profile files carry a banner saying so.

---

## D15 - The conflict check ignores role; the resolution tier does not

Already recorded as D12 for the resolver. It recurs here in the policy layer as a general principle
worth naming: **detection should be maximally sensitive, enforcement maximally conservative.**
`policyIsWeakerThan` reports every axis on which a capability is looser than the ceiling (so a
person sees all of them at once), while `effectivePolicy` silently takes the strictest value of
every layer (so nothing runs looser than the ceiling even if approval was granted long ago).

---

## D16 - A step bound to an OPTIONAL parameter needs a replay skip rule (PHASE 5)

**The problem.** `step-6-enter-nickname` types `{"kind":"param","name":"nickname"}`, and `nickname`
is optional. Its expected effect is already guarded with `when.paramPresent`, so an invocation that
omits the nickname does not fail an assertion about it. But the STEP still has a value binding with
nothing to resolve to, and `ValueResolver` throws `MissingBindingError` rather than inventing one.

**Decision for PHASE 3.** Record it, do not build it. The two candidate designs are:

- a `when?: { paramPresent }` guard on `Step`, symmetric with the one on `Assertion`. Explicit, and
  it makes the artifact self-describing, but it is a schema change.
- a replay rule: a step whose value binding is a param that was not supplied is SKIPPED. No schema
  change, but the behaviour is implicit in the engine rather than visible in the artifact.

**Leaning.** The first. This system's whole posture is that behaviour should be visible in the
artifact rather than implicit in the engine, and a reader of the artifact should be able to see that
a step is conditional without knowing how replay works. It is deferred rather than done because
PHASE 3 must not change the schema for something PHASE 5 has not yet had to execute.

---

## D17 - The documented example is machine-checked against the real profiles

**Decision.** `docs/SCHEMA.md` ends with a COMPLETE artifact, and a test parses it, validates it
against the schema, runs the structural rules over it, and verifies its profile pins against the
real files on disk.

**Why.** Documentation that is not executed rots, and schema documentation rots fastest, because it
is exactly the kind of thing that is copied once and then edited in one place only. This makes the
doc a test fixture: if the code and the prose ever disagree, a test fails.

**The mechanic that made it possible.** Comments in that block are on their own lines, never
trailing a value, so stripping them is a line filter rather than a parser. That rule exists for a
specific reason: `entryPoint` contains `http://`, and a naive comment stripper cuts the URL in half
and then reports a confusing parse error three fields later.

**Cost.** The documented artifact is a deliberately minimal one - one state, one step, one output -
rather than the full eight-step capability, because a 700-line annotated block is not something a
reviewer understands in two minutes. The full artifact is excerpted and annotated section by section
above it, and shipped whole in `examples/artifacts/`.

---

## D18 - The detector ladder: terminal states before remediation

**Decision.** Conditions are evaluated in this order, and the order is the design:

```
1  global safety     raised by the runtime, outranks anything read off the screen
2  hard failures     terminal: the run failed
3  known outcomes    terminal: the run succeeded and the answer is negative
4  recoveries        NON-TERMINAL, and the only rung that takes an ACTION
5  needs_human       nothing above explains where we are
```

**The principle.** Terminal states are evaluated before non-terminal remediation, because **a
recovery is an ACTION and we must never act on a run that is already decided.** A screen carrying
both a dismissible maintenance notice and a genuine `MEMBER_NOT_FOUND` returns the OUTCOME.
Dismissing and retrying would spend an action, and possibly change state, on a question the
application had already answered.

**What was wrong before, and why.** The first version of `detectCondition` put recoveries ahead of
known outcomes, on the reasoning that an overlay sitting over the page is the reason the rest of it
looks wrong, so clearing it first yields a more trustworthy read.

That reasoning is real but much weaker than the rule above, and the asymmetry is what settles it:
the risk it guards against is a MISREAD, while the risk it creates is an unnecessary ACTION on a
decided run. A misread costs a wrong answer that the next observation corrects. An action cannot be
taken back. In a banking system those are not comparable costs, and the ordering should be chosen
by the worse one.

It also failed a second test: it was a deviation from a specified order that I made without
flagging it. A silent reordering of the safety ladder is exactly the kind of change that should
never pass unremarked, whatever its merits.

**Consequence.** `detectCondition` now takes a `DetectContext` carrying any system-raised condition
and whether the screen matched a known state, so all five rungs are expressible in one function
rather than split between the detector layer and its callers. Tested with a screen that matches a
recovery and a known outcome simultaneously.

---

## D19 - `read_value` binds an output; it does not become a step

**Decision.** When the model calls `read_value`, the read goes through the input path (it is an
action, and its result enters the output contract), the OutputBinding is recorded - and NO step is
emitted into the artifact.

**Why.** PHASE 3 established that an output belongs to a STATE, not to a step position, so that
extraction stays valid when a HUMAN reached the state during a handoff or a recovery made the step
sequence differ from the recorded one. Replay extracts outputs from `output.source`, so a read step
in the step list would be executed for a value the engine is going to read from the state anyway.

**Cost, stated plainly.** The distiller's read-step handling - no transition required, exempt from
the discriminating-effect rule - is therefore not exercised by the happy path. It is tested
directly in `tests/artifact.distill.test.ts` instead. The rule has to exist because `Step` admits a
`read` action and replay must handle one; it is simply not what THIS capability produces.

---

## D20 - `give_up` is `needs_human`, not a failure

**Decision.** `request_human` and `give_up` both terminate the run with `status: 'needs_human'`.
They differ only in the recorded reason.

**Why.** There is no ErrorCode that honestly describes "the model could not see a way forward". The
closest candidates all mean something else: `UNKNOWN` says we do not know what happened when we do,
and `PRECONDITION_FAILED` says something specific we did not check. Meanwhile `needs_human` is
operationally exact - the automation could not proceed and the correct next actor is a person.

**What it costs.** A model that gives up too readily shows up as intervention volume rather than as
an error rate. That is the right place for it: it is a quality problem, not an outage.

---

## D21 - `changedInventory`, the third change signal

**Decision.** A step is recorded as a no-op only when the screen identity, the target control's
value, AND the set of controls on screen are all unchanged.

**Why.** Screen identity and target value between them cannot see a SEARCH. Running a query leaves
the screen name the same and the button the same; the only thing that moves is the content that came
back. With two signals a search is classified a no-op, and since recorded no-ops are the one thing
the distiller is allowed to delete from a retained segment, the search would be deleted from the
capability - and replay would then try to open a result row on a screen that never ran the query.

Found by writing the happy-path test, not by reasoning about it.

---

## D22 - Every tool call in a model turn shares one source observation

**Decision.** All tool calls returned in a single model turn are converted against the SAME
observation: the one the model was holding when it produced them. `shown` advances for the next
turn, not mid-batch.

**Why.** A model that returns two calls in one turn formed both against one inventory. Re-reading
the current screen between them would validate the second call against a screen the model never saw,
and its mark ids would be silently reinterpreted against a different numbering.

**Consequence, and it is the desirable one.** If the first call changes the screen, the second is
correctly rejected with `STALE_OBSERVATION_CONTEXT` and fed back. That is the check doing exactly
what it exists for, in the most likely case where it matters.

---

## D23 - A descriptor is validated with its parameters BOUND

**Decision.** When descriptor synthesis tests whether a candidate resolves uniquely, it binds the
invocation's values first.

**Why.** A parameterized row key is `{ kind: 'param' }`, and the resolver refuses to resolve one
rather than guessing. Without binding, EVERY row-keyed candidate fails validation and is silently
discarded in favour of a weaker descriptor that happens to work on this one screen - so the search
result link would have been recorded as "the link named Open", which is unambiguous for a search
returning one row and wrong for the next invocation that returns four.

The failure mode was silent: the artifact still distilled, still validated, and was still wrong.

---

## D24 - `test:fast` splits by naming convention, not by tag

**Decision.** Browser-driven test files are named `*.live.test.ts`. `npm run test:fast` excludes
that glob; `npm test` runs everything.

**Why a file naming convention** rather than per-test tags or a vitest workspace: the split is
visible in `ls`. A reviewer can see which three files need a browser without reading a config, and
a new browser-driven test is opted in by its filename rather than by remembering to tag it. The
cost is that a file is all-or-nothing, which is the right granularity here - a file that boots a
browser pays that cost once for every test in it anyway.

**What it must never become.** `test:fast` excludes FILES. It does not skip, weaken or shorten a
single assertion, and the browser-driven files are where perception, the input path and the
discovery loop are actually proven. A gate requires `npm test`.

---

## D25 - Three defects found by looking at real distiller output

`npm run distill:demo` exists so the distiller can be read while it is the only variable. It earned
that on its first run, and all three of these would have been much harder to see at GATE 1 with a
real model also in play.

**1. Risk was decided by whether a field happened to have a name.** `stepRisk` asked the safety
profile first for any NAMED control. Typing into the search box - which has a real `<label for>`,
so it is named "Member ID", which matches no risk phrase - fell through to `defaultRisk` and came
out RISKY_REVERSIBLE, while typing into the unnamed nickname box beside it came out
SAFE_REVERSIBLE. Same kind of action, opposite classification, decided by an accident of markup.

Now the ACTION decides first: filling a field on an unsubmitted form is SAFE_REVERSIBLE whatever
the field is called, and a CLICK is where the profile's opinion of the control name governs,
because a click is the action that can do anything.

**2. Three consecutive steps called `step-5-type`, `step-6-type`, `step-7-type`.** The step id fell
back to the action type whenever the control had no accessible name - which on this application is
every form field. Now it falls back to the nearby LABEL first, giving `step-6-nickname-optional`.
Cosmetic, and it is the difference between an artifact a reviewer can skim and one they have to
decode.

**3. An expected effect that was FALSE after the action.** The click that opens a member record
navigates away from the results row, so the "Open" link is gone afterwards - and the distiller was
deriving `control_visible` on it, asserting the opposite of what had been observed. It distilled
cleanly because the discriminating-effect rule only requires that ONE effect flips false-to-true,
and the screen-identity effect did.

Two fixes, because the second one is the general case:

- the bogus derivation is gone
- `checkStepDiscrimination` now requires that EVERY expected effect HOLDS after the action

The general rule matters more than the specific bug. Requiring one discriminating effect says the
action did something; requiring all of them to hold says nothing we recorded about it is false.
Without the second, a step can carry an assertion that was never true, distil cleanly, and fail on
the first replay - where it reads as drift in the application rather than a defect in the recording.

---

## D26 - `recordedTier` describes the DESCRIPTOR, not the screen it was recorded on

**Decision.** A descriptor carrying a `rowKey` records `T5_STRUCTURAL_ROW`, whatever tier the
cascade happened to fire on when it was built.

**Why.** A search for one member returns one row. Role-plus-name resolves the "Open" link uniquely
on that screen, so the cascade reports `T1_EXACT_ROLE_NAME` - while the row key, which is the only
thing separating those links when four come back, did no work at all.

Recording T1 there is wrong **in the direction that looks fine.** `recordedTier` is what replay
compares its own tier against to raise a drift signal, so claiming the strongest tier when a weaker
one is what the descriptor actually relies on means a genuine downgrade later reads as normal
operation. Drift detection that fails silently is worse than none, because it is trusted.

**The general form of the rule:** the recorded tier is a statement about which EVIDENCE the
descriptor depends on. It is not a measurement of how many rows a particular screen happened to
have on the day it was recorded.

**Noted while fixing it, not changed.** The resolver still tries T1 before T5, so on a single-row
results screen a row-keyed descriptor resolves by name without the row key being checked. If the
application ever returned a different single member than the one requested, that resolution would
succeed on the wrong row - and be caught one step later by the record-identity invariant on the
member-details state. Making `rowKey` a constraint on every tier rather than a tier of its own is
the cleaner fix, and it changes resolver semantics that PHASE 2 tests pin, so it is not something
to do in passing.

---

## D27 - `intent` is the model's account; `notes` is the system's

**Decision.** `intent` carries the MODEL's reason for choosing a control. `notes` carries the
RESOLVER's account of how the control was identified and which tier recorded it, and is OMITTED
when it would only restate the intent.

**Why.** They were the same string on all eight steps, which made `notes` pure noise in the first
document a reviewer reads. But the fix is not simply to delete the field: there genuinely are two
different things to say, from two different actors, and a reviewer needs both.

```
intent: "Open the member record from the results row for the member we were asked about."
notes:  "Identified by accessible name \"Open\" within the row identified by {{memberId}},
         recorded at T5_STRUCTURAL_ROW."
```

The first says what the step is FOR. The second says whether it will still find the right control
next week. Reviewing a capability needs both questions answered, and neither answers the other.

---

## D28 - `Step.when` is a schema bump, not a quietly additive field

**Decision.** The step-level guard for an optional parameter (D16) landed as `schemaVersion: 2`.

**Why bump.** `z.object` strips unknown keys. A reader built for version 1 encountering a version 2
artifact would silently DISCARD the guard and execute a step that was supposed to be skipped -
typing an empty nickname, or failing to resolve a binding. Refusing to load a file it does not
fully understand is the correct behaviour for a reader when the field it is missing carries
execution semantics.

**Why now.** Nothing was pinned to a version 1 artifact: the example is regenerated and no real
capability exists yet. The same change after GATE 1 would have invalidated a real recording.

**Why on the step rather than inside the engine.** A reader of the capability can see that the step
is conditional without knowing how replay works. That is this system's posture everywhere:
behaviour is visible in the artifact, not implicit in the engine.

---

## D29 - A row key constrains EVERY tier (supersedes the open note in D26)

**Decision.** `rowKey` is a constraint applied to every tier's candidates, not a tier of its own.
A descriptor saying "the Open link in the row keyed by memberId" can never resolve to an Open link
in another row, whichever predicate located the candidate. When a row key is in play the resolution
is reported as `T5_STRUCTURAL_ROW`, because the row key is part of what identified the control.

**Why the earlier design was wrong.** With the cascade trying T1 first, a search returning ONE row
resolves the link by name alone - and if the application returned a different member than the one
requested, the click lands on the wrong record with the row key never consulted.

**Why the old mitigation was not enough.** D26 noted that the record-identity invariant on the
member-details state would catch it one step later. That is contingent on the shape of the next
step and on execution order, and `step-3-open` carries `invariants: []`. Correctness must not
depend on what happens to come after.

**What changed in the PHASE 2 tests.** Nothing broke. The existing T5 test still passes because the
four-row capture always needed the row key. Three tests were ADDED: the keyed row is chosen out of
four; a single-row screen whose only row is NOT the keyed one FAILS rather than resolving; and the
structural tier is reported even where role-plus-name alone would have been unique.

---

## D30 - An invariant must hold on BOTH SIDES of a transition

**Decision.** The distiller chooses a step's identity invariant so that it holds on the FROM screen
AND, for a step that changes screen, the TO screen. `checkStepDiscrimination` now also rejects an
invariant that is false before the action or false after it.

**How it was found.** The first replay of a freshly distilled artifact failed:

```
INVARIANT_VIOLATED at step-4-new-sub-account:
  step-4-new-sub-account.identity (CONTROL_NOT_FOUND: no cell matched on screen "New Sub-Account")
```

The distiller had taken the strong identity check from the FROM screen - the cell beside the
"Member ID" label on the member record - and that cell does not exist on the sub-account form. The
artifact distilled cleanly, validated cleanly, and failed on its first execution.

**Why the general rule matters more than the fix.** The specific bug is one line of screen
selection. The rule - an invariant is checked before AND after, so it must be TRUE before and after

- is what stops the next one. Note also where the failure surfaced: on the step that CARRIED the
  invariant, one step after the transition that made it wrong. A rule that fails at distillation
  points at the right place; a rule that fails at replay points one step late.

---

## D31 - `--json` has exactly one writer, and a business outcome exits 10

**Decision.** With `--json`, `src/cli/replay.ts` writes ONE JSON object to stdout at the very end
and every other line goes to stderr. Exit codes: 0 success, 10 business_outcome, 20 needs_human,
25 cancelled, 30 failed.

**Why.** The caller is an AI agent parsing stdout. One stray progress line turns a machine-readable
result into a parse error in production, on the run that mattered. The file has a single
`process.stdout.write`, and the human-readable logger is a function that no-ops under `--json`.

**Why 10 is not 30.** "There is no such member" is a legitimate answer from a run in which
everything worked. Collapsing it into the failure code is how a correct negative answer ends up
paging somebody at 03:00. The exit code is where a calling system sees the distinction, so the
distinction has to reach it.

Verified end to end: `--params '{"memberId":"99999",...}'` returns
`{"status":"business_outcome","outcome":"MEMBER_NOT_FOUND",...}` and exits 10 - in 586ms, not after
a ten-second timeout. That is the integrated observation loop earning its place.

---

## D32 - The no-LLM proof is a counter, never a mode flag

**Decision.** Three layers: the shape of `ReplayDeps` (no client field), an import-boundary test
that walks the module graph from `src/replay/index.ts`, and a runtime provider-call counter
snapshotted around every replay.

**Why a counter and not a flag.** A module-global "we are replaying now" switch describes the
PROCESS, and it breaks the moment discovery and replay share one - which they will, in any service
offering both. A counter is a fact about what happened, and it stays true regardless of who else is
running alongside.

**The test has a negative control.** It also walks `src/agent/index.ts` and asserts the walker DOES
find the agent package and the provider SDK there. Without that, a broken walker returning nothing
would look exactly like a clean boundary - the one way this test could lie.

---

## D33 - .env is loaded at the entry points with `process.loadEnvFile`, not by an npm-script flag

**The bug.** GATE 1 was blocked by `npm run discover` reporting "ANTHROPIC_API_KEY and LLM_MODEL
must be set" with a correctly filled `.env` sitting in the repository root. Node does not read
`.env` on its own, and nothing in this project did either.

**Decision.** `src/config/env.ts` calls `process.loadEnvFile` (Node 20.12+) from each entry point
that reads the environment: `src/cli/discover.ts`, `src/cli/replay.ts`, and
`fixtures/legacy-app/main.ts`.

**Why not `--env-file=.env` on the npm script**, which was the first thing to reach for. It throws
ENOENT when the file is absent, so `npm run replay` - which needs no key at all - would stop working
on a clean checkout. `--env-file-if-exists` fixes that and is Node 22.9+, above the `engines.node`
floor of 20 that this project claims to support. Both only cover invocations that go through npm,
and neither can be reached from a test. `process.loadEnvFile` is the same parser behind the flag,
so quoting and comments behave identically, and it is an ordinary function call.

**The root is found by walking up from `import.meta.url`, not from `process.cwd()`.** npm sets the
working directory to the package root, so a cwd-based loader is correct under `npm run ...` and
wrong the moment anyone runs `tsx src/cli/discover.ts` from elsewhere. Verified from PowerShell and
Git Bash, at the repository root and from `C:\`.

**Precedence is Node's: the real environment wins over the file.** That is the right way round.
`LLM_MODEL=x npm run discover` overrides for one run without editing anything.

**The message names each variable separately, and says whether a file was read.** The old sentence
could not distinguish four different problems: neither variable set, one of two set, one present but
empty, and the file never read at all. It was the last of those, and the message sent the reader to
look at the first. Each variable now reports its own state, and the footer says either
`Read .env from: <path>` or `No .env file was read. Looked for: <path>`. Pinned by
`tests/config.env.test.ts`.

---

## D34 - Discovery validates caller arguments before the surface or the model is touched

**Decision.** `runDiscovery` calls the same `validateInvocationParams` as replay, as its first
statement, and returns `INPUT_VALIDATION_FAILED` without observing anything or calling the provider.
`src/cli/discover.ts` calls it again before it constructs the client or launches Chromium.

**Why it was missing and what that cost.** Replay has had this ordering since PHASE 5, proven with a
surface that throws if touched. Discovery had no argument check at all. A run invoked with
`--inputs '{}'` opened a browser, signed on, and spent three model calls before the missing
parameter surfaced as `EFFECT_NOT_OBSERVED` - a code that is literally true and describes the
symptom three actions downstream of the cause. The asymmetry was not a style problem; it was billed.

**ONE validator, not two.** `validateInvocationParams` now takes `readonly InputDefinition[]`
instead of a `CapabilityArtifact`, because `DiscoverySpec.inputs` and `CapabilityArtifact.inputs`
are the same `InputDefinitionSchema`. A discovery-side copy that agreed with the replay-side one
today would drift, and it would drift in the worst available direction: the recording accepting
argument lists that the replay of that same recording rejects.

**It moved from `/replay` to `/artifact`.** Once it took declared inputs it had nothing
replay-specific left in it, and leaving it in `/replay` would have meant `/agent` importing from
`/replay` - an edge that inverts how the packages are meant to read. `/artifact` is the contract
vocabulary both already depend on. The replay import boundary is unaffected: the file imports only
from `src/types/`, and `src/replay/index.ts` still re-exports it.

**Tested with both stubs hostile.** `tests/agent.loop.inputs.test.ts` passes a surface and a client
whose every method throws, and asserts neither is reached. It carries a negative control: a fully
valid invocation must get PAST the gate and reach the surface, which the untouchable stub then
proves by throwing. Without that, a gate that rejected everything would pass every other assertion
in the file.

---

## D35 - There is exactly one sign-on definition, and it is checked by reading the source

**Decision.** `src/cli/discover.ts` uses `MERIDIAN_SIGN_ON` from `src/config/sign-on.ts`, the same
definition `SessionBroker` uses, reaching the credential refs and the authenticated-screen text
through its fields rather than re-typing them. `fixtureCredentials()` replaces discover's own copy
of the `OPERATOR_ID` / `OPERATOR_PASSCODE` fallbacks.

**What was wrong.** Discovery carried its own copy of the descriptors. The copies agreed, and the
doc comment in `src/config/sign-on.ts` already claimed they were shared, as did `docs/STATUS.md`.
Duplication that currently agrees is the dangerous kind: nothing fails, so nothing draws attention
to it until the copies differ.

**Why this duplicate specifically.** Discovery RECORDS a capability from the screen state it
reaches; replay RE-EXECUTES it from the screen state it reaches. Two authentication paths can
arrive in two different states, and the artifact is then a recording of a place its own replay never
visits. The failure appears as a locator error deep inside a replay - about the least informative
place for a configuration mismatch to show up.

**The test reads the source; it does not run discovery.** Running it needs a browser, a model and
money, and would prove less: a green end-to-end run says the copies agree TODAY, which is exactly
what the duplicated version also said. So the test asserts that a `SIGN_ON`-shaped declaration
exists in one file only, that both entry points import it, and that the descriptor literals
(`Operator ID`, `Passcode`, `name: 'Log In'`, `Member Search`) appear nowhere else. It carries a
negative control confirming the pattern can actually see the one real definition.

---

## D36 - A name only enters a role recipe if `getByRole` will compute the same name

**The GATE 1 defect.** The model tried to read `<p>Member Name: Avery Lin (10001)</p>` to bind the
record identity. Perception saw it, synthesis described it, the resolver resolved it, and the
transport could not point at it. The run was told `CONTROL_NOT_FOUND` - "the control is no longer
present on the screen" - four times, against a screen with 22 controls before and 22 after, and
then stopped on the repeated-action rule.

**Cause, one layer below where it looked.** A `<p>` maps to the ARIA role `paragraph`, which IS
addressable by `getByRole`. Chrome's full accessibility tree reports a NAME for that node, its own
text, so `recipeFor` built a role-plus-name recipe. But ARIA does not give `paragraph` a name from
its content, so Playwright computes its accessible name as empty:

```
getByRole('paragraph')                                    -> 1
getByRole('paragraph', { name: <the text>, exact: true })  -> 0
getByText(<the text>, { exact: true })                     -> 1
```

Two layers each behaving correctly by their own rules, disagreeing about what a "name" is.

**Decision.** `ROLES_NAMED_FROM_CONTENT` in `src/perception/roles.ts`. A name goes into a role
recipe only when the role takes its name from content, or when the name is demonstrably NOT the
node's own text - which is what a name from a label or `aria-label` looks like, and which
`getByRole` computes the same way we do. Otherwise the node's own text addresses it.

**Why not simply drop `paragraph` from the addressable set.** Because the node is genuinely
addressable, and it is the node that carries the record identity on that screen. Removing it would
have traded a loud failure for a silent absence.

**A second instance, found by the new test, not by a run.** `No member found for that ID.` on the
no-results screen is the same `paragraph` case - and that screen is where the `MEMBER_NOT_FOUND`
business outcome comes from. It would have failed the same way.

---

## D37 - Two invariants, at two layers, because one of them could not have caught this

**The synthesis invariant** (`src/agent/descriptors.ts`): a descriptor synthesized from a perceived
control must resolve back to that control, in the observation it was built from. Violating it
throws `DescriptorSynthesisError` naming the control AND the descriptor, rather than travelling
onward as `CONTROL_NOT_FOUND` - which is a claim about the screen, and sends the reader (and the
model) to look for a problem that is not there. `tests/agent.descriptors.invariant.test.ts` checks
it for every control of every recorded observation, with no browser.

**It would not have caught the GATE 1 defect, and saying so is the point.** The paragraph descriptor
resolved back to its own control perfectly. The break was in ADDRESSING, and a Playwright locator is
only real against a live page.

**So the addressing invariant is separate** (`tests/perception.addressing.live.test.ts`): every
perceived control on every screen is `read` through the REAL input path - resolve, address,
revalidate. `read` is the only action that can touch everything without changing anything. Reverting
the D36 fix makes this test fail with the exact GATE 1 message, which is how we know it tests what
it claims to.

**Two things this test found about itself.** Written first with plain strings for `pathSegments`
(they are `TextMatcher`s), it navigated nowhere and every case passed against whatever screen
happened to be loaded - so it now asserts the screen it reached. And the review screen 303s back to
the form unless a draft exists, so screens are reached by operating the app rather than by deep
link.

**One legitimate refusal is asserted rather than excluded**: the bootstrap safety minimum blocks
even a READ of `Submit Request`, and the test requires that block to happen on the review screen.

---

## D38 - A rejection tells the model what to do, and a repeat says that it is one

**The failure.** Four identical proposals is not the model being stubborn. Every rejection said only
that the control was not present, on a screen that had not changed, so there was nothing to act on
and re-proposing was reasonable. The repeated-action rule then stopped the run - correctly, and as
the ONLY signal, which is not what a backstop is for.

**Decision.** `src/agent/guidance.ts` maps each failure code to a next MOVE, and the loop counts
failures per (code, mark). The first message says what happened and what to try; a repeat says
plainly that it has now failed the same way N times and will keep failing.

**Each code gets different advice, and a test asserts they are all different.** If two codes
produced the same advice, one of them is not carrying its weight - which is the same rule the error
taxonomy is already built on.

**`POLICY_BLOCKED` deliberately does not say "try again".** A guardrail is not a transient failure,
and inviting a retry against one is how a model spends a run discovering that no means no.

---

## D39 - The parameterization sweep covers model-authored PROSE, and refuses rather than rewrites

**The GATE 1 leak.** The run passed, and the artifact it produced reached the store approved
carrying:

```
steps[2](step-3-open).intent
  "Click 'Open' link in the search results row for member 10001 (Avery Lin) to open the member
   record."
steps[2](step-3-open).expectedEffects[1].description
  "Navigated from Member Search to Member Record screen for member 10001 (Avery Lin), ..."
```

A runtime member id and a member's name, inside a content-hashed, reusable capability.

**The sweep did not miss a site it knew about.** It covered every place a value can be BOUND -
action values, navigate segments, row keys, expected values, locator hints, output patterns,
provenance - and the guarantee held at all of them. The gap was conceptual: the model writes PROSE,
and a model narrates what it sees. The value was never bound anywhere. It was described.

**Decision.** Class (e), model-authored prose: `step.intent`, `step.notes`, every
`assertion.description` (expected effects, invariants, state screen assertions, qualifiers, state
invariants, precondition checks) and `state.description`. Same classification, same fail-closed
behaviour.

**REFUSAL, never a scrub.** A rewritten `intent` is a step whose recorded reasoning no longer says
what the model meant, which destroys the only thing `intent` is for: a reviewer checking the stated
reason against the action. A scrubbed artifact would also be MORE dangerous than a rejected one,
because it would look reviewed.

**Substring, and deliberately blunt.** Prose embeds values mid-sentence, so this matches on
containment, and it will occasionally refuse over a coincidence. That direction is correct: a false
refusal costs a re-run, a false pass ships a person's name inside a reusable tool.

**The contract-constant exemption still applies, per matched value.** "of type Savings" contains a
runtime value that is also a declared enum member. Refusing that would refuse every correct
artifact this system can produce.

**Enumerated sites, not a blanket walk over every string.** A walk would also sweep the capability
name and description, the input and output descriptions and the condition labels - all authored by
a human in the DiscoverySpec and reviewed before a run happens. Reporting a spec author's own
wording back as a leak is how a guardrail gets switched off.

**It immediately found two more instances in our own files**: the tracked example artifact and the
embedded artifact in `docs/SCHEMA.md` both illustrated currency comparison with the literal
`"250.00"`. Both rewritten to state the rule without the value. The narrative paragraph in
`SCHEMA.md` that explains typed comparison keeps its example, because documentation ABOUT the
system is not artifact content.

---

## D40 - promptVersion v2: the model is told its own words are stored

**Decision.** `PROMPT_VERSION` is `v2`. The prompt now has a section titled "WRITE FOR THE NEXT
INVOCATION, NOT THIS ONE", with worked contrasts:

```
Write:  "click Open in the row identified by memberId"
Not:    "click Open in the row for member 10001 (Avery Lin)"
```

It says explicitly that the rule covers values the model READ off the screen as well as values it
was given, and that the system refuses the whole capability rather than editing the text.

**Why the sweep alone is not enough.** The sweep is the guarantee; the prompt is what stops a run
being wasted discovering it. v1 never told the model its prose was stored, so narrating the screen
was the reasonable thing to do.

**The bump is not cosmetic.** `promptVersion` is in provenance and therefore in the artifact content
hash, so an artifact built under v1 is distinguishable from one built under v2 permanently. That is
what makes "which artifacts were produced before the rule existed" an answerable question.

---

## D41 - The discovery run record is persisted, because the first thing we wanted was to re-distill

**Decision.** `src/cli/discover.ts` writes the full `DiscoveryRunRecord` to `run.json` in the run
directory.

**Why.** Evidence answered "what happened". Nothing answered "what would this same run produce
now". After GATE 1 the obvious next move was to re-run the distiller over the same recorded run to
prove the fix, and it was impossible: only result, metrics and encountered conditions were written.
The regression test therefore asserts against the distiller's OUTPUT, which is weaker than
re-driving its input, and from the next run onward it will not have to be.

**Disclosure.** The record contains observations, so it contains screen text, which can contain PII.
It is written under `/runs`, which is gitignored, alongside screenshots that already have that
property. PHASE 7 pseudonymizes persisted evidence and this file is in that scope.

---

## D42 - Fault injection is keyed by session, and the seeded members carry their own

**Decision.** `POST /__test__/faults` stores flags against the `MERIDIAN_SESSIONID` cookie, or an
`X-Fault-Session` header for a caller that has not signed on yet. There is no server-wide switch.

**Why the header exists at all.** `expireSession` has to be armable BEFORE the session it affects is
used. Without the header that fault cannot be tested, and the temptation would be a global flag.

**Why not a global flag, concretely.** The suite runs vitest files in parallel against one fixture
module. A global flag lets the file testing SESSION_EXPIRED break the file testing a slow load,
intermittently, and the failure moves when tests are reordered - so it reads as flaky
infrastructure rather than a design mistake. `tests/fixture.faults.test.ts` pins the isolation with
two sessions against one app instance.

**Seeded members are the more honest subject.** 10003 (`restricted`) returns PERMISSION_DENIED and
10004 (`knownNotice`) shows the maintenance notice with NOTHING armed, which is how the real system
would behave: the caller asks about a member and the application answers. The flags exist for the
conditions that are not a property of one record.

**The fault screens answer HTTP 200 wherever the application would.** A 403 would let a
transport-level check stand in for reading the screen, and reading the screen is the whole thesis.
`http500OnRoute` is the exception, and it still renders a readable page, because that is what these
applications actually do.

---

## D43 - The fixture was changed to match the profile, twice, and the profile was not touched

**The rule from PHASE 3, applied.** Every detector phrase is rendered by the fixture verbatim, and
`tests/fixture.faults.test.ts` reads the REAL profile and checks its detectors against the REAL
HTML. It never hard-codes a phrase: a test comparing two copies of a string would pass while the
page said something else.

**Two fixture changes were needed, and both were perception problems rather than wording problems.**

1. **Detector text in a bare `<div>` is invisible.** The inventory drops StaticText deliberately -
   it would triple the size of a legacy screen and add nothing actionable - so the maintenance
   notice and the session-expired panel rendered their phrases into a node the detectors could
   never see. The text now sits in a `<p>`, which is a `paragraph` and reaches both. Found by
   observing the screen, not by reading the markup.

2. **A `<div role="dialog">` is not a dialog.** Chrome's accessibility tree does not expose it as
   one. The fixture renders a real `<dialog open>`, which it does.

**Neither was fixed by editing the profile**, which would have invalidated every pinned hash.

---

## D44 - A container whose PRESENCE is the signal is never dropped as noise

**The bug, found by PHASE 6.** `isNoiseStructure` drops any non-interactive node that CONTAINS an
interactive one, on the sound reasoning that a wrapper around a button adds a line and no
information. The unrecognised-modal fixture rendered a real `<dialog open>`, Chrome reported it as
`dialog`, and the inventory dropped it - because it contained a button. The needs_human rung
depends on seeing a blocking dialog, so it could never have fired.

**`alert` was the same latent bug, and worse.** `APPLICATION_VALIDATION_REJECTED` is detected
STRUCTURALLY by the alert region. Today's validation banner is text-only so it survives; an alert
carrying a "Retry" link would have vanished, and the detector would have silently stopped working
on exactly the screens where it mattered.

**Decision.** `PRESENCE_IS_SIGNAL_AX_ROLES` = dialog, alertdialog, alert. A dialog is not a wrapper
around its OK button; it is the fact that the screen is blocked. That is something no child of it
can say.

---

## D45 - Recovery continuation: recheck regardless of the retry budget, detectors before the recheck

**Decision.** `#recover` applies the remediation, RE-OBSERVES, runs the TERMINAL detectors on what
is now visible, and only then rechecks the interrupted step's expected effect. If it holds, the
step is complete and the action is NOT repeated.

**Rung 3 is the one that would have been left out.** Clearing an overlay is exactly how a permission
denial or a business outcome underneath it becomes readable. Without the detector pass, dismissing a
maintenance notice sitting on top of "You do not have permission" would recheck the effect, fail,
and report EFFECT_NOT_OBSERVED - a diagnosis of the automation for what is an entitlement problem.

**It runs regardless of the retry budget.** The old code reached the recheck only by continuing into
the next retry iteration, so a step with `retries.max: 0` would have applied the remediation and
then fallen straight through to failure without ever looking. `retries.max: 0` means "do not perform
this action twice"; it must not also mean "do not look at whether the recovery worked".

**Only `retry_action` repeats the action.** The maintenance notice appears AFTER the "New
Sub-Account" click, on the screen that click navigated TO - the click worked. "The overlay swallowed
my click" and "the overlay appeared because my click worked" look identical from the screen, and
only one of them is safe to retry. `tests/replay.outcomes.live.test.ts` asserts `attempts === 1`.

**The continuation type was widened; the profile file was not touched.** Adding `retry_action`,
`continue_next_step` and `{ gotoStep }` to the zod union leaves the YAML bytes unchanged, so every
pinned hash still verifies. A profile that USED a new continuation would be a new version file.

---

## D46 - A dead browser is a result, not an exception

**Decision.** `ReplayEngine.run` catches surface death and returns `SURFACE_UNAVAILABLE`. Nothing
mapped it before: a dead Chromium threw a raw Playwright error out of `run()`, so the one failure
mode that is not the application's fault was the only one a caller could not handle uniformly.

**Anything not recognisable as surface death is RETHROWN.** A blanket catch would turn every genuine
defect in the engine into a tidy "the browser died", which is the kind of helpful error handling
that costs a day. The match is a small explicit list of the phrases Playwright uses.

**The test kills a real browser.** `killBrowserAfterMs` closes an actual Chromium mid-run rather
than stubbing a throw, so the engine sees what it would see in production.

**Amended after PHASE 6, by running the suite on a loaded machine.** The first version of the phrase
list covered the page-level messages only. Under file parallelism the browser died a few
milliseconds earlier - inside `newCDPSession` rather than inside a page operation - and Playwright
said `Protocol error (Target.attachToTarget): No target with given id found`, which matched nothing
and was rethrown. The CDP-level phrases are now in the list. This is not an exotic case: a browser
that dies during OBSERVATION dies inside CDP, which is where this system spends most of its time.

---

## D47 - The tier-downgrade claim now has a test behind it, with a negative control

**The gap, flagged after PHASE 5 and closed here.** Detection worked at the resolver and one PHASE 2
test pinned it. Above that line nothing was asserted: the engine carried `downgraded`, the evidence
logger wrote it, the loop counted `locatorTierDowngrades`, and no test drove a real replay against a
drifted screen to see whether any of it arrived. PHASE 10 quotes that number.

**The drift is realistic.** `relabelContinueButton` rewords the button and leaves its legacy-stable
`name=` attribute alone, because the server's form handling depends on that attribute. The recorded
descriptor resolves at `T4_STABLE_ATTRIBUTE` instead of `T1_EXACT_ROLE_NAME` - one tier weaker, the
run still succeeds, and the drift is recorded. That is the moment worth noticing, well before it
breaks outright.

**Determinism across fresh boots is a DIFFERENT claim** and always was: it shows the tier does not
move when the page is unchanged. It says nothing about whether a move is caught when it happens.

**The negative control.** An unchanged screen must report `locatorTierDowngrades: 0` and no
downgraded step. Without it, an implementation that marked every step downgraded would pass
everything else in the file.

---

## D48 - The failure report is a checklist, not a dump

**Decision.** `formatResultForHuman` renders capability id AND version, the step id AND its recorded
intent, expected beside observed, tiers attempted with any downgrade marked, recoveries attempted,
whether the session is still alive, and the evidence path.

**The test of the function is whether a person who did not watch the run can decide what to do next
without opening the artifact, the evidence bundle, or the code.** Each field earns its place against
that: an id without a version is not actionable when two versions are deployed; a step id without
its intent sends the reader to the artifact; and one half of a disagreement is not a diagnosis,
which is why a hard failure now carries `expected` as well as `observed` - it carried `null` before.

**Session liveness decides the next move.** A failure on a dead session means sign on again; on a
live one it means go and look at the screen we left behind. A successful run gets the short form,
because nobody needs a diagnosis of something that worked.

---

## D49 - The bootstrap minimum stays, and a test proves it rather than a comment

**Decision.** The PHASE 2 minimum runs FIRST at both enforcement points and the configurable engine
runs SECOND. Neither is removed. `tests/policy.engine.test.ts` asserts both independently: an
off-origin navigate and every action type on "Submit Request" are refused by the minimum AND by the
engine.

**Why not just delete it once the engine works.** The minimum is what actually stood between a real
model and the "Submit Request" button across both GATE 1 runs. Replacing a control that has been
load-bearing in production with an untested one, in the same commit, on the strength of "the new
one does the same thing", is how guardrails quietly stop working. Two independent refusals means a
mistake in one is not a hole.

**The engine can only tighten.** The minimum returns on refusal before the engine is consulted, so
nothing the engine ALLOWS can re-open something the minimum refused. That is asserted too: the
`/subaccount/submit` route passes the minimum, which knows nothing about routes, and is refused by
the engine.

---

## D50 - `--origin` is deployment configuration, not a policy bypass

**The problem.** `allowlist.yaml` names concrete origins, and a deployment's real origin is
whatever it is - a fixture on an ephemeral port in a test, a different host in staging. A run whose
origin is not in the file cannot sign on.

**Decision.** `PolicyEngine` takes an optional `runOrigin`, and the CLIs pass the origin the run was
configured with. The permitted set is the allowlist file plus that one origin.

**Why this is not a hole.** The bootstrap minimum pins the ENTIRE run to a single origin and refuses
everything else before the engine is consulted at all. `runOrigin` can therefore only ever agree
with a decision the minimum has already made; it cannot widen a run to a second origin, because the
minimum only knows about one. The browser-level backstop is armed from the same set.

---

## D51 - The input-path lint test is itself the deliverable

**Decision.** `tests/policy.input-path.lint.test.ts` walks `src`, `tests`, `scripts` and `fixtures`
and fails if `page.click`, `page.fill`, `page.goto`, `page.type` or their relatives appear outside
`src/surface/playwright-web/`.

**Why mechanically rather than by review.** One `page.click` somewhere else bypasses the lease, the
bootstrap minimum, the policy engine, the single resolver and the revalidation step. In a diff it
looks like a shortcut in a test helper. Nothing else in the suite fails.

**It found one immediately.** `scripts/inventory.ts` called `page.goto` directly. A dev script is
exactly where this happens, because it does not feel like automation. It now goes through the input
path like everything else.

**It carries two negative controls**: the walker must find files, and the matcher must find the
forbidden calls where they ARE allowed. Without the second, a typo in the pattern list would make
every assertion pass while checking nothing.

---

## D52 - Three data mechanisms, kept apart on purpose

**(1) Persistence is pseudonymized.** One seam - `redactForPersistence` - which every event passes
through, plus the transcript and the human CLI output.

**(2) Artifacts are SCANNED and REJECTED, never rewritten.** Rewriting corrupts input examples,
typed literals, descriptors, expected values and URL templates, and it hides the fact that the
distiller has a bug. A scrubbed artifact also LOOKS reviewed, which is what makes it dangerous.

**(3) Caller results are not redacted at all.** The brief requires replay to RETURN what it read. An
agent that asked for the review status and got `[reviewStatus:subject-01]` has been given nothing.
`replay --json` writes real typed outputs to stdout; stderr and `/runs` are pseudonymized.
`tests/replay.cli.live.test.ts` asserts both halves in one test, because either alone would let the
other regress.

**[MUST] The pseudonym map is per-run and random.** A truncated hash of a five-digit member id is
enumerable in under a second - 100,000 candidates. A short digest of a low-entropy value is not
pseudonymization, it is an index into the plaintext, and it looks careful, which makes it worse than
doing nothing. `PSEUDONYM_SECRET` switches to HMAC-SHA-256 at 8 bytes minimum, refused below that,
and the trade is stated rather than sold: stable labels across runs, correlation for anyone holding
the secret.

**Luhn before card detection.** Without it, every account number and reference of the right length
is replaced, the logs become unreadable, and the next person turns redaction off.

---

## D53 - There is no --approve-irreversible flag, and this is the shape one would need

**Decision.** IRREVERSIBLE is blocked outright in discovery and replay. No flag, no environment
variable, no artifact field. `effectiveRisk` is the MAXIMUM of the artifact-declared risk and the
risk derived from the control that actually resolved, so an artifact claiming "Submit Request" is
`SAFE_REVERSIBLE` is not believed - otherwise editing one field of a JSON file would be enough.

**Why a run-wide boolean is the wrong shape.** It binds approval to NOTHING: not one action, not one
control, not one screen state, not one time window. Somebody approves "this run may submit", and
what they have actually authorised is every irreversible control the run happens to encounter,
including ones nobody was looking at when they approved.

**The capability never needs it.** It prepares a request and stops at review. Blocking outright is
both safer and simpler than any grant mechanism, and a half-built approval mechanism is worse than
none.

**What a real grant would have to carry**, written down so that building it later is a design task
rather than a guess:

```
{ runId, stepId, actionDigest, screenIdentityDigest, approvedBy, approvedAt, expiresAt,
  oneTimeUse: true }
```

Every field is load-bearing. `actionDigest` and `screenIdentityDigest` bind the approval to THIS
action on THIS screen, so a grant cannot drift onto a different control after a re-render.
`expiresAt` and `oneTimeUse` stop it from becoming a standing permission. `approvedBy` is who
answers for it afterwards.

---

## D54 - The pinned safety profile is blunter than the allowlist, and cannot be fixed here

**The finding, from a test written this phase.** The PHASE 7 requirement is that deny patterns be
CONTEXTUAL and word-bounded - `confirm transfer`, not a bare `transfer` that also blocks "Transfer
history". The allowlist written this phase satisfies that.

The PINNED SAFETY PROFILE does not. Its irreversible list contains the bare words `transfer`,
`delete`, `remove` and `approve`, chosen in PHASE 3 on the reasoning that a minimum which only
blocks the exact button in the demo is a demo rather than a minimum. So "Transfer history" - a
read-only link - is refused.

**It cannot be fixed by editing the profile.** That file is hashed into every artifact, including
the one approved at GATE 1, and editing a comment in it would invalidate every pinned hash and make
replay refuse to run with PROFILE_INTEGRITY_FAILURE.

**Decision: leave it, document it, and record the fix as a new profile VERSION.** Nothing in this
capability touches such a control, so nothing is broken today. `tests/policy.engine.test.ts` asserts
the false positive OUT LOUD rather than hiding it, and separately asserts that the layer this phase
does control is contextual. A `banking-default 2.0.0` with phrase-level rules is the real fix, and
it belongs with the artifact migration story rather than smuggled in here.

---

## D55 - Operator console security is built before the console does anything

**Decision.** Loopback-only binding with the host as a CONSTANT rather than a parameter; a 32-byte
per-run token; token-for-cookie exchange with HttpOnly, SameSite=Strict, short-lived,
intervention-scoped cookies; CSRF checks on every state-changing request; unguessable intervention
ids; and NO endpoint that lists interventions.

**Why now rather than with PHASE 8.** Access control retrofitted onto a working console is access
control that ships "for now" without any. The console's job is to hand a human control of a browser
signed into a banking application, which is the most dangerous surface in the project.

**[MUST] The token is never in a URL.** The CLI prints the URL and the token on separate lines. A
URL carrying a token leaks through the Referer header, browser history, shell history, proxy logs,
and the screenshot somebody takes of their terminal to ask a colleague for help.

**[MUST] No list-all endpoint.** Enumeration is the whole attack: with one, a single leaked token
becomes a directory of every run in flight, each with a live authenticated session behind it. A
cookie is scoped to ONE intervention, so it is worth exactly one handoff. An unknown intervention id
gets the SAME answer as a bad token, so the endpoint is not an oracle for which ids exist.

**What REPORT.md must say**: no enterprise identity, no RBAC, no per-operator accounts, no remote
operator auth. What it must NOT say is that the console has no access protection.

---

## D56 - Masking is hand-rolled PNG work, and the test reads pixels

**Decision.** `src/redaction/png.ts` decodes, draws and re-encodes 8-bit non-interlaced PNG on
Node's own `zlib`. `sharp`, `pngjs` and `jimp` would each do it in three lines and each is a
dependency the phase prompt did not name.

**Flat opaque rectangles, not blur or pixelation.** Both of those are reversible to a useful degree
and both LOOK like redaction to a reviewer, which is exactly what makes them dangerous.

**[MUST] The test compares pixels, not manifest entries.** Asserting that a manifest lists a region
proves only that a manifest was written. The claim is about the image, so the test decodes the
written PNG, samples the centre of a masked region, requires the mask colour, and separately
requires that less than a quarter of the screenshot is mask-coloured - otherwise "we painted the
whole thing" would pass.

**A box in the wrong coordinate space is worse than no box.** Boxes come from
`getBoundingClientRect()` inside their own frame and this application renders everything inside
`contentFrame`. Extraction now offsets them into page space; anything it cannot offset is REFUSED
and recorded rather than drawn.

**The offset was broken on the first attempt, in a way only a live test could catch.**
`frame.evaluate(string)` evaluates the string as an EXPRESSION. Handed a function DECLARATION it
produces a function object, which is not serializable, so the call threw, the throw was caught, the
offset was reported unknown, and every box silently stayed in frame coordinates. Nothing failed
loudly. The live test failed on `boxSpace` and named it immediately.

**Viewport screenshots, not `fullPage`.** A full-page capture is stitched from multiple viewport
captures and scrolls the page to take them, so the coordinates the observation just reported no
longer describe the image.

---

## D57 - The session broker checks that sign-on actually happened

**The bug, surfaced by the policy engine.** The broker fired its four sign-on actions and ignored
every result. When the policy engine started refusing one, the run carried on to the
authenticated-text wait, timed out, and reported

> signed on, but "Member Search" never appeared, so the session is not on the entry screen

which describes the symptom and points away from the cause. The actual message is now

> sign-on could not open the sign-on screen: ALLOWLIST_VIOLATION - origin ... is not in
> allowedOrigins

**Decision.** Every sign-on step is checked and a non-performed result throws immediately, naming
the step and the reason. The general rule: a helper that performs a sequence of actions and discards
their results converts a precise failure into a vague one, at exactly the moment somebody needs the
precise one.

---

## D58 - Resume is anchor matching, and a partially filled form matching nothing is the answer

**The tempting implementation** walks the states in order and resumes after the last one that still
holds. It is wrong in a way that produces a plausible-looking run against the wrong record.

**Checkpoints are not monotonic.** A member id is visible on the search results, the member record,
the form and the review. A heading can appear inside a modal sitting on top of a different screen. A
person can navigate straight to a later route without filling anything required on the way. Two
states can hold at once - which is precisely why resume-eligible states must be mutually exclusive
and why the distiller checks that they are.

**Decision.** Resume asks WHICH ONE state this screen matches. Exactly one is a resume point; zero
means we do not know where we are; more than one means the artifact's exclusivity has been violated.
Both of the latter go back to the person, with the reason.

**`subaccount-form` is not resume-eligible and `subaccount-form-complete` is.** A form with the
account type chosen and the deposit empty matches neither, so it returns to the human. That costs one
more question. Treating "the form screen is showing" as a resume point would have resumed by typing
over work an operator had just done by hand, which is the failure this design exists to prevent.

**Identity invariants are checked BEFORE the state search**, so a screen that matches nothing AND is
the wrong record is reported as the wrong record - the more serious of the two, and the one that must
never be answered with "please have another look".

---

## D59 - There is no /complete endpoint, and that is the whole claim

**Decision.** The console offers `resume` and `abort`. `allowedChoices` is typed as those two, so
the absence is enforced by the schema rather than by the UI, and a test asks the server for
`/complete`, `/success` and `/done` and requires 404 from each.

**Why it matters more than it looks.** "Only the SYSTEM may declare success" is the strongest claim
in this project. It has been enforced against the model since PHASE 4 - the model proposes
completion and the system re-observes and decides. If a person could click a button marked
"complete" and get `status: success` out of the other end, the claim would be about models only, and
it is not.

**`resume` subsumes completion.** The system re-observes, evaluates the success condition, validates
every declared output against its declared type, and declares success itself with
`completionMode: 'human_assisted'`. The operator's contribution is recorded permanently in the
result: a run a person helped with never reports as `automation`.

---

## D60 - The same-session guarantee is evidence, not assertion

**Decision.** `SessionIdentity` - the CDP `browserContextId` and page `targetId` - is captured before
control is ceded and again when it comes back, written to the evidence as two events plus an explicit
`handoff_same_session` comparison, and asserted by the end-to-end test.

**Why it needs proving at all.** A handoff that closed the browser and opened a fresh one would look
identical in a screenshot, in a log, and in a live demo. It would also have thrown away the
authenticated session, which is the one thing the automation had that the person needs. Every other
part of the handoff story is a claim about what the code does; this is a fact about two identifiers.

**The negative control matters as much.** A `sameSession()` that returned true unconditionally would
pass the positive test, so there is a test where the target id changes under it and the answer must
be false.

---

## D61 - Human acts are witnessed, because they cannot be gated

**The honest limit, stated first.** The lease governs SOFTWARE-issued actions. In the headed-browser
transport a person types on a real keyboard into a real window, and those keystrokes do not pass
through `resolveAndPerform`. Nothing in this system can stop them.

**Decision.** If the acts cannot be gated, they are recorded. Listeners are injected into every frame
during HUMAN_CONTROL for click, input, change, submit and navigation, and re-injected after every
navigation because a page load discards them.

**Why not just diff the observations.** A diff records the NET result: the deposit field holds a value
it did not hold before. It cannot tell "the operator typed it" from "the application autofilled it",
it cannot see a correction, and an act that leaves no visible trace does not appear at all. The diff
is kept as supplemental evidence rather than as the mechanism.

**[MUST] Never a raw typed value.** `HumanActionEvidence` has nowhere to put one:
`valueChanged: boolean` and an optional `redactedValueToken` that is a one-way hash prefix for
correlating the same value across two events. Not a rule about what to log - a shape with no field
for it.

**Desktop equivalent**: OS accessibility event hooks (UI Automation event handlers on Windows,
AXObserver on macOS). Same shape, same redaction rule, different source.

---

## D62 - Resuming while the blocker is still there asks again

**Found by driving the handoff by hand and pressing Resume without fixing anything**, which is the
first thing any operator will do.

An unrecognised blocking modal sits ON TOP of a member record, and the member record is exactly what
a resume-eligible state describes - so the screen matched, the run resumed, the next click went into
the modal's overlay, and Playwright reported a locator timeout. The run failed with a message about
an element intercepting pointer events: a description of the symptom that says nothing about the
cause.

**Decision.** After a resume, the detectors run again before anything else is decided. A needs_human
condition that is still present sends the same question back to the operator - `that is still in the
way: ...` - rather than resuming into it.

**Ordering.** The identity check comes first, because a screen can be both still-blocked and the
wrong record, and reporting the modal would hide the more serious fact. That is the detector ladder's
own rule - terminal before non-terminal - applied one level up.

---

## D63 - Escalate-reconcile is a loop, not a straight line

**The bug.** The first version escalated, reconciled, and if the reconciliation failed to place us,
escalated once more and carried on. "Carried on" meant re-running the step from a screen the system
had just said it could not place, which fails with a locator error - so a run that should have asked
a second question reported a control-not-found instead.

**Decision.** Asking again is the correct answer and it is the same question, so it is a `while` loop
bounded by `maxInterventions`. The bound exists because a person who cannot resolve something twice
will not resolve it on the third pass either, and a run that asks forever is worse than one that
stops.

**`cede` had to learn a second entry point at the same time.** From `AUTOMATION_RUNNING` it goes
through `PAUSING`, which admits no actor and makes the gap between the two leases safe. From
`RESUME_VALIDATION` - the second-question case - the system has already stopped, and
`RESUME_VALIDATION -> HUMAN_CONTROL` is the modelled transition. The state table written in PHASE 2
anticipated this; the first version of `cede` did not, and threw an illegal-transition error.

---

## D64 - A seeded member for the handoff, not an armed fault

**Decision.** Member `20001` carries `attestationRequired` in the seed data and raises the
unrecognised modal on its own.

**Why.** PHASE 8 has to be driven by hand: watch it stop, clear the modal in the real browser, resume,
watch it finish. A demo that needs a second terminal to POST a fault before it will reproduce is a
demo nobody reproduces. One command now does it:

```bash
npm run replay -- --artifact prepare_subaccount_review@1.0.0 \
  --params '{"memberId":"20001","accountType":"Savings","initialDeposit":"250.00"}'
```

**The id avoids `1000` on purpose.** Search is a substring match, and `q=1000` returning exactly four
identically-named `Open` links is what makes `T5_STRUCTURAL_ROW` necessary rather than theoretical. A
fifth match would have quietly changed what that test proves.

**The modal is clearable by a PERSON and not by the automation** - its attestation button posts to a
route the profile knows nothing about. That asymmetry is the point: it is the state that must reach a
human, and a human has to actually be able to resolve it, or the handoff is a wall to admire.

---

## D65 - Two routes for one page, and a test suite that could not see it

**The bug that blocked GATE 2.** The URL the CLI printed returned
`{"error":"no valid console session"}`. There was nowhere to enter a token, so the handoff could not
be driven by hand at all - while the automated end-to-end handoff test passed.

**Two causes, and the second one is the real one.**

1. The page was mounted behind the session guard. The first visit is unauthenticated BY
   CONSTRUCTION - obtaining the cookie is what the page is for - so guarding it makes the console
   impossible to open. The page is now served unauthenticated; every route with DATA behind it, and
   every route that changes anything, still requires the cookie.

2. **There were two routes for one thing.** PHASE 7 left a placeholder `GET /intervention/:id`
   returning JSON, and PHASE 8 added the real page at `/i/:id` without removing it. `consoleBanner`
   built its URL from one literal; the page was mounted at the other. Both strings were correct.
   They were not the same string.

**Decision.** The placeholder is deleted, and there is now ONE `interventionPath()` used by both the
banner and the route. A path that appears in two files is a path that will diverge, and this one
diverged inside a single phase.

**An unknown id still gets the page**, deliberately. A 404 there would say which interventions
exist, which is the same enumeration attack the missing list endpoint prevents. The page is static;
`/auth` then refuses the id with the same 401 a bad token gets.

**The PHASE 7 console tests were exercising the placeholder.** They asserted scoping, expiry and
revocation against a route that existed only as a stand-in - so they kept passing after the real
route diverged from it. They now mount a route through `mountScoped`, which is the API real code
uses.

---

## D66 - A test that drives the API is testing a different artefact than the one a person uses

**The pattern, twice in one phase.** The handoff mechanism worked: the lease moved, the session
survived, resume reconciled correctly, and an end-to-end test proved all of it. The thing a HUMAN
touches did not work at all. Before that, the manual walkthrough needed a fault armed from a second
terminal, which is why member 20001 was seeded (D64).

Both are the same mistake: building and testing the MECHANISM, and assuming the way a person reaches
it therefore works. The route-level tests were not wrong - `/complete` really did 404, data really
did require a cookie, the token really was in no URL. They were all asking the server questions. The
first thing a person does is a GET on the URL in the banner, and no test did that.

**Decision.** `tests/escalation.console.page.live.test.ts` drives a REAL BROWSER through the REAL
SEQUENCE: GET the banner URL with no cookie and require HTML and 200, type the token, require the
HttpOnly SameSite=Strict cookie to be set, require the operator view to render the reason and the
step and the live screenshot, click Resume and require the run to be told.

**The rule this generalises to**: where a human-facing path exists, at least one test uses it the way
the human does. An API test and a UI test are not two tests of one thing; they are tests of two
things, and the one that ships broken is the one nobody drove.

**It also earned an exemption in the input-path lint test**, and the exemption is worth reading. That
rule forbids `page.click` outside the transport because every action against the BANKING APP must go
through `resolveAndPerform`. The console is a different application, served by us, with no lease over
it and no input path to bypass. The exemption is a single FILE rather than a directory, and a test
asserts it stays that way and that the exempt file never touches the fixture.

---

## D67 - The attestation control cleared a flag that was never set

**The bug that blocked GATE 2 for the third time.** The handoff mechanism worked completely: the
modal was detected, the run stopped, the console opened, Resume without fixing anything correctly
reported "that is still in the way" and asked again. And the button that clears the modal did
nothing, so the demo could be started and never finished.

**The cause.** The handler deleted `showUnknownModal` from the SESSION fault store. For member 20001
that flag comes from the SEED DATA, through `seededFaultsFor`, and `mergeFaults` re-supplies it on
every render. The delete removed something that was never there.

**Decision.** Attestation is recorded as its own per-session fact - `attested` - which overrides the
modal from EITHER source, exactly as `dismissedNotice` already did for the maintenance banner. The
domain fact is "this session has attested", not "this fault flag is off", and modelling it as the
latter is what made a two-source flag look like a one-source flag.

**The code is now printed on screen and any non-empty value is accepted.** A demo that requires
knowledge a reviewer does not have is a demo a reviewer cannot run, and the thing being demonstrated
is the handoff rather than a puzzle. An empty code is refused, so the field is not decoration.

---

## D68 - D66 applied to the fixture, and an audit of every documented manual step

**Three times in one phase** the MECHANISM was proven and the path a person takes was not: the
walkthrough needed a fault armed from a second terminal (D64), the console could not be opened at
all (D65), and the control that clears the modal did nothing (D67).

D66 already named the rule - _where a human-facing path exists, at least one test uses it the way the
human does_ - and it had been applied to the operator console only. The application a person is
handed control of has human-facing controls too, and nothing clicked them: every test POSTed to the
route, so the ROUTE was proven and the CONTROL was not.

**Decision.** `tests/fixture.human-controls.live.test.ts` drives a real browser and clicks:
attestation (and asserts the modal is GONE and the record stays servable across three revisits),
Dismiss on the maintenance notice, and the entire happy path from search to the review screen.
Asserting a 303 would have passed throughout the outage.

**And the walkthrough itself was audited line by line**, which found a fourth problem nothing had
caught: `/artifacts` is gitignored, so on a clean checkout the documented replay command fails with
"prepare_subaccount_review@1.0.0 is not in artifacts". The only ways to fill it were to run a real
discovery - which costs money - or to have already done so. A reviewer who cannot run the walkthrough
cannot check any claim it makes.

`npm run demo:store` copies the tracked example into `artifacts-demo/`. Never into `artifacts/`: a
published version there is immutable, and seeding it would make the next genuine discovery run be
refused by the store.

**The audit table is in `docs/STATUS.md`**, one row per line of the walkthrough, naming what covers
it. Writing it is what surfaced the missing artifact - the rows for the first two commands had
nothing to point at.

**The general lesson, now stated where it applies to everything and not just consoles**: a test that
exercises the API is testing a different artefact from the one a person uses, and documentation is a
claim that has to be executed like any other. Every step of a documented manual path gets performed -
by a person or by something that clicks - before the path is called finished.

---

## D69 - /tests is laid out by what a test COSTS to run, not by what it covers

**Decision.** `unit/` (one module, saved AX snapshots, no browser), `contract/` (guarantees about
what we ship), `integration/` (the fixture, the CLIs, the console, every browser-driven path).

**Why cost rather than subject.** A subject split - `perception/`, `artifact/`, `replay/` - reads
better in a listing and answers the wrong question. The question a person has fifty times a day is
"can I run this in ten seconds", and that is decided by whether a browser starts. `test:fast` is
exactly `unit` plus `contract`, which is a fact about the directories rather than a glob somebody
maintains.

**`contract/` is the one worth arguing for.** Those tests are not about a module; they are about what
this project PROMISES: the golden artifact still validates and its pins still verify, the five
`RunResult` shapes and their exit codes, replay's dependency graph contains no provider, there is one
input path. They break when a promise breaks, which is different from a unit failing.

**The move found a bug in itself.** A blanket relative-path rewrite turned a string that describes
what a SOURCE file imports - `from '../config/sign-on.js'` in `src/cli/discover.ts` - into `../../`,
and `config.sign-on` failed. The test caught a bad edit to the test. Left as a comment in place,
because the next person to move these files will make exactly the same mistake.

---

## D70 - RunResult branches are strict, and zod 4 does not strip unknown keys

**Found by writing a contract test that assumed the opposite.** `z.object` in zod 4 passes unknown
keys through rather than dropping them, so a result read back from a `result.json` could carry a
field nobody declared straight to a caller.

**Decision.** Every branch of `RunResultSchema` is `z.strictObject`. TypeScript already stops OUR
producers from inventing a field - these are object literals against a typed union - so what this
closes is the read-back direction. A key we do not recognise means the sender and the receiver
disagree about the contract, and saying so beats handing the extra along.

**What it is NOT about, and I had this wrong first.** The test was originally written as "only
success can carry outputs", which is false: `outputs` on a `business_outcome` is a DECLARED optional
field and deliberately so. A run can read a declared output and then reach a negative answer - "the
member exists and here is their name, but the sub-account you asked about does not" - and discarding
it would make the caller ask again for something we already had. Strictness is about keys nobody
declared, not about which declared keys each status may carry.

---

## D71 - The gate list was audited against the code, and item 7 had no test

**The point of the audit.** Fifteen of the sixteen gate items already had a test, several of them
stronger than the item asks for. Item 7 - "an invariant may be true before and after" - had only its
INVERSE covered: `INVARIANT_IS_AN_EFFECT`, which rejects an "invariant" that only becomes true after
the action.

The positive half was untested, and so were the two rules that came out of the GATE 1 defect
(D30): `INVARIANT_FALSE_BEFORE_ACTION` and `INVARIANT_FALSE_AFTER_ACTION`. The second of those is
the rule that catches an invariant taken from the screen a step LEAVES - which distilled cleanly,
validated cleanly, and failed one transition downstream of the thing that was wrong.

**Three tests added**, all in `unit/artifact.states`: an invariant that holds on both sides is
accepted; one that does not survive its own transition is `INVARIANT_FALSE_AFTER_ACTION`; one that
was never true is `INVARIANT_FALSE_BEFORE_ACTION`.

**Item 2 was checked and is stronger than it needed to be**: the stale-context test uses a control
that exists on BOTH screens and resolves perfectly against the new one, which is the case
re-resolution alone cannot catch. Item 13 already covered all five resume outcomes.

---

## D72 - TEST_MAP is written to be accurate rather than generous

**Decision.** `docs/TEST_MAP.md` maps every gate item and every design commitment to the test
covering it, with a strength: **direct**, **structural**, or **thin**. Every row was checked by
opening the test named in it, and a script verifies that every path the document names exists.

**Structural is stronger than direct, and the document says so.** `ArtifactAction` has no field a
`markId` could occupy, so a mark id cannot reach an artifact whatever anyone writes. A test asserting
"no mark ids appear" would check one instance of something the type already forbids - which is the
coverage theatre this phase was told not to produce.

**It has a section for what is thin, and that section is the reason to trust the rest.** Cross-tenant
is not covered at all. The desktop adapter is a stub. Discovery runs against a scripted client in CI,
so nothing in the suite catches what a real model does - which is precisely what both GATE 1 runs
caught. Masking covers declared regions only. The downgrade claim is proven by one drift shape.

**The audit also found four references in `docs/STATUS.md` to test files that have never existed** -
`agent.discovery.test.ts` and `agent.verification.test.ts`, whose real names carry `.live`. They had
been wrong since PHASE 4 and no one had followed them. Every documented path now resolves, checked
mechanically rather than by eye.
