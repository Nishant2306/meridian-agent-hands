# DATA HANDLING

What this system stores, what it pseudonymizes, what it masks, what it never captures, and - the
section that matters most - what it does **not** protect.

Nothing in this repository has ever touched real personal data. The fixture's members are invented
and every screen stamps `DUMMY DATA - NOT REAL`. This document describes what the mechanisms would
do against real data, which is the only useful thing to say about them.

---

## The three mechanisms are different, and conflating them is the mistake

They look similar and they are not. Each protects a different thing from a different reader, and
applying one where another belongs breaks something.

|                                     | Where                                         | What it does                            | Why not the others                                               |
| ----------------------------------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| **1. Persistence pseudonymization** | logs, transcripts, evidence, human CLI output | replaces values in place before writing | these files outlive the run and get copied                       |
| **2. Artifact scanning**            | `src/artifact/parameterize.ts`                | **scans and REJECTS**; never rewrites   | rewriting corrupts the capability and hides a distiller bug      |
| **3. Caller results**               | `replay --json` on stdout                     | **nothing**                             | a capability that will not tell its caller the answer is useless |

### 1. Persistence pseudonymization

`src/redaction/pseudonymize.ts`, applied at one seam: `redactForPersistence` in the evidence writer,
which every event passes through, plus the model transcript and the human-readable CLI output.

**The default is a per-run random map held in memory.** `10001` becomes `[memberId:subject-01]`, the
mapping is never written to disk, and it dies with the process.

The obvious alternative - a truncated hash of the value - is indefensible here and worth explaining,
because it is what most implementations do. There are 100,000 five-digit member ids. A laptop
enumerates every hash of every one of them in well under a second. A short digest of a low-entropy
value is not pseudonymization; it is an index into the plaintext, and it _looks_ careful, which
makes it worse than leaving the value alone, where at least nobody is misled.

`PSEUDONYM_SECRET` in the environment switches to HMAC-SHA-256 truncated to **8 bytes minimum**
(refused below that, not warned about). That buys labels that are stable across runs, for a
deployment that needs to correlate. It is a trade rather than an upgrade: with the secret,
correlation becomes possible for anyone holding it. Without it, the same label means different
people in different runs - the honest consequence of having no key.

**What is detected:** declared `pii` / `secret` inputs and outputs by value; emails; SSN-shaped
strings; phone-shaped strings; card numbers **after a Luhn check**; and any object key matching
`password|passcode|token|secret|ssn|apikey|authorization`, whose value is replaced wholesale rather
than labelled - a credential is not a subject to be tracked consistently.

The Luhn check is not fussiness. Without it every account number, reference and timestamp of the
right length gets replaced, the logs become unreadable, and the next person turns redaction off.

### 2. Artifacts are scanned, never rewritten

A capability artifact that contains a runtime invocation value is **rejected** at distillation. It
is never auto-redacted and saved.

Rewriting would corrupt input examples, typed literals, descriptors, expected values, URL templates
and numeric types - and, worse, it would hide the fact that the **distiller has a bug**. A scrubbed
artifact also _looks_ reviewed, which is the property that makes it dangerous.

This is what caught the GATE 1 leak, after the sweep was extended to model-authored prose. See
DECISIONS.md D39.

### 3. Caller results are not redacted

The brief requires replay to **return** what it read.

```
replay --json   stdout   real typed outputs        the machine channel
                stderr   pseudonymized             the human channel
                /runs    pseudonymized + masked    the persisted channel
```

An agent that asked for the review status and got `[reviewStatus:subject-01]` has been given
nothing. Redacting the return channel would make the capability useless to its caller, so the three
channels differ on purpose and a test asserts both halves at once.

---

## Screenshots

Only the **masked** image is written. The unmasked bytes exist in memory for one function call and
never get a filename, because a file that exists is a file that gets copied.

Regions are taken from `PerceivedControl.box` for controls displaying declared-sensitive values and
the record identity, painted as flat opaque rectangles, and recorded in a manifest beside the image:

```json
{ "sourceScreenshot": "0001.png",
  "maskedRegions": [{ "descriptorRef": "cell \"...\" (mark 8)", "reason": "record-identity", "rect": {...} }],
  "refused": [],
  "observationId": "obs-..." }
```

**Flat rectangles, not blur or pixelation.** Both of those are reversible to a useful degree - a
blurred six-digit number is often recoverable, a pixelated one sometimes by eye - and both look like
redaction to a reviewer, which is exactly what makes them dangerous.

**A box in the wrong coordinate space is worse than no box.** Boxes come from
`getBoundingClientRect()` inside the frame that owns the control, and this application renders
everything inside `contentFrame`. An unoffset box lands away from its control: the screenshot looks
redacted while the value sits legible beside a black rectangle. Extraction therefore offsets boxes
into page space; anything it could not offset - a cross-origin frame - is **refused and recorded in
the manifest** rather than drawn.

---

## What never enters the pipeline at all

Secret **values** are not redacted, because they are never present to redact. A credential travels
as a `secretRef` - a NAME - resolved inside the input path at the moment of typing. The model never
sees one, no event carries one, and `describeBinding` writes `secret:operatorId` rather than a
value.

That is a stronger property than redaction and it is the one to prefer wherever it is achievable.

---

## LIMITS - what this does NOT protect

This section is the point of the document. Every item is a real gap, not a hypothetical.

**Regex PII detection has false negatives.** A person's name has no shape. An address, an account
nickname, a free-text note and a date of birth in an unusual format all sail through. The DECLARED
sensitivity on the spec is the primary mechanism and the shape detectors are a net under it - if a
human did not declare a field sensitive, only luck protects it.

**Screenshots may capture data outside declared sensitive regions, and we do not OCR.** We mask
declared regions. We do **not** claim the value is absent from the pixels. The same member id
rendered in a summary line, a tooltip, a page title, a neighbouring row or a browser tab is still
there. "These declared regions are covered" and "the screenshot is redacted" are very different
promises and only the first is true.

**An allowlist does not prevent an in-app action that is itself harmful.** Policy constrains which
origin, which route, which control and which risk class. A control that is permitted and does
something damaging is permitted. The guardrail is about reachability, not about consequences.

**A human operator with control can do anything policy permits humans to do.** During a handoff the
lease transfers and the automation stops issuing actions. The person is at a real browser signed
into a real application, and nothing in this system constrains them. In the headed-browser
transport, direct OS-level input is out of band entirely.

**Model-boundary minimization covers values we TYPED, not everything the model READS.** Typed values
are rendered to the model as `[PARAM:name]`. Values the model reads off the screen - a member's
name, a balance - are sent as they appear, because substituting them would corrupt the observation
the model is reasoning about. A pseudonymizer for read-only sensitive nodes is designed and
deliberately not built; see `src/agent/boundary.ts`.

**Pseudonymization is not anonymization.** A per-run map protects against the log reader, not
against someone who also has the run's inputs. With `PSEUDONYM_SECRET` set, anyone holding the
secret can correlate across every run.

**Retention is not implemented.** `/runs` grows without bound and nothing expires it. The seam is
the evidence root: a deployment points it at a location with its own lifecycle policy. That is a
seam, not a feature, and calling it one would be overclaiming.

**The operator console's protections are local.** Loopback binding, a per-run token, an HttpOnly
SameSite=Strict intervention-scoped cookie, CSRF checks and no enumeration endpoint. There is no
enterprise identity, no RBAC, no per-operator accounts and no remote operator access.
