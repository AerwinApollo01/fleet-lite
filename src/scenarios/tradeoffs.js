// A thinking tool for comparing architectures. Data volume and cost are arithmetic on stated
// assumptions. Scores are judgment calls, written down so they can be argued with.
export const CRITERIA = [
  { id: 'freshness', label: 'Freshness', hint: 'How current the data is' },
  { id: 'offline', label: 'Offline resilience', hint: 'How well it copes with no signal' },
  { id: 'changeSpeed', label: 'Speed of change', hint: 'How easily behavior can change' },
  { id: 'audit', label: 'Auditability', hint: 'How well you can prove what happened' },
  { id: 'openness', label: 'Partner openness', hint: 'How easily others can integrate' },
  { id: 'simplicity', label: 'Simplicity', hint: 'How little there is to run' },
];

export const DECISIONS = [
  {
    id: 'telemetry', label: 'How data leaves the vehicle', options: [
      { id: 'mqtt', label: 'Events (MQTT)', layer: 'MQTT with store-and-forward', effect: { freshness: 1, offline: 1, openness: 1 } },
      { id: 'rest', label: 'Request/response', layer: 'HTTPS calls on a schedule', effect: { offline: -2, simplicity: 1 } },
      { id: 'batch', label: 'Batch upload', layer: 'Files uploaded in chunks', effect: { freshness: -2, offline: 1, simplicity: 1 } },
    ],
  },
  {
    id: 'processing', label: 'How the cloud processes it', options: [
      { id: 'light', label: 'Light streaming', layer: 'Simple rules on each event', effect: { freshness: 1 } },
      { id: 'full', label: 'Full streaming', layer: 'A streaming platform', effect: { freshness: 2, simplicity: -2, openness: 1 } },
      { id: 'batch', label: 'Batch jobs', layer: 'Scheduled jobs', effect: { freshness: -1, simplicity: 1 } },
    ],
  },
  {
    id: 'logic', label: 'Where the logic runs', options: [
      { id: 'hybrid', label: 'Hybrid', layer: 'Basics on the vehicle, intelligence in the cloud', effect: { offline: 1 } },
      { id: 'cloud', label: 'Cloud-heavy', layer: 'Mostly in the cloud', effect: { changeSpeed: 1, offline: -1 } },
      { id: 'edge', label: 'Edge-heavy', layer: 'Mostly on the vehicle', effect: { changeSpeed: -2, offline: 2, freshness: 1 } },
    ],
  },
  {
    id: 'cloud', label: 'How the cloud is built', options: [
      { id: 'monolith', label: 'Modular monolith', layer: 'One well-structured service', effect: { simplicity: 1, changeSpeed: 1, openness: -1 } },
      { id: 'microservices', label: 'Microservices', layer: 'Many small services', effect: { simplicity: -2, openness: 1 } },
      { id: 'serverless', label: 'Serverless', layer: 'Managed functions', effect: { simplicity: 1 } },
    ],
  },
  {
    id: 'records', label: 'How records are kept', options: [
      { id: 'log', label: 'Event log', layer: 'Current state plus an event log', effect: { audit: 1 } },
      { id: 'state', label: 'Current state only', layer: 'Latest values only', effect: { audit: -2, simplicity: 1 } },
      { id: 'sourcing', label: 'Event sourcing', layer: 'Events are the source of truth', effect: { audit: 2, simplicity: -1 } },
    ],
  },
  {
    id: 'sourcing', label: 'Build or buy telematics', options: [
      { id: 'build', label: 'Build', layer: 'Your own device software and platform', effect: { changeSpeed: 1, simplicity: -1 } },
      { id: 'vendor', label: 'Buy from a vendor', layer: 'A vendor’s device and platform', effect: { changeSpeed: -1, simplicity: 2, openness: -1 } },
    ],
  },
];

export const PRESETS = [
  { id: 'start', label: 'Simple start', design: { telemetry: 'mqtt', processing: 'light', logic: 'hybrid', cloud: 'monolith', records: 'log', sourcing: 'build' } },
  { id: 'platform', label: 'Full platform', design: { telemetry: 'mqtt', processing: 'full', logic: 'hybrid', cloud: 'microservices', records: 'sourcing', sourcing: 'build' } },
  { id: 'vendor', label: 'Vendor-led', design: { telemetry: 'mqtt', processing: 'light', logic: 'cloud', cloud: 'serverless', records: 'state', sourcing: 'vendor' } },
  { id: 'edge', label: 'Edge-first', design: { telemetry: 'batch', processing: 'batch', logic: 'edge', cloud: 'monolith', records: 'log', sourcing: 'build' } },
];

