# fleet-lite — Build Spec
### A lifecycle simulator for a connected delivery fleet · spec'd Nov 5, 2026

**What this document is.** The hard problems of running a connected fleet, written as
requirements that can fail. The chain, used throughout:

> **felt quality → observable behavior → measurable quantity → threshold → a test that can fail**

**What it is not.** This is not any company's real architecture. Everything here is my
inference about the category, built on simulated vehicles with assumed numbers. The evidence
base is my own field experience, **not** customer research, and it shouldn't pretend to be.

---

## 1 · THE STRATEGIC CALL — build the lifecycle, not the dashboard

A fleet that works in a pilot usually hits identity and lifecycle problems before it runs
out of features. So v0 builds the parts that are brutal to retrofit, and nothing above them:

| Layer | In v0 | Why |
|---|---|---|
| 3 · Identity & provisioning | ✅ | Transfer exposes tenancy, retention, and entitlement at once |
| 4 · Ingest | Only what transfer needs | Late-arriving data is what makes transfer hard |
| 5 · State | ✅ | Every value has to say whether it was measured or modeled |
| 6 · OTA | ✅ | Where hardware discipline and software speed have to meet |
| Vehicle software platform | ✅ | Abstraction, runtime capability, and desired/reported state make it software-defined |
| 7–9 · Alerts, APIs, apps | ❌ | Out of scope for now; see §4 |

---

## 2 · THE ASSUMPTION THAT DRIVES EVERYTHING

> **Offline is the normal case.** Parking structures and urban canyons are the job site.

Every requirement below is written against a vehicle that may not be reachable. A design
that needs the cloud to start a shift fails this spec, which is also why "does the product
stop without the cloud?" is the wrong test for software-defined. The better test is
whether capability still gets decided, and changed, from the platform over time.

---

## 3 · REQUIREMENTS

### Identity & tenancy

**R1 · Provisioning and commissioning are separate, and a vehicle can sit between them.**
Felt: nobody finds a vehicle that phones home and belongs to no one.
Test: a provisioned, uncommissioned vehicle has no owner, and its data goes to quarantine,
never to a customer. Two devices can't share a certificate.

**R2 · Data belongs to whoever owned the vehicle when the event happened.**
Felt: one operator never sees another operator's driver or trip.
Test: a trip recorded offline under Operator A and uploaded after a transfer to Operator B is visible
to A and not to B. Attribution by *received* time would leak it, and the test shows that.

**R3 · Store-and-forward is idempotent.**
Felt: a flaky connection never double-counts a trip.
Test: delivering the same event twice stores one record.

**R4 · An entitlement the customer can't see doesn't exist.**
Felt: an operator knows what this vehicle can do without calling support.
Test: entitlements are readable per vehicle by the owning fleet. On transfer,
contract-scoped entitlements end and vehicle-scoped ones survive.

### Driver access

**R5 · Revocation has a stated worst case, online or offline.**
Felt: a driver whose access was revoked can't take a vehicle.
Test: a connected vehicle denies on the next start. A disconnected vehicle denies no later
than lease expiry, so exposure never exceeds the lease TTL.

**R6 · A legitimate driver can start with no signal.**
Felt: the 5am shift starts in a parking structure.
Test: a valid cached lease starts the vehicle offline, decided from vehicle state alone.
The TTL tradeoff is computed, not asserted: a shorter TTL means less exposure and more
lockouts, and the test checks that both move in those directions.

### OTA

**R7 · A rollout without a named owner and a gate can't exist.**
Felt: every rollout has someone accountable who can stop it.
Test: creating a campaign with no owner, metric, threshold, soak time, or minimum sample
throws.

**R8 · Silence never passes a gate.**
Felt: a bad build reaches a few vehicles, not the fleet.
Test: a stage can't advance below its minimum sample, however long it waits. A breach halts
the campaign before the next stage. Only the owner or a delegate can halt by hand, and a
gate-halted campaign can't be resumed.

**R9 · Updates never land mid-shift, and rollback reaches stragglers.**
Felt: no vehicle loses a shift to an update. Rollback is real.
Test: no install or revert happens during shift hours. A vehicle offline during rollback is
listed as a straggler and reverted when it comes back.

### Measured vs. modeled

**R10 · Every number knows what it is.**
Felt: when a number changes, someone can say why.
Test: every value carries `measured` or `modeled`. Modeled values carry a model version and
their inputs. Replaying the same inputs through a new model explains the change as a model
change, not a vehicle change.

