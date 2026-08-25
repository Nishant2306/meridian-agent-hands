# Data handling

What leaves this process, what gets written down, and what is deliberately still open.

Two questions that look alike and are not:

|                           | Question                            | Where it is answered               |
| ------------------------- | ----------------------------------- | ---------------------------------- |
| **Model boundary**        | What may leave this process at all? | `src/agent/boundary.ts` (PHASE 4)  |
| **Persistence redaction** | What may be written down?           | `src/evidence/logger.ts` (PHASE 7) |

They need separate answers, because a value can be perfectly fine to keep in an internal log and
still be something you would rather not hand to a third-party API.

---

## The model boundary (built)

Applied before every model call.

### 1. Secrets are never sent

The model proposes `{ kind: 'secretRef', name }`. The executor resolves it, in-process, one step
before the keystrokes. There is no path by which a secret value reaches a prompt, and there is no
tool argument that could carry one: `value` is always the `ValueBinding` union.

Tested: the fixture passcode never appears in anything the model was shown.

### 2. A value we typed is shown as its ORIGIN

When the executor types a declared parameter into a field, that field renders to the model as
`[PARAM:memberId]` rather than the value. The model asked for the parameter; it does not need the
value handed back.

### 3. [MUST] We do NOT blind-substitute over text the model reads off the page

It is tempting to scan every observation for any string equal to a parameter value and replace it.
**That corrupts the observation.** Partial and coincidental matches are common - an account number
that CONTAINS the member id, a balance that happens to equal the deposit - and a model shown
`[PARAM:memberId]-01` where the screen said `10001-01` has been handed a lie about the application
it is operating.

Substitution therefore happens ONLY where the ORIGIN of a value is known, which means only where we
typed it. `ValueOriginTracker` records origins, never content, so it cannot mask a value it did not
put there.

Tested both ways: `[PARAM:memberId]` does appear for the field we filled, and the member name the
model READ off the review screen appears as itself.

### 4. The inventory is capped to the current screen

Every interactive control is kept wherever it is - hiding one would make the screen look like it has
no way forward - along with every alert, dialog and heading. Passive content from frames that are
not the working area is dropped, which on this application removes the banner, product name and
version marker repeated once per frame.

### 5. No screenshots

Marks are numbers in text. The model never has to read pixels, so no image ever leaves the process.
Screenshots are captured for EVIDENCE only.

---

## What this does NOT do yet

**Sensitive values the model READS off the page are sent as they appear.** On this application that
means a member's name and their account balances. Rule 3 is why: we will not corrupt an observation
to hide them, and pseudonymizing them properly is a different piece of work.

For a real deployment, the next step is a **declared-sensitivity pseudonymizer for read-only nodes**:

- the spec already declares `sensitivity` per output, so the system already knows which VALUES are
  PII once they are bound
- a stable per-run pseudonym (`MEMBER_NAME_1`) can be substituted for a node whose sensitivity is
  declared, with the mapping held in-process and never persisted
- the model can then reason about "the member name cell" without the name, and the executor
  un-substitutes when a value is bound to an output

That is tractable, and it is deliberately not built here: it changes what the model sees on every
screen, and doing it before GATE 1 would mean the first real discovery run was driven against a
view of the application nobody had validated.

**It also does not stand alone.** Pseudonymization is a technical control, and the rest of it is
contractual. A real deployment needs, at minimum:

- a data-processing agreement with the model provider covering the categories of data in scope
- **zero data retention** or an explicitly bounded retention window, with training opt-out
- a region commitment, if the data is subject to one
- an incident path that assumes prompts may have been retained despite the above

None of those are code, and none of them are optional. A system that pseudonymizes carefully and
then posts to an endpoint that trains on its inputs has not protected anything.

---

## Persistence (PHASE 7)

`redactForPersistence` in `src/evidence/logger.ts` is the identity function today, and it is called
on every event, so PHASE 7 changes one function rather than auditing every call site.

**What is already true, and is not deferred:** secret VALUES never enter an event in the first
place. Bindings are described by name (`"valueBinding":"secret:operatorPasscode"`), so there is no
secret in the pipeline for a redactor to have to catch. Verify it on any run:

```bash
grep valueBinding runs/*/events.jsonl
```

**What is deferred:** PII pseudonymization in logs, transcripts, evidence and CLI output. Member
ids, names and amounts are currently written as they appear.

**Screenshots are UNMASKED.** Without OCR it is not possible to prove a sensitive value is absent
from screenshot pixels. PHASE 7 masks declared sensitive regions BY BOX, using
`PerceivedControl.box`, which is captured today and unused until then - and the claim will be
scoped to exactly that: declared boxes are masked, and nothing stronger is asserted.

---

## The artifact itself

A distilled capability contains **no runtime values**. That is not a convention, it is enforced and
it fails closed: `sweepParameterization` walks every site a value could hide in - action values,
navigate segments, row keys, assertion expectations, locator hints, output patterns, provenance -
and refuses to emit an artifact carrying one.

Declared enum members are allowed, because `Savings` is a contract constant as well as an invocation
value. Everything else that matches a value from the run is a refusal.

There is also **no `goalDigest`**. A SHA-256 of a rendered goal is brute-forceable: a hundred
thousand five-digit member ids against a known template is seconds of work, so a digest of
`"...member 10001..."` is a member id in a costume. Provenance stores the goal TEMPLATE only.
