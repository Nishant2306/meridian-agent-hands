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