**R11 · The customer gets a decision, from the cautious end of the estimate.**
Felt: nobody strands mid-route on a number we presented as fact.
Test: the claim uses P10 plus a reserve, not the median. There's a case where the median
says "fine" and the claim says "at risk." The policy has a named owner.

### Privacy

**R12 · Raw is immutable, except location, which is deliberately not.**
Felt: "keep everything forever" never applies to where a worker was.
Test: ingest splits location into its own store. After retention expires, location is gone
and the rest of the raw record is untouched.

### Software-defined vehicle

The decisions behind these are in [ARCHITECTURE.md](ARCHITECTURE.md).

**R13 · Apps don't know who made the part.**
Felt: changing a battery supplier doesn't mean rewriting features.
Test: two suppliers with different units give the same range estimate. An adapter that
breaks the contract fails loudly.

**R14 · Capability is decided per vehicle, at runtime, and explained.**
Felt: support can say why a vehicle lacks a feature without an engineer.
Test: identical hardware gives different active features under different entitlements.
Every inactive feature has one stated reason.

**R15 · Headroom is sized to a named roadmap feature.**
Felt: someone can defend the extra BOM cost.
Test: the roadmap feature fits on the headroom revision and can't fit on the lean one.

**R16 · The cloud decides, and the vehicle doesn't depend on it.**
Felt: a vehicle never fails a shift because of a sync problem.
Test: changes queue while offline and show as drift. The vehicle keeps its last known good
state. A generation applies whole or not at all. Installs wait until off shift. After a
transfer, contract features end at the next sync.

**R17 · Software can't leave the envelope.**
Felt: no update can make the vehicle unsafe or illegal.
Test: an out-of-range or locked setting is rejected by the cloud. If one gets past the
cloud, the vehicle rejects it too and stays on its current generation.

**R18 · The installed base is the deployment target.**
Felt: a mixed fleet doesn't break rollouts.
Test: a campaign skips incompatible vehicles, lists them by name, and can still complete.

**R19 · A feature reaches the installed base only through a rollout.**
Felt: nobody can push a feature to a vehicle around the gates, and a bad one stays small.
Test: a feature rollout stages across a mixed fleet and excludes vehicles by reason. A bad
one halts at the canary and rolls back through the twin without touching entitlement.
Installed features stay dark until entitled. One campaign runs at a time.

### Operator experience

**R20 · The operator gets one decision per route, from the real pipeline.**
Felt: the owner can see in seconds whether today's commitments will be met.
Test: every route has exactly one status and a plain-language reason, with no raw model terms.
Claims come from the same HAL, range model, and policy as everything else. An offline vehicle
is never called on track.

**R21 · A software change reaches the operator as a better decision.**
Felt: a released feature changes what the operator can trust.
Test: payload stays assumed until load-aware range is released, then it's measured, and at
least one route decision changes.

**R22 · Decisions change the plan.**
Felt: acting on a problem clears it.
Test: swapping to a recommended spare resolves the decision. A spare is never offered twice,
and a vehicle that was swapped out isn't offered again.

**R23 · Routes are real streets, and the map shows what was last reported.**
Felt: a dispatcher can read the map like the city they work in.
Test: every route is a street-following loop from the depot, in central Los Angeles, with a
named area. Distances match the routed geometry. An offline vehicle appears where it last
reported, not where it should be by now.

---

## 4 · WHAT I'M NOT BUILDING, AND WHY

- **Real cryptography.** Certificates and leases are modeled, not signed. The lifecycle is
  the point, and fake crypto would claim something it doesn't do.
- **ISO/SAE 21434 or UNECE R155/R156 compliance.** Nothing here implements them.
- **Alerting, public APIs, a production customer app.** The Operator screen is a simulated
  view of the data, not a shipped app.
- **A real battery model.** The voltage-to-SoC curve is linear. Real packs aren't.

---

## 5 · OPEN DECISIONS

- **Can a driver's phone carry the credential?** A signed token over Bluetooth could reduce
  lockouts, but the phone may have no signal in the same structure.
- **Should a rollback be allowed mid-shift for a vehicle already faulted?** v0 says never.
  There's a real argument that a dead vehicle has no shift left to protect.
- **Who owns the P10 policy?** The code requires a name. The org has to supply one.
- **Should an offline vehicle keep a feature after its entitlement ends?** v0 says yes, until
  it next syncs. A lease would bound that, at the risk of a feature dropping mid-route.
- **Is the headroom worth it?** The $38 BOM delta is a placeholder. The real argument needs
  real volumes and the revenue the roadmap feature would bring in.
