# DECISIONS - the thirteen that shaped everything else

There are two decision documents in this repository and they do different jobs.

- **`/DECISIONS.md`** is the build log: seventy-odd entries, in the order they were made, including
  the ones that were made badly and corrected. It is the primary source and nothing here contradicts
  it.
- **This file** is the short version: the calls that could reasonably have gone the other way, each
  with what it cost. If you read one, read this one.

Each entry says what was decided, why the obvious alternative was rejected, and what the decision
costs - because a decision with no cost was not a decision.

---

## 1. Perception is accessibility-first, and never a CSS selector

**Decided.** A control is identified by role, accessible name, nearby visible text, a legacy-stable
attribute, or its position in a keyed row. Never by a class, an id, or an XPath. The fixture
regenerates every class name and element id from a random seed on each boot, so a selector-based
implementation fails on the second run and cannot be quietly reintroduced.

**Rejected.** Recording Playwright selectors, which is what a recorder does and what works in a
demo.

**Cost.** Real, and paid more than once. The AX tree is thin on old markup and needs DOM enrichment.
ARIA gives `paragraph` no name-from-content, so a descriptor synthesized from a perceived paragraph
resolved to nothing - a defect that only appeared in a live model run. Accessibility-first is not
free perception; it is a different set of problems, chosen because they are the survivable ones.

---

## 2. The model never authors a selector, and its numbers never reach the artifact

**Decided.** Each observation produces a numbered inventory of perceived controls. The model's action
schema accepts a `markId` and nothing else. Before an action runs, that mark is converted into a
`TargetDescriptor` synthesized from what was perceived.

**Rejected.** Letting the model emit a locator string. It is one field in a schema and it removes an
entire conversion layer.

**Cost.** Descriptor synthesis is a real component with a real invariant - a descriptor synthesized
from a perceived control must resolve back to that control - and it has to be tested exhaustively,
because a failure there looks exactly like a confused model.

**What it buys.** Mark ids are ephemeral and cannot reach an artifact, because `ArtifactAction` has
no field one could occupy. That is structural, not enforced.

---

## 3. The contract is declared by a human; only the path is discovered

**Decided.** Types, sensitivity, outputs, record identity, and which conditions the system may
recognise are written by a person in a `DiscoverySpec`. The model discovers how to operate the UI.

**Rejected.** Having the model infer the schema from what it saw, which would demo better and remove
the setup step.

**Cost.** Somebody has to write a spec before anything can be discovered, and the spec is a real
document rather than a sentence.

**Why.** A model that infers that a field is not sensitive is a model that decides what may be
logged. A model that infers the output type decides what the caller is promised. Those are business
decisions, and inferring them is not a capability, it is an unreviewed policy change.

---

## 4. Completion is proposed by the model and declared by the system

**Decided.** The model may propose `goal_reached`. The system then takes a **fresh** observation,
extracts every declared output, validates each against its declared type, and checks the record
identity. Only then is the run a success.

**Rejected.** Trusting the proposal, which is what the model's own confidence is for.

**Cost.** An extra observation on every successful run, and a class of failure - "the model thought
it was done and it was not" - that has to be represented and reported.

**And it binds the operator too.** There is no `/complete` endpoint. `allowedChoices` is typed
`resume | abort`, so a console cannot offer one. A person who has finished the job by hand presses
Resume, and the system re-observes and decides. The rule is about who is allowed to declare success,
not about who is trusted.

---

## 5. Expected effects and invariants are separate fields

**Decided.** A step records what its action is expected to CHANGE, and separately what must remain
true throughout. An "invariant" that only becomes true after the action is rejected at distillation
as an effect.

**Rejected.** One list of assertions per step, which is what most step-based automation has.

**Cost.** The distiller has to reason about before-and-after states rather than snapshotting one, and
three distinct rejection codes exist where one would do.

**Why it earns its keep.** An invariant taken from the screen a step LEAVES distills cleanly,
validates cleanly, and fails one transition downstream of the thing that is actually wrong. That
happened, in the first real replay, and it is the kind of defect that costs an afternoon.

---

## 6. Business outcomes and errors are separate type hierarchies

**Decided.** `BusinessOutcomeCode` and `ErrorCode` are disjoint enums. "There is no such member" is
`MEMBER_NOT_FOUND`, a business outcome, exit code 10. There is no `RECORD_NOT_FOUND` error and
`ErrorCode` has no member for one.

**Rejected.** One error enum with a severity field, which is smaller and reads fine.

**Cost.** Two taxonomies to maintain, and every caller has to branch on `status` before reading a
code.

**Why.** With one enum, the difference between "the automation broke" and "the answer is no" is a
field somebody can forget to check. In a bank that means paging an on-call engineer every time a
member id is mistyped. The distinction is worth being unable to collapse.

---

## 7. Zero LLM calls in replay is proven architecturally, not asserted

**Decided.** Three independent proofs. `ReplayDeps` has no client field, so there is nowhere to pass
one. A test walks the module graph from `src/replay/index.ts` and fails if any provider package is
reachable, **with a negative control** that proves the walk can detect one. A provider-call counter
is snapshotted around every run and asserted zero.

