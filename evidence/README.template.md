# EVIDENCE

**This is the TEMPLATE. The bundle's own `README.md` is generated from it.**

Every placeholder below - written `FILL AFTER RUN` with a key, in angle brackets - is a run
identifier or a result line that only a real run can produce, and every one is filled from a FILE IN
THE BUNDLE: the same files
`npm run evidence:verify` re-derives its claims from. Nothing here is typed by hand and nothing in
this repository invents one: a fabricated run id in a document that looks like a report is worse than
an empty template, because a reviewer cannot tell the two apart.

A value that can only come from the manifest is rendered `[manifest] ...`, exactly as the verifier
marks its own. Which member a run used is the case - the run files are pseudonymized with a map that
is random per run, so the bundle genuinely cannot tell you.

`npm run evidence:automated` and `npm run evidence:handoff` regenerate `README.md`. A published
bundle that still contains a marker is a FAIL, and so is one whose README names a different run from
its manifest.

```bash
npm run evidence:automated
```

```bash
npm run evidence:handoff
```

```bash
npm run evidence:verify
```

The first needs `ANTHROPIC_API_KEY` and makes exactly one real model call. The second needs a person
at the keyboard. The third needs neither, and re-derives from these files everything that can be
re-derived from them.

---

## What is in here

| Path                        | What it is                                                                       |
| --------------------------- | -------------------------------------------------------------------------------- |
| `manifest.json`             | the index: hashes, seeds, run ids, and one line per scenario                     |
| `artifact/*.draft.json`     | the capability as the distiller produced it, before approval                     |
| `artifact/*.json`           | the same capability after approval. A different FILE, the same CONTENT hash      |
| `<scenario>/<runId>/`       | one run: `events.jsonl`, `result.json`, `steps.json`, `screenshots/`             |

Each run directory holds:

| File                          | What it answers                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `events.jsonl`                | what the SYSTEM did: every action, block, wait, lease and recovery               |
| `transcript.jsonl`            | what was SAID: what the model was shown and what it asked for (discovery only)   |
| `result.json`                 | the `RunResult` a caller would receive                                           |
| `steps.json`                  | per step: status, the locator tier it resolved at, attempts, recoveries          |
| `completion.json`             | discovery only: the model, the call count, and whether completion was VERIFIED   |
| `screenshots/NNNN.png`        | masked capture                                                                   |
| `screenshots/NNNN.mask.json`  | which regions were masked, why, and anything that was REFUSED rather than drawn  |

### [MUST] `transcript.jsonl` cannot tell you what the model saw

It is **pseudonymized on the way to disk**, like every other persisted file. A declared value the run
was invoked with appears there as `[memberId:subject-01]`, and that substitution happened when the
line was written - **not** when the model was shown the screen.

This misleads in the direction that matters. Reading the transcript, it looks as though the model was
handed a placeholder where a member id should have been and might reasonably have concluded its read
had failed. It was not: it saw `10001`. Diagnosing the GATE 3 discovery failure started with exactly
that wrong conclusion.

Two label formats appear in a transcript and they are not the same mechanism:

| Looks like              | Written by                       | Means                                                      |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- |
| `[memberId:subject-01]` | the pseudonymizer, at write time | the model saw the real value; the FILE does not carry it   |
| `[PARAM:accountType]`   | the model boundary, at send time | the model really was shown this, and never the typed value |

The second is model-boundary minimization and applies to values the automation typed into a control.
The first applies to anything written down.

The same is true of the goal. The console prints the goal **as sent**, with real values, because the
CLI does not redact the invocation back to the person who typed it. The transcript's copy is
labelled. `tests/integration/agent.boundary.goal.live.test.ts` asserts both halves in one run.

### Where the raw record actually is

**`run.json` is not in this bundle and cannot be**, so this section has to tell you where it went.

It is the only file that answers "what did the model see", and it is the only persisted file that is
not pseudonymized. Both facts have the same cause: the distiller's parameterization sweep finds
runtime values by looking for them VERBATIM, so a record of labels would sail straight through the
guard that exists to catch leaks. Publishing it would put unredacted screen text in a repository.

`npm run evidence:automated` copies it to **`runs/evidence-raw/<runId>/run.json`**, which is
gitignored and lives in the repository rather than in a system temp directory that gets cleaned up.
The path is also recorded in `evidence/.runtime.json`.

**The honest limit, stated rather than left to be discovered:** a reviewer who has only this
repository cannot answer "what did the model see". The bundle deliberately cannot carry that. What
the bundle does carry is what was ASKED and DECIDED - `transcript.jsonl` for the turns,
`completion.json` for whether the system verified completion - and those are enough for every claim
made here.

**`run.json` is deliberately absent** from every run directory. See "Where the raw record actually
is" above.

---

## How to read `result.json` next to a terminal

The values in `result.json` are **labelled** - `[memberName:subject-01]` rather than a person's name.
The caller of `npm run replay -- --json` got the **real** values on stdout. That is not an
inconsistency, it is the design:

