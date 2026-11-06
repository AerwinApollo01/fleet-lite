// The customer surface and the internal surface share a pipeline and little else. A role
// decides which screens exist for you and, separately, what you're allowed to do.
export const SCREENS = {
  operator: 'Today',
  alerts: 'Alerts',
  maintenance: 'Maintenance',
  reports: 'Reports',
  assets: 'Assets',
  learn: 'Learn',
  architecture: 'System map',
  design: 'Design options',
  vehicle: 'Vehicle software',
  ota: 'Software rollouts',
  transfer: 'Ownership transfer',
  revocation: 'Driver access',
  range: 'Range model',
};

function persona(label, short, summary, groups) {
  const all = [...groups, { label: 'Help', tabs: ['learn'] }];
  return { label, short, summary, groups: all, tabs: all.flatMap((group) => group.tabs) };
}

export const ROLES = {
  owner: persona('Fleet owner', 'Owner', 'You run the business. Are we meeting commitments, and is the fleet healthy?', [
    { label: 'Run the fleet', tabs: ['operator', 'alerts', 'assets', 'maintenance', 'reports'] },
  ]),
  dispatcher: persona('Dispatcher', 'Dispatcher', 'You keep today’s routes moving, and act when one is in trouble.', [
    { label: 'Today’s work', tabs: ['operator', 'alerts'] },
  ]),
  technician: persona('Service technician', 'Technician', 'You keep vehicles ready. You see vehicles and work, not drivers.', [
    { label: 'Service', tabs: ['maintenance', 'assets'] },
  ]),
  engineer: persona('Platform engineer', 'Engineer', 'You build the platform and support customers. You can see every layer.', [
    { label: 'Data and system', tabs: ['architecture', 'design', 'range'] },
    { label: 'Ship software', tabs: ['ota', 'vehicle'] },
    { label: 'Identity and access', tabs: ['transfer', 'revocation'] },
    { label: 'What customers see', tabs: ['operator', 'alerts', 'assets', 'maintenance', 'reports'] },
  ]),
};

const ACTIONS = {
  'route.swap': ['engineer', 'owner', 'dispatcher'],
  'alert.respond': ['engineer', 'owner', 'dispatcher'],
  'pack.swap': ['engineer', 'owner', 'dispatcher', 'technician'],
  'zone.manage': ['engineer', 'owner'],
  'service.schedule': ['engineer', 'owner', 'technician'],
  'service.complete': ['engineer', 'technician'],
  'firmware.update': ['engineer', 'technician'],
  'issue.manage': ['engineer', 'owner'],
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
