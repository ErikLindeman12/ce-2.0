# CE 2.0 — Platform Model

> The conceptual model **behind** the PoC and the road **past** it. Where
> [architecture.md](architecture.md) is the durable "what + invariants" and
> [feature-map.md](feature-map.md) maps issues to flows, this doc is the design
> rationale for channels, events, fax, and patient-mediated referral — so we
> don't design the PoC into a corner the bigger vision can't grow out of.
>
> **architecture.md remains the source of truth for invariants.** Nothing here
> overrides it. PoC scope is deliberately small; most of this doc is labelled
> *Year 2 / Year 3+* and is explicitly walled off from the demo.

---

## 1. Ingress vs egress are different problems

The Stripe analogy only makes sense if you split a referral by direction. Ingress
(getting it *into* the network) and egress (getting it *out* to the receiver) have
opposite difficulty profiles.

**Egress — CE 2.0 → receiver — is where the value concentrates.** The sender hits
the API/portal *once*; CE 2.0 looks up the receiver's directory entry and delivers
in whatever that receiver speaks (API POST, Direct, fax, Epic in-basket, secure
email, SMS). The sender's effort is constant regardless of how primitive the
receiver is. Egress to fax is **easy** — you hold structured data and render it out.

**Ingress — sender → CE 2.0 — is tiered by how integrated the sender is:**

| Sender capability | On-ramp |
|---|---|
| EHR / dev team | **API** (or MCP) — the integration path |
| No integration, has a browser | **Portal** — the no-code on-ramp (≈ Stripe Payment Links) |
| Fax / Direct only | **Parse-adapter** — CE 2.0 receives, extracts fields, calls the *same* `POST /referrals`. *Hard. Year 2.* |

Everything downstream of a *structured* referral is easy — receivers, close-loop, and
tracking are all "chilling" once a clean referral exists. **The only genuinely hard
problem in the whole platform is a sender who can't hit the API or portal** (fax-only):
turning their referral into a structured one. Low-tech *receivers* are not hard —
egress just renders the referral out as a fax/Direct. See §4 for the sender-side
fax adapter.

---

## 2. Same-system vs cross-system (and why internal referrals mostly don't belong here)

The real value axis is **not** internal/external — it's the **trust/format boundary
crossed**. Value is proportional to the boundary.

- **Same-system** (Epic→Epic, one instance): the EMR already does this natively and
  better. Routing it through CE 2.0 adds latency and risk for zero value, and there
  is **no need to track its status centrally** — the EMR closes that loop itself.
  Do **not** round-trip these. Do **not** pitch displacing native intra-Epic flow.
- **Cross-system** (Epic↔Cerner, org↔org, or a multi-EMR IDN — even "internal" to
  one health system on the org chart): *this* is what CE 2.0 is for. Central
  tracking and translation earn their keep precisely because a boundary is crossed.

Conceptually a referral is one object whether internal or external; practically,
only the cross-boundary ones flow through here.

---

## 3. One delivery primitive

Referral dispatch, status events, and ad-hoc messaging are **the same underlying
operation**: *deliver this payload to this addressable party via the right channel.*
They differ only in trigger and payload. Build everything on that core.

