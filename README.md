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

## Personas

The app opens as the fleet owner. Switch personas at the bottom of the menu, and each one gets only the screens
for its job (R28, R30). Learn is available to everyone. Each view has its own link, such as
`#dispatcher/alerts`.

| Persona | Job | Screens |
|---|---|---|
| Fleet owner | Run the business | Today, Alerts, Assets, Maintenance, Reports |
| Dispatcher | Keep today's routes moving | Today, Alerts |
| Service technician | Keep vehicles ready | Maintenance, Assets |
| Platform engineer | Build and support the platform | All of them, grouped below |

| Screen | What it shows | Requirements |
|---|---|---|
| Today | One headline, a decision queue, the map, and every route | R20–R23 |
| Alerts | Rationed alerts, closures, and the alert-to-action rate | R24–R25 |
| Assets | One register of vehicles and battery packs, with a history for each | R32–R33 |
| Maintenance | What's due, work orders, and what's broken | R26 |
| Reports | Closed days, CSV export, and who had a vehicle at a given time | R27 |
| Software rollouts | Staged rollouts with gates, halt, and rollback | R7–R9, R18–R19 |
| Vehicle software | Runtime capability, hardware abstraction, and a scorecard | R13–R17 |
| Ownership transfer | Moving a vehicle between operators while it's offline | R1–R4 |
| Driver access | Revoking driver access, online and offline | R5–R6 |
| Range model | Measured vs. modeled values, and the customer-facing claim | R10–R11 |
| System map | The whole system as a live map, with traces through each layer | R20 |
| Design options | Compare architectures: data cost, tradeoffs, risks, and partner questions | R34 |
| Learn | How-it-works guides with hands-on tools, a searchable glossary, and lessons learned | R29, R31 |

R12 (location retention) is tested in the core and has no screen. Everything except Ownership
transfer, Driver access, and Range model shares one fleet of 60 vehicles.

## Map data

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, available
under the [ODbL](https://opendatacommons.org/licenses/odbl/). Map tiles come from
[OpenFreeMap](https://openfreemap.org), © OpenMapTiles. Routes were generated with
[OSRM](https://project-osrm.org) and saved in `src/data/la-routes.json`, which is derived from
OpenStreetMap and stays under the ODbL. The map needs an internet connection for tiles. The
routes don't, and every route is also in the table.

To regenerate the routes, which makes about 60 requests to the public OSRM server:

```bash
npm run routes
```

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

- **Design options scores are judgment calls.** Only the data volume and cost are calculated, and
  they cover connectivity alone, not cloud, hardware, or people.

- **The register covers vehicles and battery packs only.** Chargers, parts, and telematics units
  aren't tracked yet, and there's no purchase, depreciation, or disposal.
- **Battery swaps skip the logistics.** A swap happens instantly, with no travel to a depot or
  swap station, and charging is a simple 4-hour timer.

- **Alerts stay in the app.** There's no email, SMS, or push.
- **Closures are fixed.** You can turn the two sample closures on and off, but not draw new ones.
- **Personas are a switcher, not a login.** The checks are real, but there's no authentication.
- **Maintenance figures are assumptions.** Service intervals and wear are placeholders.
- **No per-driver scoring.** That needs a real decision about worker monitoring first.

- **Ownership transfer, Driver access, and Range model are still their own scripted worlds.** They don't share
  the fleet.
- **Street geometry is real, but operations are simulated.** Stops, charge levels, loads, and
  driver names are invented, and vehicles move by shift progress, not GPS.
- **Routes use a car profile.** The public routing server only offers driving routes, so paths
  may include streets a small delivery vehicle wouldn't use.
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
