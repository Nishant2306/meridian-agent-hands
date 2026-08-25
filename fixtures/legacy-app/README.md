# MERIDIAN Core Servicing - the target app

A fictional vendor product standing in for legacy banking software with no API. It is an Express
app serving server-rendered HTML, and it is **deliberately hostile to automation**.

```bash
npm run dev:app-a
```

Serves on `http://localhost:4180`. The port lives in the tenant config (`tenants/tenant-a.ts`), not
in an environment variable, because PHASE 11 adds a second tenant on a second port. `FIXTURE_SEED`
fixes the per-boot
obfuscation seed so a boot can be reproduced exactly; omit it and every boot is different.

---

## What is hostile, and why

Every item here mirrors something real legacy banking software actually does. None of it should be
"cleaned up" - each one exists to break a specific automation shortcut.

| Hostility                                                                                        | What it breaks                                                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Content in an `iframe` named `contentFrame`, navigation in `navFrame`                            | Any perception layer that assumes one document. Frame path is part of screen context.                               |
| Layout tables nested several levels deep                                                         | Structural/XPath locators. There is no meaningful DOM hierarchy to anchor to.                                       |
| **No `data-testid` anywhere**                                                                    | The shortcut that makes demos work and production automation fail. Asserted absent by a test.                       |
| Form labels are the adjacent `<td>` **to the left**, not `<label for>`                           | Accessible-name lookup. These inputs have _no_ accessible name - this is the `T3_EXTERNAL_LABEL_OR_NEARBY` case.    |
| **Exception:** the member-search field has a proper `<label for>`                                | Nothing - that is the point. It resolves at `T1_EXACT_ROLE_NAME`, so two different tiers are exercised on the path. |
| Every results-table row has an action link reading `Open`                                        | Name-based locators. Picking the right one requires the row key: `T5_STRUCTURAL_ROW`.                               |
| CSS class names and element ids **regenerated from a seed on every boot**                        | Every CSS-selector recording, immediately.                                                                          |
| `name=` attributes are legacy-stable ASP-style (`ctl00$Main$txtMemberId`) and never change       | Nothing - this is the `T4_STABLE_ATTRIBUTE` advisory hint. Stable, but surface-specific.                            |
| Real semantic elements (`<button>`, `<select>`, `<table>`, `<th scope>`, `<h1>`, `role="alert"`) | Nothing. **This is the thesis**: the accessibility tree survives where the CSS does not.                            |

### Proving the instability claim

The obfuscation seed is logged on every boot and served from `GET /__test__/seed`:

```bash
curl http://localhost:4180/__test__/seed
```

Restart the app and the seed changes, and with it every class name and every element id - while
every role, accessible name, visible label and `name=` attribute stays exactly where it was.
PHASE 10 uses this as evidence rather than asking a reader to take the claim on faith.

`tests/fixture.smoke.test.ts` asserts it directly: two boots with different seeds produce
**disjoint** class-token and id sets and **identical** `name=` attribute sets.

---

## Screens

