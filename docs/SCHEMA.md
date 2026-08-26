# The capability artifact

A capability artifact is the whole point of this system. Discovery produces one; replay executes
one; approval signs one. If you read nothing else in this repository, read this.

It is assembled from **three sources**, and removing any one leaves something that is not a
capability:

```
declared contract   +   observed successful path   +   pinned condition profile
```

Without the contract it is a macro. Without the observed path it is a wish. Without the pinned
profile it is unverifiable.

The full example lives in
[`examples/artifacts/prepare_subaccount_review@1.0.0.example.json`](../examples/artifacts/prepare_subaccount_review@1.0.0.example.json).
It is hand-authored for documentation and says so in its own provenance block: **no model was
called to produce it.** Everything below annotates that file.

---

## Three versions, three different questions

Collapsing any pair of these produces a version number that cannot answer either question.

| Field                               | Question it answers                                     | Who moves it                                                    |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| `schemaVersion`                     | What shape is this FILE?                                | Us. Bumping it means every reader must be taught the new shape. |
| `capabilityVersion`                 | Which revision of THIS CAPABILITY is this?              | Whoever distils it.                                             |
| `target.compatibility.versionRange` | Which versions of THE APPLICATION does it work against? | The vendor, on their own release schedule.                      |

The common mistake is folding compatibility into `capabilityVersion`, which then forces a
capability bump every time MERIDIAN patches something that never affected us.

`capabilityVersion` moves **MINOR** when the path or the locators changed, and **MAJOR** when the
input or output contract changed. That is not cosmetic: it is the difference between "redeploy at
your convenience" and "every caller of this capability needs looking at".

---

## The top level

```jsonc
{
  // What shape this file is. Owned by us. Version 2 added the step-level `when` guard below.
  "schemaVersion": 2,

  // Stable identity. The store is /artifacts/<capabilityId>/<capabilityVersion>.json
  "capabilityId": "prepare_subaccount_review",
  "name": "Prepare sub-account review",
  "description": "Open a member record ... and advance to the review screen. The request is NEVER submitted.",
  "capabilityVersion": "1.0.0",

  // THE ONLY THREE FIELDS EXCLUDED FROM THE CONTENT HASH.
  // Approval changes these and nothing else, which is what makes the content hash of the
  // distilled draft and of the approved artifact byte-identical.
  "status": "draft",
  // "approvedAt": "...",   present only once approved
  // "approvedBy": "...",   present only once approved
```

### `target`

```jsonc
  "target": {
    "product": "MERIDIAN Core Servicing",

    // Which adapter can execute this. The capability CONTRACT is surface-independent; the locator
    // hints inside it are not. A web-recorded artifact does not replay unchanged on a desktop app.
    "surfaceKind": "legacy_web",

    "entryPoint": "http://localhost:4180/",
    "compatibility": { "versionRange": ">=3.2.0 <4.0.0" },

    // Checked against the live screen before the first step.
    // DELIBERATELY TRUNCATED: "v3.2", not "v3.2.1". A patch release of the vendor product should
    // not fail a capability that never touched anything the patch changed.
    "fingerprint": [{ "kind": "text", "expected": "MERIDIAN Core v3.2" }]
  },
```

### `inputs` and `outputs`

`inputs` is copied verbatim from the DiscoverySpec. The contract has one author, and it is not the
model.

```jsonc
  "inputs": [
    {
      "name": "memberId",
      "type": "string",
      "pattern": "^[0-9]{5}$",   // also drives TYPED comparison, see value_matches_param below
      "required": true,
      "sensitivity": "pii",      // drives redaction of logs, evidence and CLI output
      "description": "Five-digit member identifier used to locate the member record.",
      "example": "00000"         // obviously synthetic, and never a member used in an evidence run
    }
    // accountType (enum), nickname (OPTIONAL), initialDeposit (currency) omitted here for length
  ],
```

**Outputs are the clearest example of the declared/discovered split.** The human declared _what_;
discovery recorded _where_.

