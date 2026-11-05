// The only path that installs a feature: a campaign changes desired state, and the vehicle's
// own reconcile decides whether it landed. Deployed is not released; entitlement stays separate.
import { reconcile, setDesired } from './twin.js';

export function featureApplier(featureId) {
  const landed = (twin) => twin.reported.installed.includes(featureId);
  return {
    install(campaign, twin, now) {
      if (!twin.desired.installed.includes(featureId)) {
        setDesired(twin, { installed: [...twin.desired.installed, featureId] });
      }
      reconcile(twin, now);
      return landed(twin);
    },
    revert(campaign, twin, now) {
      if (twin.desired.installed.includes(featureId)) {
        setDesired(twin, { installed: twin.desired.installed.filter((id) => id !== featureId) });
      }
      reconcile(twin, now);
      return !landed(twin);
    },
    needsRevert: (campaign, twin) => campaign.results.has(twin.vin) && landed(twin),
  };
}