export const DEFAULT_INPUTS = { vehicles: 200, intervalSeconds: 30, teamSize: 6, costPerMb: 0.02 };

// Stated assumptions behind the arithmetic.
export const ASSUMPTIONS = { activeHours: 12, daysPerMonth: 26, payloadBytes: 220 };
const OVERHEAD_BYTES = { mqtt: 60, rest: 700, batch: 10 };
const COMPRESSION = { mqtt: 1, rest: 1, batch: 0.4 };
const LOGIC_REDUCTION = { cloud: 1, hybrid: 0.6, edge: 0.3 };
const BATCH_HOURS = 6;

const clamp = (score) => Math.min(5, Math.max(1, score));

export function scoreDesign(design) {
  const scores = Object.fromEntries(CRITERIA.map((c) => [c.id, 3]));
  for (const decision of DECISIONS) {
    const option = decision.options.find((o) => o.id === design[decision.id]);
    if (!option) throw new Error(`Unknown option for ${decision.id}`);
    for (const [criterion, change] of Object.entries(option.effect)) scores[criterion] += change;
  }
  return Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, clamp(score)]));
}

export function dataEstimate(design, inputs) {
  const { activeHours, daysPerMonth, payloadBytes } = ASSUMPTIONS;
  const reports = (activeHours * 3600) / inputs.intervalSeconds;
  const bytes = (payloadBytes * COMPRESSION[design.telemetry] + OVERHEAD_BYTES[design.telemetry]) * LOGIC_REDUCTION[design.logic];
  const mbPerVehicle = (reports * bytes * daysPerMonth) / 1e6;
  const costPerVehicle = mbPerVehicle * inputs.costPerMb;
  return {
    reportsPerDay: Math.round(reports * inputs.vehicles),
    mbPerVehicle,
    costPerVehicle,
    fleetCost: costPerVehicle * inputs.vehicles,
  };
}

export function dataAgeSeconds(design, inputs) {
  const arrival = design.telemetry === 'batch' ? BATCH_HOURS * 3600 : inputs.intervalSeconds;
  const processing = design.processing === 'batch' ? BATCH_HOURS * 3600 : 5;
  return arrival + processing;
}

const RISKS = [
  { when: (d, i) => d.cloud === 'monolith' && (i.teamSize >= 15 || i.vehicles >= 3000), text: 'A monolith gets harder as teams and traffic grow. Releases collide, and parts can’t scale separately.' },
  { when: (d, i) => d.sourcing === 'build' && i.teamSize < 5, text: 'Building device software and a platform is a lot for a team this small. Buying may get you to market sooner.' },
  { when: (d) => d.processing === 'light' && d.records === 'log', text: 'Simple rules work until questions need many events at once, such as trends across the fleet. Plan how you’d grow past them.' },
  { when: (d, i) => d.cloud === 'microservices' && i.teamSize < 8, text: 'Microservices with a small team usually means more time running services than building the product.' },
  { when: (d, i) => d.processing === 'full' && i.vehicles < 1000, text: 'A full streaming platform is likely more than this fleet size needs.' },
  { when: (d) => d.telemetry === 'rest', text: 'Scheduled requests fail when a vehicle has no signal, and offline is the normal case. Data needs a buffer and a retry plan.' },
  { when: (d) => d.telemetry === 'batch' || d.processing === 'batch', text: 'Alerts arrive hours late, so nobody can act on a route problem during the shift.' },
  { when: (d) => d.logic === 'edge', text: 'Logic on the vehicle changes only through firmware updates, the slowest and riskiest kind of change.' },
  { when: (d) => d.logic === 'cloud' && d.sourcing === 'vendor', text: 'With little logic on the vehicle and a vendor in the middle, an outage on their side could stop more than reporting.' },
  { when: (d) => d.records === 'sourcing', text: 'Events that are never deleted conflict with deleting personal data, so location needs its own plan.' },
  { when: (d) => d.records === 'state', text: 'Keeping only the latest values means you can’t answer who had a vehicle, or what changed, after the fact.' },
  { when: (d) => d.sourcing === 'vendor', text: 'A vendor’s roadmap and pricing become your dependency, including how quickly OTA and data access can change.' },
  { when: (d, i) => i.intervalSeconds <= 10, text: 'Reporting this often multiplies data cost. Check that decisions really need it.' },
];

export const risksFor = (design, inputs) => RISKS.filter((risk) => risk.when(design, inputs)).map((risk) => risk.text);