```jsonc
  "outputs": [
    {
      // ---- declared by a human, in the spec ----
      "name": "memberName",
      "type": "string",
      "sensitivity": "pii",
      "required": true,
      "when": "success",
      "description": "The member identity displayed on the prepared request.",

      // ---- recorded by discovery ----
      "source": {
        // The output belongs to a STATE, not to a step position. That is what keeps extraction
        // valid when automation reached the state, when a HUMAN reached it during a handoff, or
        // when a recovery made the step sequence differ from the recorded one. An output pinned to
        // "whatever step 8 touched" is wrong in all three cases.
        "stateId": "review",
        "target": { /* a TargetDescriptor, see below */ },
        "parse": "text"
      }
    }
  ],
```

### `recordIdentity`

```jsonc
  // Declared in the spec (WHICH parameter means identity); BOUND here (WHERE it is displayed).
  // This is what lets an assertion say "we are on the right member's page" rather than the much
  // weaker "we are on a member page".
  "recordIdentity": {
    "param": "memberId",
    "target": { /* the cell whose nearby text is "Member ID" */ }
  },
```

---

## A `TargetDescriptor`, and why there is nowhere to put a CSS selector

Every locator in the artifact has this shape. It is split into three parts on purpose.

```jsonc
{
  // Surface-INDEPENDENT. The portable contract. Every field here is expressible on a web page and
  // on a desktop window, and this half is the only half the capability's meaning depends on.
  "semantic": {
    "role": "combobox",
    "nameMatch": "normalized",

    // This control has NO accessible name at all: on this application the label is the table cell
    // to its LEFT, not a <label for>. nearbyText is the only thing that identifies it.
    "nearbyText": ["Account Type"],
  },

  // Surface-SPECIFIC. ADVISORY ONLY. A descriptor whose semantic half no longer resolves is a
  // broken descriptor even if these still match. This is the honesty commitment in type form.
  "adapterHints": {
    "web": {
      "contextPath": ["contentFrame"], // frame path, not a selector
      "stableAttribute": { "name": "ctl00$Main$ddlAccountType" }, // legacy ASP name, survives reboots
    },
  },

  // Which tier actually resolved this during discovery. PROVENANCE, not instruction. If replay
  // resolves at a WEAKER tier than this, that is a drift signal: the action still proceeds and the
  // downgrade is counted and logged, well before the capability breaks outright.
  "recordedTier": "T3_EXTERNAL_LABEL_OR_NEARBY",
}
```

The results screen has four links all named `Open`. Only the row key separates them:

```jsonc
{
  "semantic": {
    "role": "link",
    "name": "Open",
    "nameMatch": "exact",
    // Parameterized: bound to the invocation's memberId before resolution. A rowKey that reaches
    // the resolver still saying {"kind":"param"} is a caller bug, and the resolver says so rather
    // than guessing.
    "rowKey": { "cellText": { "kind": "param", "name": "memberId" } },
  },
  "recordedTier": "T5_STRUCTURAL_ROW",
}
```

---

## States

A state is **a place the run can be**, described by assertions rather than by a step index. That
matters because a run may arrive at a state by a path nobody recorded: automation did it, a person
did it during a handoff, or a recovery re-entered it from the side.