| Channel                | Rule                | Why                                                       |
| ---------------------- | ------------------- | --------------------------------------------------------- |
| `--json` on stdout     | not redacted        | the agent asked what the review status is; a label is not an answer |
| stderr, for a person   | pseudonymized       | it gets pasted into tickets and chat                      |
| evidence on disk       | pseudonymized       | it gets copied                                            |
| the artifact           | scanned and REJECTED| a rewritten capability corrupts literals and hides a distiller bug |

The label map is **random per run and never written down**, so the same member is labelled
differently in two runs. That is correct and it costs something real: you cannot correlate runs from
the evidence. `manifest.json` records which member each run used, and `evidence:verify` marks the two
checks that rely on it `[manifest]` rather than claiming to have proved them.

---

## The scenarios

Requirement references are to the brief's section 3. `docs/TEST_MAP.md` carries the same mapping
against the test suite, and `REPORT.md` has the combined table.

---

### `discovery/` - a model drives a live UI until a goal is met

**Proves** that the path was DISCOVERED and not written by hand: a real model, in the decision loop,
choosing from a numbered inventory of perceived controls, on a UI with no API and no test ids. And
that completion was declared by the SYSTEM after an independent re-observation, not by the model
saying it was done.

**Requirement** 3.1 architecture (discovery mode) - 3.2 artifact schema (what distillation produced)

**Read**

- `completion.json` - `model`, `llmCalls`, and `completionVerifiedBySystem`
- `transcript.jsonl` - what the model was shown and what it asked for, turn by turn
- `events.jsonl` - `action_attempt` / `action_performed` pairs with the tier each resolved at
- `../artifact/*.draft.json` - what the run distilled into

Read `transcript.jsonl` for what was ASKED and DECIDED, not for what was displayed - see the note
above on why it cannot answer that. `completion.json` carries `goalTemplate`, unrendered: the
RENDERED goal contains the member id and is deliberately not published, which is the same rule as
everywhere else here.

**The line that matters most** is `successObservationId` in `completion.json`. It is set only after a
fresh observation in which every declared output was extracted and validated against its declared
type and the record identity was checked. A model proposing `goal_reached` sets nothing.

```
run id:   <<FILL AFTER RUN: discovery.runId>>
model:    <<FILL AFTER RUN: discovery.model>>
result:   <<FILL AFTER RUN: discovery.result>>
```

---

### `success/` - the capability replays on a member the model never saw

**Proves** the through-line. A different member, a fixture restarted with a different obfuscation
seed so every CSS class name and element id in the application has changed, and **zero model calls**.

**Requirement** 3.1 architecture (replay mode) - 3.3 determinism

**Read**

- `result.json` - `metrics.llmCalls`, and `completionMode: automation`
- `steps.json` - the tier each control resolved at

**The seed restart on its own proves less than it looks.** The fixture keeps its legacy-stable ASP
`name=` attributes, so a replay that resolved every control through those would survive a restart
and prove nothing about accessibility-first perception. `evidence:verify` therefore asserts the tier
each key control resolved at, individually: the search box by role and accessible name, the
table-laid-out fields by the label in the cell beside them, the row control structurally by its key
cell.

```
run id:      <<FILL AFTER RUN: success.runId>>
result:      <<FILL AFTER RUN: success.result>>
llm calls:   <<FILL AFTER RUN: success.llmCalls>>
member:      <<FILL AFTER RUN: success.member>>
tiers used:  <<FILL AFTER RUN: success.tiers>>
```

---

### `notFound/` - a negative answer is not a failure

**Proves** that business outcomes and errors are separate type hierarchies. Member 99999 does not
exist. The automation worked perfectly and the answer is no.

**Requirement** 3.3 determinism and error handling

**Read**

- `result.json` - `status: business_outcome`, `outcome: MEMBER_NOT_FOUND`
- `events.jsonl` - the elapsed time between the action and the detection

Exit code **10**, not 30. There is no `RECORD_NOT_FOUND` error anywhere in the type system, so a
caller cannot collapse the two by accident and page somebody every time a member id is wrong.

The condition is detected **inside** the wait rather than after it. If detectors ran after the wait
the code would look correct and this run would still report `MEMBER_NOT_FOUND` - it would just cost a
full timeout every time, which under load is the difference between a service and a queue.

```
run id:   <<FILL AFTER RUN: notFound.runId>>
result:   <<FILL AFTER RUN: notFound.result>>
elapsed:  <<FILL AFTER RUN: notFound.elapsed>>
```

---

### `recovery/` - a known condition is cleared, once

**Proves** bounded recovery with a continuation policy. Member 10004 raises the scheduled-maintenance
notice, which the pinned condition profile describes as a recovery the automation may perform
unattended.

**Requirement** 3.3 determinism and error handling

**Read**

- `result.json` - `metrics.recoveriesUsed`
- `steps.json` - `recoveriesAttempted` and `attempts` on the interrupted step
- `events.jsonl` - the `recovery_applied` event, with the continuation it used