export const PARTNERS = ['Telematics hardware', 'Connectivity', 'Vehicle and component suppliers', 'Cloud and data', 'Integration partners', 'Fleet customers'];

const QUESTIONS = [
  { partner: 'Telematics hardware', when: (d) => d.sourcing === 'vendor', text: 'Who owns the data, and can we export all of it, including raw history?' },
  { partner: 'Telematics hardware', when: (d) => d.sourcing === 'vendor', text: 'Can we control OTA campaigns and rollback, or does your team run them?' },
  { partner: 'Telematics hardware', when: (d) => d.sourcing === 'vendor', text: 'What happens to our fleet if we leave or you discontinue the device?' },
  { partner: 'Telematics hardware', when: (d) => d.sourcing === 'build', text: 'Can your device run our software, and how much compute and storage headroom is there?' },
  { partner: 'Telematics hardware', when: (d) => d.sourcing === 'build', text: 'How are device certificates provisioned at the factory?' },
  { partner: 'Telematics hardware', when: (d) => d.logic !== 'cloud', text: 'How much data can the device buffer, and for how long, with no signal?' },
  { partner: 'Connectivity', when: () => true, text: 'What does a pooled data plan cost at our volume, and what are the overage terms?' },
  { partner: 'Connectivity', when: (d) => d.telemetry === 'mqtt', text: 'How does coverage hold up in parking structures, and how do connections recover?' },
  { partner: 'Connectivity', when: (d) => d.telemetry === 'batch', text: 'Can large uploads use depot Wi-Fi instead of cellular?' },
  { partner: 'Vehicle and component suppliers', when: () => true, text: 'Do we get the signal definitions, and how will we hear about changes?' },
  { partner: 'Vehicle and component suppliers', when: (d) => d.sourcing === 'build', text: 'Which modules can be updated over the air, and how do they recover from a failed update?' },
  { partner: 'Vehicle and component suppliers', when: (d) => d.logic === 'edge', text: 'Which behavior can we change, and which is locked inside your part?' },
  { partner: 'Cloud and data', when: (d) => d.processing === 'full', text: 'What’s the cost at our event volume, and what skills does your platform need?' },
  { partner: 'Cloud and data', when: (d) => d.cloud === 'serverless', text: 'At what volume does managed pricing stop making sense?' },
  { partner: 'Cloud and data', when: (d) => d.records !== 'state', text: 'How long do we retain events, and how do we delete personal data from them?' },
  { partner: 'Cloud and data', when: (d) => d.cloud !== 'serverless' && d.processing !== 'full', text: 'What’s the simplest managed setup for device connections and storage?' },
  { partner: 'Integration partners', when: (d) => d.telemetry === 'mqtt' || d.processing === 'full', text: 'Do you want events pushed to you, or will you call a REST API?' },
  { partner: 'Integration partners', when: (d) => d.telemetry !== 'mqtt' && d.processing !== 'full', text: 'Is data that’s hours old good enough for what you’re building?' },
  { partner: 'Integration partners', when: (d) => d.sourcing === 'vendor', text: 'Can you integrate with the vendor’s API, or do you need ours in front of it?' },
  { partner: 'Integration partners', when: () => true, text: 'How much notice do you need before an API or event format changes?' },
  { partner: 'Fleet customers', when: (d) => d.telemetry === 'batch' || d.processing === 'batch', text: 'Can your operation work with data from earlier in the day?' },
  { partner: 'Fleet customers', when: (d) => d.telemetry !== 'batch' && d.processing !== 'batch', text: 'Which decisions do you really make in real time?' },
  { partner: 'Fleet customers', when: (d) => d.records === 'state', text: 'Do you ever need to prove what happened, for claims or disputes?' },
  { partner: 'Fleet customers', when: (d) => d.records !== 'state', text: 'How long do you need history, and who may see driver location?' },
];

export function partnerQuestions(design) {
  return PARTNERS.map((partner) => ({
    partner,
    questions: QUESTIONS.filter((q) => q.partner === partner && q.when(design)).map((q) => q.text),
  }));
}

export function evaluateDesign(design, inputs) {
  return {
    scores: scoreDesign(design),
    data: dataEstimate(design, inputs),
    dataAge: dataAgeSeconds(design, inputs),
    risks: risksFor(design, inputs),
    partners: partnerQuestions(design),
  };
}

export function formatAge(seconds) {
  if (seconds < 90) return `about ${Math.round(seconds)} seconds`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}