| Path                                 | Screen                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET /`                              | Sign on. Accepts **any non-empty** operator ID and passcode - no credential exists in this repository.  |
| `GET /app`                           | The shell: `navFrame` + `contentFrame`.                                                                 |
| `GET /nav`                           | Navigation frame contents.                                                                              |
| `GET /search`                        | Member search form.                                                                                     |
| `GET /search?q=…`                    | Results table, or `No member found for that ID.`                                                        |
| `GET /member/:id`                    | Member record: identity, accounts table, `New Sub-Account` link.                                        |
| `GET /member/:id/subaccount/new`     | The sub-account form.                                                                                   |
| `POST /member/:id/subaccount/new`    | Validates; on success redirects (303) to the review screen.                                             |
| `GET /member/:id/subaccount/review`  | `Review Sub-Account Request` - summary table, status `PENDING REVIEW`, and the `Submit Request` button. |
| `POST /member/:id/subaccount/submit` | **The irreversible one.** See below.                                                                    |
| `GET /__test__/seed`                 | The per-boot obfuscation seed.                                                                          |

Search is a **substring** match on id or name. `q=10001` returns one row; `q=1000` returns four,
all with an identically-named `Open` link - which is what makes `T5_STRUCTURAL_ROW` necessary
rather than theoretical.

### The button we must never press

`Submit Request` is wired to a route that **really does mutate state**. It is not a no-op, because a
guardrail that guards a no-op proves nothing - every safety claim in this project would be
unfalsifiable. What stands between the agent and that route is the bootstrap safety minimum
(PHASE 2) and the policy engine (PHASE 7), not the fixture being harmless.

### [MUST] The form starts neutral

The account-type select defaults to a placeholder (`Select an account type`); nickname and initial
deposit start **empty**. This is asserted by a dedicated test.

If the form pre-selected `Savings`, then selecting `Savings` would change nothing, the step would
have no discriminating effect, and the distiller would **correctly** reject it - while you spent an
hour debugging the agent instead of the fixture.

---

## Seed data

Every record is invented. Each carries an explicit `DUMMY DATA - NOT REAL` stamp, rendered on
screen. Balances are stored as **minor units** server-side and rendered as currency text.

| Member ID | Name         | Notes                                                               |
| --------- | ------------ | ------------------------------------------------------------------- |
| `10001`   | Avery Lin    | Normal. Two accounts.                                               |
| `10002`   | Jordan Reyes | Normal. One account.                                                |
| `10003`   | Casey Morgan | Flagged `restricted` - **data only**, no behaviour until PHASE 6.   |
| `10004`   | Riley Chen   | Flagged `knownNotice` - **data only**, no behaviour until PHASE 6.  |
| `99999`   | _(absent)_   | The `MEMBER_NOT_FOUND` case - a **business outcome**, not an error. |

Fault injection is **not** built. That is PHASE 6.

---

## The tenant seam

Every user-visible string, the sub-account field order, the branding, the minimum deposit and the
version marker come from a `TenantConfig` object (`tenants/tenant-a.ts`). A second deployment of
the same vendor product is a config file, not a code change.

`tenants/tenant-b.ts` is a documented **TODO for PHASE 11** and is deliberately not implemented:
writing it now would be guesswork about which differences actually matter, and building the
cross-tenant story before the first capability exists is building ahead.

The seam exists in PHASE 1 anyway, because retrofitting a tenant parameter into a fixture with
hard-coded strings everywhere is a rewrite, not a refactor.

---

## Note on the search field's `name`

The member-search input carries the legacy-stable ASP name `ctl00$Main$txtMemberId`, so submitting
the form produces `/search?ctl00%24Main%24txtMemberId=10001`. The server **also** accepts the short
`q` alias, so the documented deep link `/search?q=10001` keeps working. Both are tested.

---

## PHASE 6 FIXTURE CONTRACT - these strings are pinned by the condition profile

The condition profile `config/condition-profiles/meridian-subaccount/1.0.0.yaml` was finalized in
PHASE 3 and **is immutable**. Its SHA-256 is pinned into every artifact and forms part of the
artifact content hash, so editing it invalidates every hash that ever referenced it and makes
replay refuse to run with `PROFILE_INTEGRITY_FAILURE`.

Most of the screens its detectors match arrive in **PHASE 6**, with fault injection. So the
ordering is fixed and it only goes one way:

> **PHASE 6 must make the fixture match these strings verbatim. Not the reverse.**

If they drift, the temptation after GATE 1 will be to "just fix the profile", and that silently
invalidates every pinned hash and every artifact that referenced it.

### How matching works

Detectors are **phrases**, not regular expressions. A phrase matches when its words appear as a
contiguous run of whole words, case-insensitively, after whitespace normalization. So
`No member found` matches `No member found for that ID.` but not `No member was found`. The
implementation is `src/artifact/phrases.ts` and it is tested.

### The contract

| Condition                               | Detector                                                              | Fixture must render                                                                                                       | Status              |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `MEMBER_NOT_FOUND` (business outcome)   | text `No member found`                                                | `No member found for that ID.`                                                                                            | **Satisfied today** |
| `APPLICATION_VALIDATION_REJECTED`       | control with role `alert`                                             | the validation region already carries `role="alert"`                                                                      | **Satisfied today** |
| `DISMISS_MAINTENANCE_NOTICE` (recovery) | text `Scheduled maintenance`, plus a `button` named exactly `Dismiss` | a notice containing the words `Scheduled maintenance`, dismissable by a button whose accessible name is exactly `Dismiss` | PHASE 6             |
| `PERMISSION_DENIED`                     | text `You do not have permission`                                     | e.g. `You do not have permission to view this member.`                                                                    | PHASE 6             |
| `SESSION_EXPIRED`                       | text `Your session has expired`                                       | e.g. `Your session has expired. Please sign on again.`                                                                    | PHASE 6             |
| `APPLICATION_UNAVAILABLE`               | text `The application is temporarily unavailable`                     | that sentence, on a 5xx or error page                                                                                     | PHASE 6             |

Note that the detector for `APPLICATION_VALIDATION_REJECTED` is **structural**, not textual: it
looks for an alert region rather than for the wording of any particular validation message. The
messages belong to the application and it may reword them; the alert region is the contract.

The two rows marked "Satisfied today" are covered by tests in `tests/artifact.profiles.test.ts`,
run against real captures in `tests/fixtures/observations/`. They exist so that at least part of
this contract is proven honoured _before_ the hashes were pinned into anything.
