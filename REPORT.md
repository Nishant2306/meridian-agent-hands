# REPORT

| §   | Requirement            | Built in                                                 | Tested by                                                            | Evidence                                                      |
| --- | ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| 3.1 | Architecture           | `agent`, `artifact`, `replay`, `surface`, `perception`   | `contract/replay.boundary`, `policy.input-path.lint`, `surface.live` | `discovery/`, `success/`                                      |
| 3.2 | Artifact schema        | `artifact/{schema,distill,parameterize,hash,approve}`    | `unit/artifact.*`, `contract/artifact.*`                             | `artifact/*.json` and `.draft.json`                           |
| 3.3 | Determinism and errors | `replay/{engine,observation-loop}`, `artifact/detectors` | `contract/replay.result-shapes`, `replay.outcomes.live`              | `notFound/`, `recovery/`, `permissionDenied/`, `unavailable/` |
| 3.4 | Heterogeneity, tenancy | `types/surface`, `surface/*`, `fixtures/legacy-app`      | `fixture.smoke`, `unit/perception.resolver`                          | tier assertions on `success/`                                 |
| 3.5 | Escalation and handoff | `escalation/*`, `session/*`                              | `unit/escalation.handoff`, `escalation.*.live`                       | `handoff/`                                                    |
| 3.6 | Safety                 | `policy/*`, `surface/bootstrap-policy`, `redaction/*`    | `unit/policy.engine`, `redaction.masking.live`                       | mask manifests, every run                                     |
| 3.7 | Cuts                   | section 7                                                | n/a                                                                  | n/a                                                           |

`docs/TEST_MAP.md` is the accurate per-claim version and names what is **thin** rather than padding
rows. **Multi-tenancy in 3.4 is uncovered**, not partly covered: there is no second tenant and no
test, and that row rests on the surface contract alone.

## 1. Architecture

Three modes over one machine (diagram in `README.md`). **Discovery** puts a model in an
observe-decide-act loop against a live UI; **distillation** turns that run into a typed capability;
**replay** re-executes it with no model in the loop. `src/agent` is the only package importing a
provider.

Every software-issued action, in both modes, goes through **one** function: `resolveAndPerform` -
policy check, observe, resolve, revalidate, act, record - with one `TargetResolver` behind it. A
second path is the obvious way to make replay faster, and how you get a guardrail that holds in
discovery and not in production. A lint test fails the build on `page.click` outside the transport
adapter.

Perception is **accessibility-first**: the AX tree per frame, enriched with nearby text, boxes and
legacy-stable attributes. It costs real work - a thin AX tree needs DOM fallback, and `paragraph` has
no name-from-content, which broke a real run - but it is what makes a locator survive a UI whose
class names change every boot.

The **contract is declared by a human** in a `DiscoverySpec`: types, sensitivity, outputs, record
identity, and which conditions may be recognised. The model discovers only the **path**, selecting
from a numbered inventory rather than authoring a selector; those numbers have nowhere to live in an
artifact, because `ArtifactAction` has no field for one.

## 2. Artifact schema

An artifact is **states and steps**. A state is a screen: assertions, qualifiers, invariants. A step
carries an action, an expected effect and separately the invariants that must hold throughout. That
split is load-bearing. An "invariant" that only becomes true after the action is an effect and the
distiller rejects it; one taken from the screen a step leaves distills cleanly and fails a transition
later, which is how a real defect reached replay.

Three versions, deliberately separate: `schemaVersion`, `capabilityVersion`, and the target
application's `versionRange`. Collapsing them means a schema fix forces a capability re-approval.

A `TargetDescriptor` splits into **semantic** - role, accessible name, nearby text, row key - and
**adapterHints**. So the portability claim is narrow: the **contract** is surface-independent, the
**locator hints are not**. A web-recorded artifact does not replay unchanged on a desktop app, and
saying otherwise would be the easiest lie here.

Outputs are **declared** by a human and **bound** by the run, sourced from a named state rather than
a step position. Profiles are pinned by `{id, version, sha256}`, and those hashes are semantic
content: written before the content hash is computed, and included in it. `contentHash` excludes
exactly `status`, `approvedAt`, `approvedBy`, so approval is provably a status flip - draft and
approved hash identically while the files differ.

## 3. Determinism and error handling

Replay makes zero model calls, proven three ways: `ReplayDeps` has no client field; a test walks the
module graph from `src/replay/index.ts` and finds no provider, with a negative control that proves
the walk works; and a provider-call counter is snapshotted around every run.

Detectors run on **every** observation pass, inside the wait rather than after it. Waiting first and
interpreting second looks right and reports `MEMBER_NOT_FOUND` correctly, just always at the cost of
a full timeout - the difference between a service and a queue. The test asserts elapsed time against
the step's own timeout.

The ladder is fixed: global safety, hard failures, known outcomes, recoveries, needs-human. Terminal
states come before remediation, because a recovery is an **action** and acting on a decided run is
worse than stopping.

Ambiguity is never guessed: conflicting locator signals return `LOCATOR_CONFLICT`, two matches return
`AMBIGUOUS_CONTROL`. In a bank the cost of the wrong row is not symmetric with the cost of stopping.

