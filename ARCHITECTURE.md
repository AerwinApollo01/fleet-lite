# fleet-lite — Architecture Decisions

**The rule behind all of them:**

> The parts decide what the vehicle *could* do. Software decides what it does, again and
> again, after it's been delivered.

Each decision names what it costs and when to revisit it. A decision with no
downside isn't a decision. All of this is my inference about the category, built on
simulated vehicles. It isn't any company's real architecture.

---

## AD-1 · Apps talk to capabilities, never to supplier parts

**Decision.** A hardware abstraction layer sits between hardware and applications. Features
declare the capabilities they need, such as `battery`. Supplier adapters translate each
part's format into one contract.
**Why.** Without this layer, every feature is bound to a specific part from a specific
supplier, and changing behavior means changing hardware.
**Cost.** Every new part needs an adapter, and the contract limits apps to what all
suppliers can provide.
**Revisit if.** A capability only one supplier will ever offer, where the
contract adds cost and no optionality.
**Test.** Two BMS suppliers with different units give the same range estimate (R13).

## AD-2 · Capability is resolved at runtime, per vehicle

**Decision.** A feature is active only if the hardware can host it, the software is
installed, the vehicle is entitled, and it fits the compute budget. The resolver also says
which condition failed.
**Why.** Capability stops being a property of the SKU. Support can answer "why doesn't this
vehicle have it?" without an engineer.
**Cost.** Four conditions means four ways to be confused. Every vehicle can differ, so
support needs tooling a model-year company doesn't.
**Revisit if.** A fleet so uniform that per-vehicle resolution never changes
an answer.
**Test.** Same hardware, different entitlements, different active features (R14).

## AD-3 · Hardware is over-provisioned against a named roadmap

**Decision.** Compute and sensing ship with headroom sized to a specific roadmap feature,
not a vague margin.
**Why.** Headroom is a real unit cost paid years before the revenue, so it needs an argument
someone can defend. "Room for the proximity feature" can be defended. "Future-proofing"
can't.
**Cost.** Higher BOM on every vehicle, on low-margin hardware. If the roadmap slips, that
money is gone.
**Revisit if.** A roadmap that can't name the feature. Then ship the lean BOM.
**Test.** The roadmap feature fits on the headroom revision and not on the lean one (R15).

## AD-4 · The cloud decides, the vehicle acts, and it fails static

**Decision.** Each vehicle has a twin with **desired** state (what the cloud wants) and
**reported** state (what the vehicle actually runs). Sync reconciles them, one atomic
generation at a time. If the vehicle can't reach the cloud, it keeps its last known good.
**Why.** Offline is the normal case, so the vehicle can never need the cloud in order to
run. But the platform still needs to know where each vehicle really is.
**Cost.** Drift is a permanent condition you have to display and manage. An offline vehicle
keeps a feature after its entitlement ends.
**Revisit if.** A feature where stale state is dangerous. That one needs a
lease, like driver access.
**Test.** Changes queue offline, the vehicle keeps running, and a rejected generation leaves
the old one intact (R16).

## AD-5 · Safety and legal limits are bound at manufacture

**Decision.** Each subsystem has a binding. Brakes aren't software-configurable at all.
Tunable settings have an envelope fixed in hardware config. The cloud checks it, and the
vehicle checks it again, because the vehicle can't assume the cloud is right.
**Why.** Some things should stay hardware-defined. Hardware caution
is encoded where irreversibility is real, and software moves fast everywhere else.
**Cost.** Changing an envelope means a hardware-level change process, even when there's a
good business reason.
**Revisit if.** Validated evidence and a change process from the people who
own safety. Not a product request.
**Test.** Out-of-envelope and locked settings are rejected at both layers (R17).

## AD-6 · The installed base is the deployment target

**Decision.** Firmware and features reach vehicles one way: a staged campaign. A feature
rollout changes desired state, and the vehicle's own reconcile decides whether it landed.
Vehicles that can't host the build are excluded with a reason, not silently skipped or
counted as failures. Installs wait until off shift. **Deployed isn't released:** a feature
can sit installed and dark until it's entitled, which can happen any time.
**Why.** Once hardware revisions mix in the field, "the fleet" is not one target. This is
the version inventory a model-year company doesn't have.
**Cost.** Every hardware revision multiplies the test matrix for as long as it's in service.
**Revisit if.** There are so few hardware revisions that eligibility logic isn't needed yet.
**Test.** A campaign excludes ineligible vehicles and can still complete (R18). A bad
feature stops at the canary and rolls back through the twin (R19).

## AD-7 · Alerts are rationed, and measured by what they cause

**Decision.** Critical alerts fire at once, even on last-known data. Warnings must last an hour
and need a connected vehicle. An open alert never repeats, and "Not useful" mutes it for the
day. The headline measure is the share of closed alerts that led to action.
**Why.** Someone running dozens of routes mutes anything that cries wolf twice, so a precise
alert nobody trusts is worth nothing. The queue on the Today screen always shows every
problem, so holding an alert back delays an interruption, not the information.
**Cost.** A real problem can take up to an hour to interrupt anyone.
**Revisit if.** The action rate stays high and people say they heard about problems too late.
**Test.** Warnings wait for time rather than checks, and swaps count as action (R24).

## AD-8 · Roles are enforced in the logic, and surfaces stay separate