**Rejected.** A `mode: 'deterministic'` flag, which is one line and is what everybody does.

**Cost.** The import-boundary test is fiddly and has to be maintained as the module graph changes.

**Why.** A flag is a promise about behaviour that one careless import invalidates, and the failure is
silent: replay still works, it just costs money and stops being deterministic. Making it impossible
to import beats making it possible and asking nicely.

---

## 8. Ambiguity is never resolved by guessing

**Decided.** Two matching controls return `AMBIGUOUS_CONTROL`. Locator signals that disagree - role
plus name pointing one way, the stable attribute another - return `LOCATOR_CONFLICT`. Neither picks
the first match.

**Rejected.** First match, or highest score. Both always produce an answer, which is what makes them
attractive.

**Cost.** Runs stop that a first-match implementation would have completed, including runs where the
first match was right.

**Why.** In a member search, two rows means two people. The cost of stopping is a person looking at a
screen. The cost of guessing is an action against the wrong record, discovered later, by somebody
else.

---

## 9. Irreversible actions are always blocked, with no flag to allow one

**Decided.** Effective risk is the **maximum** of artifact-declared risk, risk derived from the
control itself, and the profile's rules. Anything that comes out `IRREVERSIBLE` is refused. There is
no `--approve-irreversible`, and a test greps both CLIs and the policy engine to confirm it.

**Rejected.** An override flag for the operator, which every automation tool grows eventually.

**Cost.** This system cannot complete a workflow that ends in a submission. The capability prepares
the request and stops at the review screen.

**Why that is the right shape anyway.** Prepare-don't-commit puts the model's work in front of a
person exactly where reversal stops being cheap. What a real action-scoped grant would need - signed,
expiring, bound to one control on one screen in one run - is written up rather than half-built,
because a half-built version of that is worse than an absolute block.

---

## 10. One lease, and an honest statement of what it does not cover

**Decided.** One actor may issue software actions at a time, enforced by a lease token that is
checked inside the single input path. Issuing a new lease invalidates the previous one. The session
state machine enforces the same exclusion independently, so one being wrong does not mean two actors
drive at once.

**The limit, stated in `REPORT.md` and not only here.** The lease governs **software-issued** actions.
A person at a physical keyboard is out of band: nothing in a headed browser can stop them typing.

**So human acts are witnessed rather than gated.** Per-frame listeners record clicks, inputs and
navigations, re-injected after each navigation. `HumanActionEvidence` has nowhere to put a raw value:
it records that a value changed, plus a one-way correlation token. The desktop equivalent is OS
accessibility event hooks.

---

## 11. Resume matches a unique anchor, not the furthest checkpoint that holds

**Decided.** On resume the system re-observes and looks for exactly one matching resume-eligible
state. Zero matches or two matches both return control to the person.

**Rejected.** Resuming from the furthest checkpoint whose assertions still hold, which is the obvious
implementation and sounds more capable.

**Cost.** Some resumes that could have continued do not. A partly filled form matches nothing and
goes back to the human.

**Why.** Checkpoints are not monotonic: a later state's assertions can hold on a screen the run never
reached. And a partly filled form is precisely the case where continuing means typing over work
somebody just did. Identity invariants are checked first, so the wrong record is reported as the
wrong record rather than as "please look again".

---

## 12. Artifacts are scanned and rejected, never rewritten

**Decided.** The parameterization sweep looks for runtime values in every field the distiller
produces, including free text the model authored - step intents and assertion descriptions. A hit
**fails the distillation**. Nothing is substituted.

**Rejected.** Replacing the found value with a parameter reference, which recovers the run and is
what a rewrite would do.

**Cost.** A discovery run that leaked a member id into a sentence is lost, and it cost money.

**Why.** Blind substitution corrupts input examples, typed literals, descriptors, expected values and
URL templates that legitimately contain the same characters. More importantly, a hit means the
DISTILLER has a bug, and rewriting the output hides the bug while making the artifact look fine.
Persistence is pseudonymized, artifacts are refused, and caller results are untouched: three
mechanisms, and conflating any two of them breaks one of them.

---

## 13. Condition and safety profiles are immutable and pinned by hash

**Decided.** Profiles are versioned YAML files, pinned into every artifact as
`{id, version, sha256}`. Those hashes are **semantic content**: written before the artifact's content
hash is computed and included in it. Replay re-verifies them and returns `PROFILE_INTEGRITY_FAILURE`
on any mismatch, before the browser opens.

**Rejected.** Loading profiles by id at replay time and trusting whatever is on disk.

**Cost.** It is severe and it was felt. Editing a **comment** in a pinned profile invalidates every
artifact that pinned it. When the fixture and a detector disagreed, the fix had to be in the fixture,
twice, and both times the real problem turned out to be perception rather than wording. One
requirement could not be met at all: the pinned irreversible list contains the bare word `transfer`,
so "Transfer history" is refused. That false positive is documented out loud rather than fixed,
because fixing it means a new profile version.

**Why.** A capability approved against one definition of "this dialog means stop" must not silently
start running against another. If the rules change, that is a new version and a new approval, which
is the entire point of pinning them.