```jsonc
  "states": [
    {
      "id": "subaccount-form",
      "description": "The sub-account form is open.",

      // WHICH SCREEN this is. Identity.
      "screenAssertions": [
        { "id": "subaccount-form.screen", "kind": "screen_identity",
          "expected": { "kind": "literal", "value": "New Sub-Account" },
          "description": "the screen is \"New Sub-Account\"" }
      ],

      // WHAT IS TRUE ON IT beyond identity. Empty here: this state is only "the form is open".
      "qualifiers": [],

      // Must hold whenever we are in this state, and BOTH BEFORE AND AFTER every step taken from
      // it. An invariant is not a transition.
      "invariants": [
        { "id": "subaccount-form.identity", "kind": "text_present",
          "expected": { "kind": "param", "name": "memberId" },
          "description": "the member id appears in the screen text" }
      ],

      // NOT resume-eligible: a step precondition only.
      "resumeEligible": false
    },
    {
      "id": "subaccount-form-complete",
      // Same screen, plus qualifiers. This state is a strict SUPERSET of subaccount-form.
      "screenAssertions": [ /* screen_identity: New Sub-Account */ ],
      "qualifiers": [
        { "id": "...account-type", "kind": "value_matches_param",
          "target": { /* the combobox */ },
          "expected": { "kind": "param", "name": "accountType" },
          "description": "the account type field holds the requested account type" },

        { "id": "...nickname", "kind": "value_matches_param",
          "target": { /* the nickname box */ },
          "expected": { "kind": "param", "name": "nickname" },
          // CONDITIONAL. nickname is optional, so without this guard every legitimate invocation
          // that omits it would fail an assertion about it and report INVARIANT_VIOLATED.
          "when": { "paramPresent": "nickname" },
          "description": "the nickname field holds the requested nickname" },

        { "id": "...deposit", "kind": "value_matches_param",
          "target": { /* the deposit box */ },
          "expected": { "kind": "param", "name": "initialDeposit" },
          "description": "compared as CURRENCY rather than as text, so formatting need not match" }
      ],
      "invariants": [ /* the member id is still on screen */ ],
      "resumeEligible": true
    }
  ],
```

### Only resume-eligible states must be mutually exclusive

`subaccount-form` matches every observation that `subaccount-form-complete` matches. That overlap
is **harmless**, because nothing ever has to _choose_ between them: `subaccount-form` exists only
as a step precondition. Resumption is the single moment where an ambiguous answer would be acted on.

The consequence is the correct one, and it is cheap: **a half-filled form matches no resumable
state**, so the run goes back to a human instead of guessing which half of the work was already
done. There is a test for exactly this, run against the observation a real walk produced.

Mutual exclusivity cannot be proven statically, because two assertion sets are not comparable as
text. It is checked by the distiller against **the observations the discovery run actually
produced**.

### Assertion kinds

| Kind                      | Means                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `screen_identity`         | the canonical screen name is the expected one                                                                         |
| `screen_identity_changed` | the screen is no longer the one we acted on                                                                           |
| `text_present`            | the expected text appears in the PERCEIVED screen text                                                                |
| `control_visible`         | the target resolves                                                                                                   |
| `value_equals`            | the target's value equals a fixed expected value                                                                      |
| `value_matches_param`     | the target's value equals the invocation's value for a named parameter, **compared in the declared type's own space** |

That last row is load-bearing. On one run the caller passes `"250.00"`, the input field holds
`"250"`, and the review screen renders `"$250.00"`. String equality fails on the first real run.

---

## Steps

```jsonc
  "steps": [
    {
      "id": "step-5-choose-account-type",
      // Why this step exists, in a sentence a reviewer can check against the action.
      "intent": "Choose the requested account type.",

      "action": {
        "type": "select",
        "target": { /* the combobox, resolved by the cell to its left */ },
        // The EXECUTOR resolves params and secrets. The model never handles a secret: a binding
        // travels as a NAME through the proposal, the transcript and this artifact.
        "value": { "kind": "param", "name": "accountType" }
      },

      "fromState": "subaccount-form",

      // Proof that THIS ACTION changed the relevant state. For a mutating step at least one of
      // these must be DISCRIMINATING: false before the action, true after.
      "expectedEffects": [
        { "id": "step-5.type-selected", "kind": "value_matches_param",
          "target": { /* the combobox */ },
          "expected": { "kind": "param", "name": "accountType" },
          "description": "the account type field now holds the requested type" }
      ],

      // Must hold BEFORE AND AFTER. Not a transition.
      "invariants": [ /* the member id is still on screen */ ],

      // Predicate polling. Never a fixed sleep.
      "wait": { "timeoutMs": 10000, "pollMs": 100 },

      "risk": "SAFE_REVERSIBLE",

      // fail | escalate | try_recoveries_then_fail
      "onFailure": "fail",

      // Every wait is declared explicitly. A step may not allow more retries than it has backoffs.
      "retries": { "max": 1, "backoffMs": [250] },

      // `intent` is the MODEL's account of why this control is right. `notes` is the SYSTEM's
      // account of how it was identified and at which tier. Omitted when it would only restate
      // the intent - a field that always echoes its neighbour is noise in the first document a
      // reviewer reads.
      "notes": "Identified by nearby label \"Account Type\", recorded at T3_EXTERNAL_LABEL_OR_NEARBY."

      // [MUST] A step bound to an OPTIONAL parameter also carries a guard:
      //   "when": { "paramPresent": "nickname" }
      // Replay SKIPS such a step when the parameter was not supplied, and RECORDS the skip. The
      // guard lives in the artifact rather than inside the replay engine, so a reader can see the
      // step is conditional without knowing how replay works.
    }
  ],
```