**`attempts` is 1.** The notice appears on the page the click NAVIGATED TO, so the click worked.
Repeating it would navigate a second time from a page whose link is no longer on it. The continuation
is `recheck_expected_effect`, not `retry_action`, and the difference is visible in this file.

```
run id:            <<FILL AFTER RUN: recovery.runId>>
result:            <<FILL AFTER RUN: recovery.result>>
recoveries used:   <<FILL AFTER RUN: recovery.recoveriesUsed>>
attempts on step:  <<FILL AFTER RUN: recovery.attempts>>
```

---

### `permissionDenied/` - a hard failure that carries a diagnosis

**Proves** that a failure reports EXPECTED beside OBSERVED. Member 10003 is restricted, and no
retry, no recovery and no amount of waiting will change that: the remediation is an entitlement
change.

**Requirement** 3.3 determinism and error handling - 3.6 safety

**Read**

- `result.json` - `error`, `expected`, `observed`
- `steps.json` - which step it stopped on and what it had already done

One half of a disagreement is not a diagnosis. `expected` is nullable rather than optional so a
producer has to say "nothing was expected here" out loud instead of omitting the field.

```
run id:    <<FILL AFTER RUN: permissionDenied.runId>>
error:     <<FILL AFTER RUN: permissionDenied.error>>
expected:  <<FILL AFTER RUN: permissionDenied.expected>>
observed:  <<FILL AFTER RUN: permissionDenied.observed>>
```

---

### `unavailable/` - the application goes down part way through

**Proves** that a mid-run outage is a recognised condition rather than a timeout, and that the steps
which completed are recorded rather than lost.

**Requirement** 3.3 determinism and error handling

**Read**

- `result.json` - `error: APPLICATION_UNAVAILABLE`
- `steps.json` - the steps that completed before it

Detected by **reading the page the application rendered**, not by the HTTP status. These systems
answer with a readable error page and a 200 at least as often as they answer with a 5xx, and a
transport check would miss the common case.

```
run id:            <<FILL AFTER RUN: unavailable.runId>>
error:             <<FILL AFTER RUN: unavailable.error>>
steps completed:   <<FILL AFTER RUN: unavailable.stepsCompleted>>
```

---

### `handoff/` - control passes to a person and comes back

**Proves** the same-session guarantee, and that only the system declares success. Member 20001 raises
a compliance modal the pinned condition profile deliberately does **not** describe. It is detected
structurally, by role, because an unrecognised blocking dialog cannot be recognised by its wording.

**Requirement** 3.5 escalation and handoff

**Read**

- `events.jsonl` - `handoff_session_identity` (phase `before` and `after`) and `handoff_same_session`
- `events.jsonl` - `lease_issued`: AUTOMATION, then HUMAN, then AUTOMATION again
- `events.jsonl` - `human_action`: what the person did, with **no** raw value anywhere
- `result.json` - `completionMode: human_assisted` on a success
- `screenshots/` - what the operator console showed, masked

**The browser context id and the page target id are recorded before control is ceded and again when
it comes back.** This is the only hard evidence in the bundle that the person operated the same live
session: a handoff that quietly opened a fresh browser would look identical in a screenshot, in a
log, and in a demo.

`human_action` events have **nowhere to put a typed value**. They record that a value changed and a
one-way correlation token, because a person at a real keyboard is out of band and the honest thing to
do about acts we cannot gate is to witness them.

An **abort** here is a legitimate outcome: `cancelled`, exit 25, a person decided to stop. It is not
a malfunction.

```
run id:            <<FILL AFTER RUN: handoff.runId>>
result:            <<FILL AFTER RUN: handoff.result>>
completion mode:   <<FILL AFTER RUN: handoff.completionMode>>
same session:      <<FILL AFTER RUN: handoff.sameSession>>
interventions:     <<FILL AFTER RUN: handoff.interventions>>
```

---

## What this bundle does NOT prove

Stated here rather than left for a reviewer to notice.

**Leak-clean is scoped.** `evidence:verify` checks that no value a run was INVOKED with, and no
declared-sensitive value the system had bound by the time it wrote a file, appears verbatim in a
published text file. It does not check that no sensitive value appears anywhere. A person's name
written into model prose while the model was reading a screen was not a value the system knew at the
moment the line was written, and no shape detector will ever catch a name. The verifier reports that
case as a `NOTE` with a count. The file is not scrubbed afterwards: evidence is not rewritten.

**Masking covers DECLARED regions only.** There is no OCR. A sensitive value rendered somewhere
nobody declared is still in the pixels. What is checked is that every published screenshot went
through the masking path, that regions were actually produced, and that nothing was silently
refused - a box that cannot be offset into page space is refused and recorded rather than drawn in
the wrong place.

**One capability, one tenant, one surface.** Everything here is `prepare_subaccount_review` against
the web fixture. The desktop adapter is a compiling stub and there is no second tenant.
`docs/TEST_MAP.md` says the same thing about the test suite.

**The seeds and the member ids come from the manifest**, not from the run files, and the verifier
marks those two checks `[manifest]`. See "How to read result.json" above for why.