- **Channel is resolved from declared metadata** — the recipient's preferences plus
  content-sensitivity flags the sender sets (`sensitivity: high` → "must go Direct,
  not email"). The decision is driven by **declared metadata, never by interpreting
  the clinical content.** Routing on flags = a routing engine. Routing on parsed
  content = an NLP/compliance product (out of scope — see §7).
- **Send-to-group** = fan-out + per-recipient channel resolution: one logical send →
  resolve to N recipients → each receives it in *their own* preferred channel.

> Example: an org sends an "in-basket message to Dr. Smith" and CE 2.0 delivers via
> in-basket, Direct, or secure email depending on Dr. Smith's declared prefs + the
> message's sensitivity — without the sender knowing or caring which.

---

## 4. Fax: a parse-adapter in front of the one API — never a mixed queue

Most referrals are faxed today, so fax must fit. But receivers **already run a fax
work queue, staffed by different people** than the referral team. Dumping raw faxes
into the structured referral queue just **recreates the fax pile** and destroys the
operational separation that makes the structured queue worth having.

> **Invariant: the structured referral queue contains only structured referrals.**
> Raw, unparsed faxes never land in it.

So there is no "aggregate fax alongside structured items" shortcut, and no parallel
path for fax. There is only structure.

### Fax goes through the same API, via an adapter

A fax becomes a referral **only** by being parsed into a structured referral and
submitted through the same `POST /referrals` the API and portal use:

```
fax  →  [parse + extract fields]  →  POST /referrals  →  structured queue
```

Once parsed, a fax-originated referral is **indistinguishable** from an API one —
right work queue, status tracking, and close-loop (correlated to a registered sender
via fax number / cover-sheet code / NPI). One API, many front doors. This is the
answer to "is it going through our one API?": **yes — through the adapter.** It also
resolves the "register to check status" worry: once the adapter submits with the
sender's correlated identity attached, close-loop works like everything else.

### The entire hard problem is the parse step

This is the **only genuinely hard part of the platform**: messy, handwritten,
multi-format, missing-field faxes, and AI extraction that won't reliably get every
field. A half-parsed referral injected into the structured queue is *worse* than no
referral — it poisons trust in the queue. So the crux is the **confidence + fallback
policy**, not the happy path:

- **High-confidence, complete parse** → create the structured referral via the API.
- **Low-confidence or incomplete** → **never inject it.** Degrade safely to a human
  review step, or — cleanest — back to the **traditional fax queue**, handled the old
  way. The fax simply didn't make it onto the network. No structured referral is ever
  created from a bad parse.

Graceful degradation to "stays a fax, handled manually" is the safety net that keeps
the structured queue trustworthy.

### Open question: where the adapter lives

- **Network intake** — CE 2.0 owns fax numbers; fax-only senders fax *us*; we parse
  and submit on their behalf. A network play.
- **Receiver-side** — a receiver points their existing fax intake at our parser to
  digitize their fax pile into structured referrals. A different product (attacks the
  receiver's fax-pile pain) with different GTM.

Both call the same API. Pick deliberately — they're different businesses.

### Cost / PoC note

Real fax I/O is a **bought** capability (Documo/Concord/Twilio-style fax-to-API) and
**none of it is needed for the PoC**. The PoC demonstrates the structured path only;
the fax-parse adapter is the Year-2 hard problem, scoped tightly to extraction
quality + the fallback policy above. **Principle: richness out ∝ structure in** — and
that gap is physically gated (a bad parse can't safely produce a structured
referral), not an arbitrary paywall.

---

## 5. Events & subscriptions (close-the-loop)

Model close-the-loop as **pub/sub** (≈ Stripe Events + Webhooks): a performing org
emits an event (`referral.completed`), and subscribers are notified — each in their
preferred channel (referring provider, the patient's PCP, a care manager, etc.).
The §3 delivery primitive is the egress half; subscriptions are the new half.

The decisive split is **what a subscription is scoped to**:

- ✅ **Transaction-scoped — DO NOW.** Subscribers are the parties **named on the
  referral** (referrer, performing org, explicitly CC'd parties like "PCP: Dr. X").
  The referral carries its own subscriber list. Being named on the referral *is* the
  authorization basis — no matching, no roster, no consent engine. Pure Stripe.
- 🔒 **Panel-scoped — DEFER (Year 3+).** "Notify me about *any* event for *any*
  patient in my panel" drags in three of the hardest problems in US health interop
  at once: **patient matching** (no national patient ID), **treatment relationship /
  consent** (TEFCA/Carequality-scale governance — you cannot let any org subscribe
  to any patient), and **panel attribution** (roster sync + matching). This is a
  governance program, not a feature. Do not let it look like a small addition to the
  transaction-scoped version — it is a different, much larger beast.

Worth modelling early even so: a **consent / authorization-grant** as a first-class
object ("this party may receive events for this referral/patient"). Use only the
trivial "named on the referral" case now; the object is the seam the panel version
plugs into later.

---

## 6. Patient-mediated / open referral (Year 3+ mode)

Today referrals are **target-bound at creation**. The open-referral mode decouples
**intent** from **fulfillment** and lets the patient (or their agent) choose based on
availability, location, insurance, etc.

Lifecycle:

1. Referral created **target-agnostic** — an open request ("cardiology; insurance X,
   ≤20 mi, ≤2 weeks" + clinical packet).
2. **Matched** against the directory **+ live availability** → candidate set.
3. A **selection actor** (patient / patient's agent / scheduler) **binds** a target.
4. Downstream is **identical to a directed referral** — same dispatch, close-loop,
   tracking.

The only thing that changes vs. today is *the target is unknown at creation*. So
this is an **additive unbound front-stage, not a teardown** — directed and open are
two modes of the same referral object.

**Why it matters — it's a reframe of referral leakage.** Patients are referred and
then never schedule, schedule elsewhere, or aren't seen in time, *constantly*. Today
that "nah" happens **late and invisibly**: the org is already tracking a referral
that will never convert. Open referral moves the "nah" to the **front** of the funnel
(cheap) instead of the back (lost).

**Why it's hard / deferred:** needs (a) **live scheduling-availability federation**
(FHIR Slot/Schedule/Appointment; Epic open scheduling) and (b) the **patient as a
first-class actor** (identity, consent, a patient-facing surface) — neither exists in
the PoC. Lean conservative on ownership: the **referring org owns the open request**
while unbound; CE 2.0 provides the matching + patient selection surface. (A
network-level marketplace that *holds* unbound requests is more powerful but far more
invasive — later, if ever.)

---

## 7. What CE 2.0 is — and the line it does not cross

- ✅ **In scope:** address to the org (or a named provider/specialty in the
  directory), deliver in the right channel, track status across the boundary,
  fan out events to named subscribers.
- ❌ **Out of scope:** interpreting clinical content; intra-org routing / triage /
  scheduling logic ("which subteam, which slot"); being the system of record for the
  chart.

The boundary is **"named endpoint in the directory" vs. "internal operational
routing."** Cross it and you're doing the org's document management — the overreach
that makes the platform both unscalable and unsellable to a health system. CE 2.0 is
the switchboard, not the chart, and it hands off at the org's door.

---

## 8. The Stripe analogy — where it holds, where it breaks

**Holds:** transactional intent objects; **idempotency keys** (steal this on day one
— a retry must not double-fax/double-notify); events + webhooks; scoped/restricted
keys and on-behalf-of delegation; a hosted surface for the un-integrated (the portal
≈ Payment Links).

**Breaks / extends:**

- **Directory & discovery** — Stripe has *no* "search all merchants and pay them";
  the payer already knows who they're paying. In referrals, discovery *is* the core
  problem, so the directory is **better-than-Stripe** and is the closest thing to a
  moat. Closer analogs: Plaid's institution list; NPPES/DirectTrust/Carequality (all
  fragmented, none carry capabilities + required fields + preferred channel together).
- **Multi-channel preference routing** is more **Twilio Notify / Courier** than
  Stripe. The product is a blend: a Stripe-shaped transactional+events spine with a
  Twilio/Courier-shaped delivery layer.
- **Patient as an actor** (§6) has no Stripe analog at all.

---

## 9. Phasing

| Phase | Scope |
|---|---|
| **PoC** | Directed referral; directory + capability search; per-org instructions; send + dispatch stub; **structured referral queue, routed to the right work queue** (mocked); **transaction-scoped** close-loop; MCP server |
| **Year 2** | Real channel delivery (email/SMS/Direct); **fax egress** (bought) + **fax-parse adapter → API** (confidence + fallback policy); the **register-once bridge**; metering/billing; auth/OBO keys hardened |
| **Year 3+** | **Panel subscriptions** + consent/matching governance; **patient-mediated open referral** + scheduling-availability federation + patient-facing surface |