### Why a discriminating effect, and what it does not prove

A false-to-true flip is **evidence, not proof of causality**: something else on the page could have
caused it. We require one anyway, because its **absence is conclusive** in the direction that
matters. If nothing changed, the action did nothing, and _"the click was swallowed by a modal"_ is
the single most common way legacy UI automation quietly does nothing and reports success.

The mirror-image rule: an invariant that has to flip from false to true is an effect wearing the
wrong label. Invariants are checked before _and_ after every step, so one that must flip would fail
on every run and then be deleted by whoever is debugging it at the time.

A `read` step needs no transition at all. What it needs is that the source exists and the value
parses.

### The last step, and the button that is never pressed

`step-8-continue-to-review` is classified `RISKY_REVERSIBLE`, not `SAFE_REVERSIBLE`: it leaves a
pending draft behind that somebody has to look at. A person can discard it, so it is reversible, but
it is not nothing.

`policy.maxRiskAllowed` is `RISKY_REVERSIBLE`. That is what makes _"this capability can never take
an irreversible action"_ a **checkable statement** rather than a promise, and it is verified at
approval: a step above the ceiling refuses to be approved.

---

## Profiles, policy and provenance

```jsonc
  "successState": "review",

  // The pins. SEMANTIC CONTENT, not approval metadata, so they are INCLUDED in the content hash.
  // A hash that skipped them would let a capability be re-pointed at a different safety profile
  // without moving its identity, which is exactly the substitution the pin exists to prevent.
  "profiles": {
    "condition": { "id": "meridian-subaccount", "version": "1.0.0", "sha256": "b8a8621c..." },
    "safety":    { "id": "banking-default",     "version": "1.0.0", "sha256": "ca1eb323..." }
  },

  // The CAPABILITY layer of the policy. May be stricter than global. Never weaker: approval
  // refuses an artifact that tries, and at run time the effective policy is the strictest of every
  // layer, so a LATER global tightening binds capabilities approved under a looser one.
  "policy": { "maxRiskAllowed": "RISKY_REVERSIBLE", "maxSteps": 40, "maxDurationMs": 120000 },

  // CAPABILITY-SPECIFIC ADDITIONS ONLY.
  //   effective detectors = GLOBAL ENGINE + PINNED CONDITION PROFILE + these
  // Empty is the normal case and means "the profile already covers it". Repeating a profile
  // detector here would create a second place to keep in step with the first.
  "knownOutcomes": [],
  "recoveries": [],
  "hardFailures": [],

  "provenance": {
    "discoveryRunId": "...",   // WHICH RUN produced it
    "model": "...",
    "promptVersion": "...",
    "goalTemplate": "...{{memberId}}...",  // parameter NAMES only. Never a rendered goal.
    "specHash": "f0086a2d...",             // WHICH DECLARED CONTRACT it was built against
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

### There is no `goalDigest`

A SHA-256 of a rendered goal is brute-forceable: a hundred thousand five-digit member ids against a
known template is seconds of work. A "digest" of `"...member 10001..."` is a member id in a costume.

Traceability is already complete without one: `discoveryRunId` says which run, `specHash` says which
declared contract, the content hash says what the artifact says, and `model` plus `promptVersion`
say what produced it.

### The hashing lifecycle

| Stage            | What happens                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| **PHASE 3**      | The profile YAML is written. It never changes again.                                                                 |
| **Distillation** | Load the profiles, compute their SHA-256, write the pins into the DRAFT, and only **then** compute the content hash. |
| **Approval**     | RECOMPUTE and VERIFY the pins. Verify the artifact. Change only `status`, `approvedAt`, `approvedBy`.                |
| **Replay**       | Verify the pins again. Mismatch is `PROFILE_INTEGRITY_FAILURE`.                                                      |

The consequence, and the property the PHASE 10 provenance chain is built on: **the content hash of
the distilled draft and of the approved artifact are identical.** Approval is a signature on
something that did not change, not a transformation of it. `npm run capability:approve` prints both
hashes so you can see it rather than take it on faith.

---

## Deliberately not in v1

Not oversights. Adding any of them requires a `schemaVersion` bump.

- tenant overrides
- locator stability scores
- automatic demotion of a drifting capability
- an evidence policy
- any approval workflow beyond a single status flip

---

## A complete, minimal artifact

Everything above is excerpted. This one is whole, and a test parses it, validates it against the
schema, runs the structural rules over it, and verifies its profile pins against the real profile
files on disk. If this block and the code ever disagree, the test fails.

<!-- COMPLETE-ARTIFACT -->

```jsonc
{
  // ---- identity ------------------------------------------------------------------------------
  "schemaVersion": 2,
  "capabilityId": "example_minimal",
  "name": "Read the review status",
  "description": "The smallest artifact that is still a capability: one state, one step, one output.",
  "capabilityVersion": "1.0.0",
  // Excluded from the content hash, along with approvedAt and approvedBy.
  "status": "draft",

  // ---- which application, and which versions of it ---------------------------------------------
  "target": {
    "product": "MERIDIAN Core Servicing",
    "surfaceKind": "legacy_web",
    "entryPoint": "http://localhost:4180/",
    "compatibility": { "versionRange": ">=3.2.0 <4.0.0" },
    // Truncated on purpose: a patch release should not fail a capability it never touched.
    "fingerprint": [{ "kind": "text", "expected": "MERIDIAN Core v3.2" }],
  },

  // ---- the declared contract -------------------------------------------------------------------
  "inputs": [
    {
      "name": "memberId",
      "type": "string",
      "pattern": "^[0-9]{5}$",
      "required": true,
      "sensitivity": "pii",
      "description": "Five-digit member identifier.",
      "example": "00000",
    },
  ],

  // WHAT is declared by a human; WHERE is recorded by discovery, and it belongs to a STATE.
  "outputs": [
    {
      "name": "reviewStatus",
      "type": "enum",
      "values": ["PENDING REVIEW"],
      "sensitivity": "public",
      "required": true,
      "when": "success",
      "description": "The status the application reports for the prepared request.",
      "source": {
        "stateId": "review",
        "target": {
          "semantic": { "role": "cell", "nameMatch": "normalized", "nearbyText": ["Status"] },
          "recordedTier": "T3_EXTERNAL_LABEL_OR_NEARBY",
        },
        "parse": "text",
      },
    },
  ],

  // Declared in the spec, bound here.
  "recordIdentity": {
    "param": "memberId",
    "target": {
      "semantic": { "role": "cell", "nameMatch": "normalized", "nearbyText": ["Member ID"] },
      "recordedTier": "T3_EXTERNAL_LABEL_OR_NEARBY",
    },
  },

  // ---- what must already be true before the first step -----------------------------------------
  "preconditions": [
    {
      "description": "The prepared request is already on screen.",
      "check": {
        "id": "precondition.on-review",
        "kind": "screen_identity",
        "expected": { "kind": "literal", "value": "Review Sub-Account Request" },
        "description": "the review screen is showing",
      },
    },
  ],

  // ---- where the run can be --------------------------------------------------------------------
  "states": [
    {
      "id": "review",
      "description": "The prepared request is on the review screen, unsubmitted.",
      "screenAssertions": [
        {
          "id": "review.screen",
          "kind": "screen_identity",
          "expected": { "kind": "literal", "value": "Review Sub-Account Request" },
          "description": "the screen is the review screen",
        },
      ],
      "qualifiers": [],
      "invariants": [
        {
          "id": "review.identity",
          "kind": "value_matches_param",
          "target": {
            "semantic": { "role": "cell", "nameMatch": "normalized", "nearbyText": ["Member ID"] },
            "recordedTier": "T3_EXTERNAL_LABEL_OR_NEARBY",
          },
          "expected": { "kind": "param", "name": "memberId" },
          "description": "the member shown is the member we were asked about",
        },
      ],
      // The success state must be resume-eligible: you have to be able to RECOGNISE that you are
      // finished, including after a human held control for a while.
      "resumeEligible": true,
    },
  ],

  // ---- the observed path -----------------------------------------------------------------------
  "steps": [
    {
      "id": "step-1-refresh-review",
      "intent": "Re-open the review screen so the status is read from a fresh render.",
      "action": {
        "type": "navigate",
        "pathSegments": [
          { "kind": "literal", "value": "member" },
          { "kind": "param", "name": "memberId" },
          { "kind": "literal", "value": "subaccount" },
          { "kind": "literal", "value": "review" },
        ],
      },
      "toState": "review",
      // Discriminating: false before the navigation, true after it.
      "expectedEffects": [
        {
          "id": "step-1.on-review",
          "kind": "text_present",
          "expected": { "kind": "literal", "value": "Review Sub-Account Request" },
          "description": "the review heading is present",
        },
      ],
      "invariants": [],
      "wait": { "timeoutMs": 10000, "pollMs": 100 },
      "risk": "SAFE_REVERSIBLE",
      "onFailure": "fail",
      "retries": { "max": 1, "backoffMs": [250] },
    },
  ],
  "successState": "review",

  // ---- the pins. Semantic content, included in the content hash. ------------------------------
  "profiles": {
    "condition": {
      "id": "meridian-subaccount",
      "version": "1.0.0",
      "sha256": "b8a8621cd45123a269bca0923cd08a75c5c952766318bd2a5c3aed066aba3168",
    },
    "safety": {
      "id": "banking-default",
      "version": "1.0.0",
      "sha256": "ca1eb3230a6aa74c10c160e46acfb1cdff6656e95a87f846bf36dcf7df6291e9",
    },
  },

  // Stricter than the global ceiling on every axis. Never weaker.
  "policy": { "maxRiskAllowed": "SAFE_REVERSIBLE", "maxSteps": 10, "maxDurationMs": 60000 },

  // Capability-specific ADDITIONS only. Empty means "the pinned profile already covers it".
  "knownOutcomes": [],
  "recoveries": [],
  "hardFailures": [],

  // goalTemplate only. No rendered goal, and no goalDigest.
  "provenance": {
    "discoveryRunId": "HAND-AUTHORED-EXAMPLE-NO-DISCOVERY-RUN-PRODUCED-THIS",
    "model": "HAND-AUTHORED-EXAMPLE-NO-MODEL-WAS-CALLED",
    "promptVersion": "HAND-AUTHORED-EXAMPLE",
    "goalTemplate": "Read the review status for member {{memberId}}.",
    "specHash": "f0086a2dfe4cb892b257298ea5650859e5c336d66e5486a53ddb56ba4fe47ab0",
    "createdAt": "2026-01-01T00:00:00.000Z",
  },
}
```
