# fleet-lite

A simulator for a software-defined connected delivery fleet. It models the hard parts of
running a fleet as scenarios you can run. The requirements are in [BUILD_SPEC.md](BUILD_SPEC.md), and the
decisions behind them are in [ARCHITECTURE.md](ARCHITECTURE.md).

**All data is simulated and all constants are assumptions.** This is my inference about the
category. It is not any company's real architecture.

## Run it

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

## The scenarios

| Tab | What it shows | Requirements |
|---|---|---|
| Operator | The fleet owner's day: one headline, a decision queue, and every route | R20–R22 |
| Architecture | The whole system as a live map, with traces through each layer | R20 |
| Vehicle | Runtime capability, hardware abstraction, and a software-defined scorecard | R13–R17 |
| Transfer | Moving a vehicle between operators while it's offline | R1–R4 |
| Revocation | Revoking driver access, online and offline | R5–R6 |
| OTA rollout | Staged rollouts with gates, halt, and rollback | R7–R9, R18–R19 |
| Range | Measured vs. modeled values, and the customer-facing claim | R10–R11 |

R12 (location retention) is tested in the core and has no tab. The Operator, Architecture,
Vehicle, and OTA tabs share one fleet of 60 vehicles.

## Layout

- `src/core` holds the logic, with no UI code: identity, telemetry, auth, OTA, range
- `src/sdv` holds the vehicle platform: hardware, HAL, feature catalog, twin, resolver,
  scorecard
- `src/scenarios` holds scripted worlds built on the core
- `src/ui` is vanilla JS on Vite
- `test` has one file per requirement group

## What testing caught

The first run reported a rollout as complete with 3 of 60 vehicles still on the old version.
They were offline during the final stage and nothing retried them. Completion now means
every vehicle is accounted for, so one unreachable vehicle holds a campaign open and shows
up as outstanding. That's the R8 failure in a form I hadn't written down.

A second one came from the scorecard. A factory-fresh vehicle passed "losing the cloud
freezes it, not stops it" with nothing running, which proves nothing. It now has to be
running something to pass.

## Not done

- **Transfer, Revocation, and Range are still their own scripted worlds.** They don't share
  the fleet.
- **Routes, charge levels, and loads are simulated.** The map is a schematic, not GPS, and
  driver names are invented.
- **A deploy is a list entry.** Rollouts go through the gates and the twin, but nothing is
  packaged, signed, or transferred.
- **Faulted features still count as active.** A fault feeds the gate, but the resolver doesn't
  take the feature out of service.
- **The compute budget is a simple sum.** Real contention, peak load, and thermal limits
  aren't modeled.

- **Faults appear at install.** Real regressions surface over days, so the soak time matters
  more than this simulation can show. The gate here trips within an hour.
- **Small canaries are blunt.** With 6 vehicles, a single fault is 17%, over the 10% gate. A
  real gate needs a sample size chosen for the fault rate it has to detect.
- **No real cryptography.** Certificates and leases are modeled, not signed.
- **No compliance claim.** Nothing here implements ISO/SAE 21434 or UNECE R155/R156.
- **The battery model is a placeholder.** The voltage curve is linear and uncertainty is one
  fixed percentage.
- **No persistence.** Each scenario resets on reload.
- **Layers 7–9 are out of scope:** alerting, public APIs, and a customer app.