**Decision.** The app is organized by persona: owner, dispatcher, technician, and engineer. A
persona decides which screens exist and what actions are allowed. Actions are
checked in the logic, not only hidden in the UI. Customers never see the engineering views, and
the service view carries no driver or location data.
**Why.** Internal users debug the system and customers depend on it, so they need different
surfaces. Giving each role only what its job needs is also the simplest privacy control.
**Cost.** Every new action needs a decision about who can do it.
**Revisit if.** Customers need finer control than four fixed roles.
**Test.** Blocked actions throw, even when called directly (R28).

## AD-9 · A battery pack is its own asset

**Decision.** Packs have their own identity, health, cycles, and history. A vehicle's range comes
from the pack installed in it, and a swap is a recorded event.
**Why.** With removable packs, health and history belong to the pack. Tracking them on the vehicle
would be wrong after the first swap. It also makes a cheaper fix possible: a charged pack keeps the
vehicle and driver working.
**Cost.** Two records to keep in step, and swaps to reconcile with an offline vehicle.
**Revisit if.** Batteries are fixed for the vehicle's whole life.
**Test.** Health moves with the pack, and a swap fixes the route and appears in every history
(R32–R33).

## AD-10 · The system twin is a read model over existing records

**Decision.** The part-by-part view of a vehicle computes from records the system already keeps: packs,
service items, firmware, connectivity, and hardware revision. It stores no state of its own, and work
goes through the same work orders as Maintenance. This is separate from the desired/reported twin in
AD-4, which decides what a vehicle should run. That one controls. This one explains.
**Why.** A second copy of vehicle health would eventually disagree with the first, and then nobody
trusts either. It also keeps an offline vehicle honest: the view stops at its last report.
**Cost.** Each view recomputes from records. That's fine here, but a real fleet would need
a precomputed store fed by events, plus retained time series, which are simulated here.
**Revisit if.** Fleet-wide views get slow, or people need history no current record holds.
**Test.** The list and the twin agree across a 500-vehicle fleet, and repairs flow through work orders
(R36).

## AD-11 · Release sets with tested patches, delivered through one update master

**Decision.** A release set pins a tested version for every part. A single-part patch is allowed only
if the result is a tested combination. The gateway downloads and verifies once, and parts receive
images through it. Two-slot parts stage first and switch together. One-slot parts flash before that
switch, so their new versions must work with the old set.
**Why.** Nine independently updated parts would create combinations nobody tested. A strict set alone
would make an urgent sensor fix wait for a full release.
**Cost.** Someone has to keep the compatibility record current. A vehicle can legitimately be mixed, so
support needs to see per-part versions. Keeping one-slot firmware backward compatible limits how fast
those interfaces can change.
**Revisit if.** Hardware gives every part two slots, or the patch list grows until the sets mean nothing.
**Test.** Untested combinations are refused, and a failed switch leaves a tested combination (R39).

## AD-12 · One record per event, shown at the depth each persona needs

**Decision.** Operating ranges live with each signal. Status, verdicts, graphs, and log entries are all
worked out from those ranges and the same events. The log is append-only, and a role decides what
comes back from it. Owners start from a verdict, technicians from readings, and engineers can reach
raw frames.
**Why.** Separate views of the same data drift apart, and then nobody trusts any of them. Different
people still need different depth, so that's a matter of presentation and permission, not of data.
**Cost.** Keeping every entry grows storage forever, and frozen entries can't be fixed, only corrected.
Ranges need owners, because a wrong range misleads every view at once.
**Revisit if.** Tolerances need to vary by mode, such as driving and charging, or retention needs limits.
**Test.** Entries can't change, the log agrees with the twin, and role limits hold in the logic (R40–R41).

## AD-13 · A fix is judged by measurement, and it only changes the future

**Decision.** A fix removes a share of the failures that would have come later, starting when it
reaches each vehicle. It never edits history. The result compares fixed vehicles with what their old
rate predicted for the same distance, and it needs enough expected failures before it says anything.
**Why.** A forecast is a belief. Teams often declare success on launch day or on a few quiet days, and
then repeat the mistake. The forecast and true effect differ here on purpose.
**Cost.** The answer takes weeks, and a comparison with an old rate can be fooled by season or routes.
A real program would also keep unfixed vehicles as a control group where that's safe.
**Revisit if.** Fixes roll out slowly enough for a proper control group.
**Test.** A forecast never appears as a result, and an issue can't close on too little data (R42).

---

## Decisions already in place

| Decision | Where | Requirement |
|---|---|---|
| Data belongs to the owner at event time, not arrival time | `core/telemetry.js` | R2 |
| Raw data is immutable, except location | `core/telemetry.js` | R12 |
| Driver access uses short leases cached on the vehicle | `core/auth.js` | R5, R6 |
| Silence never passes a rollout gate | `core/ota.js` | R8 |
| The swap log is append-only, so an undo is a new entry | `scenarios/operations.js` | R27 |
| Each vehicle's event log is append-only | `scenarios/eventlog.js` | R41 |
| Every number carries measured or modeled provenance | `core/range.js` | R10 |

---

## Where each subsystem sits

| Subsystem | Binding | Why |
|---|---|---|
| Frame, brakes | Hardware | Physics and safety. Not configurable. |
| Motor assist limit | Bounded | Tunable within a fixed envelope |
| Charge limit | Bounded | Chemistry is fixed, charge policy is tunable |
| Range estimation | Software | A model over measured inputs |
| Driver access | Software | A runtime decision, with a stated offline worst case |
| Diagnostics | Software | Thresholds and confidence can change |

---

## The test for all of this

If the cloud disappeared for a year, the vehicle should keep working on its last known good
state, and the product should stop changing. The Vehicle software screen computes that from real state,
along with the rest of the scorecard.