A caller gets one of five shapes with distinct exit codes. `business_outcome` (10) is separate from
`failed` (30) because "there is no such member" must not page anybody, and no `RECORD_NOT_FOUND`
error exists for a careless branch to conflate them through.

Recoveries are bounded and carry a **continuation policy**. The maintenance notice appears on the
page a click navigated to - the click worked - so the continuation re-observes and rechecks the
effect instead of repeating the action. A blanket retry would navigate twice.

## 4. Heterogeneity and multi-tenant

The `Surface` contract was written against a genuinely awkward target: iframes, fields labelled by a
`<td>` to their left, ASP-style `name=` attributes, no test ids, and class names and element ids
regenerated from a random seed on every boot.

That last property is what the evidence turns on. The capability is discovered against one boot and
replayed against another, and the tier each control resolved at is asserted individually: the search
box at T1 by role and name, the table-labelled fields at T3 by the adjacent label, the row control at
T5 by its key cell. Without that the restart proves little - the fixture keeps its legacy `name=`
attributes, so a run falling back to T4 everywhere would survive it while the accessibility-first
claim did no work.

The desktop side is a **stub**: it compiles, throws, and documents the UI Automation call each method
would make. It shows the contract is expressible without a browser, not that it is right for a
desktop app. A web artifact needs a desktop **target binding** before it could run there.

Multi-tenancy is **designed, not built**. `semanticKey` exists on every descriptor and nothing reads
it. It is there so adding tenants is not a schema retrofit against artifacts already content-hashed:
the cheapest thing to get right early and the most expensive later.

## 5. Escalation and handoff

An unrecognised **blocking** dialog is detected structurally, by role: something nobody described
cannot be matched on its wording. The run pauses, revokes the automation lease, issues a human one,
and prints a console URL with the token on its own line.

Control transfers on the **same live session**: the process stays alive and the browser context is
not recreated. That is evidenced rather than asserted - context id and page target id are recorded
before control is ceded and again when it returns. A handoff that quietly opened a fresh browser
would look identical in a screenshot, a log and a demo.

Resume is **anchor matching**, never "the furthest checkpoint that holds". Exactly one
resume-eligible state must match; zero or two go back to the person. A partly filled form matches
nothing, which is cheaper than typing over work somebody just did. Identity invariants are checked
first, so a wrong record is reported as one.

**Only the system declares success.** There is no `/complete` endpoint and `allowedChoices` is typed
`resume | abort`, so the absence is in the schema rather than the UI. On resume the system
re-observes, validates every declared output and decides, recording `completionMode: human_assisted`.

The honest limit: the lease governs **software-issued** actions. A person at a real keyboard is out
of band, so human acts are **witnessed** - per-frame listeners record what changed, with nowhere to
put a raw value. The console is minimal by choice: the mechanism was the interesting part.

## 6. Safety

One input path means one place to enforce. Two layers run there: a hardcoded bootstrap minimum and a
configurable engine on top. The effective decision is the stricter, and both are tested separately
against the same action.

Effective risk is the **maximum** of artifact-declared risk, control-derived risk and profile rules,
so an artifact labelling "Submit Request" safe is not believed. **Irreversible actions are always
blocked and there is no flag to allow one** - a test greps the CLIs and the engine and finds no
override. Prepare-don't-commit is the right shape for a bank: it puts the model's work in front of a
person at the point where reversal stops being cheap.

Three data mechanisms, never conflated. Persistence is **pseudonymized** with a per-run random map -
a truncated hash of a five-digit member id is enumerable in a second and would look careful.
Artifacts are **scanned and rejected**, never rewritten: a hit means the distiller has a bug and
rewriting hides it. Caller results are **not redacted**, because a capability that will not tell its
caller what it read is useless.

Masking is by declared box, verified in pixels, and only the masked image is ever written. Without
OCR we cannot prove a value is absent from a screenshot, so the claim is scoped to declared regions.
The console is loopback-only, the token never in a URL, and there is no list-all endpoint: an unknown
id gets the same answer as a bad token.

## 7. Cuts

- **Desktop adapter.** First: the contract exists, the UI Automation work does not, and it is the
  claim most exposed.
- **A second tenant**, to make surface-independence demonstrated rather than designed.
- **A second capability in the evidence bundle.** `lookup_member_savings_balance`, a read-only
  lookup, is specified and runs end to end: no schema change, no engine change, a spec and a
  discovery run. What is single-capability is the evidence HARNESS: its manifest schema
  (`scripts/evidence/lib/manifest.ts`) names one capability; the scenario set and tier expectations
  follow from it. The schema was not in the way.
- **Streaming console with input forwarding**, so an operator needs no local browser.
- **Action-scoped approval grants** - signed, expiring, single-action. The shape is written up; a
  half-built version would be worse than today's absolute block.
- **Durable storage.** Artifacts are files.
- **Enterprise identity.** Real sign-on needs a secret broker and session federation.
- **OCR-based redaction**, to close the gap between "declared regions are masked" and "no sensitive
  value is in the image".
- **Visual locator tiers**, below T5, for controls with no accessible name at all.
- **Stability scoring and demotion**, so a locator that keeps downgrading is flagged before it fails.
- **An async run-status API** for `needs_human`, so a caller need not hold a process open.
