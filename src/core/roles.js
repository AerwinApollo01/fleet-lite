// The customer surface and the internal surface share a pipeline and little else. A role
// decides which screens exist for you and, separately, what you're allowed to do.
export const ROLES = {
  engineer: { label: 'Platform engineer', tabs: ['operator', 'alerts', 'maintenance', 'reports', 'learn', 'architecture', 'vehicle', 'transfer', 'revocation', 'ota', 'range'] },
  owner: { label: 'Fleet owner', tabs: ['operator', 'alerts', 'maintenance', 'reports', 'learn'] },
  dispatcher: { label: 'Dispatcher', tabs: ['operator', 'alerts', 'learn'] },
  technician: { label: 'Service technician', tabs: ['maintenance', 'learn'] },
};

const ACTIONS = {
  'route.swap': ['engineer', 'owner', 'dispatcher'],
  'alert.respond': ['engineer', 'owner', 'dispatcher'],
  'zone.manage': ['engineer', 'owner'],
  'service.schedule': ['engineer', 'owner', 'technician'],
  'service.complete': ['engineer', 'technician'],
  'report.export': ['engineer', 'owner'],
  'trace.view': ['engineer'],
};

export const roleOf = (world) => world.role ?? 'engineer';

export function can(role, action) {
  const allowed = ACTIONS[action];
  if (!allowed) throw new Error(`Unknown action ${action}`);
  return allowed.includes(role);
}

export function authorize(world, action) {
  const role = roleOf(world);
  if (!can(role, action)) throw new Error(`${ROLES[role].label} can't do ${action}`);
}
