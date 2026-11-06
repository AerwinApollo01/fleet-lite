import { describe, expect, it } from 'vitest';
import { ASSUMPTIONS, CRITERIA, dataAgeSeconds, dataEstimate, DECISIONS, DEFAULT_INPUTS, evaluateDesign, formatAge, partnerQuestions, PARTNERS, PRESETS, risksFor, scoreDesign } from '../src/scenarios/tradeoffs.js';

const preset = (id) => PRESETS.find((p) => p.id === id).design;
const start = preset('start');
const inputs = DEFAULT_INPUTS;

describe('R34 the design model is consistent', () => {
  it('has presets that use only real options, for every decision', () => {
    for (const { design } of PRESETS) {
      for (const decision of DECISIONS) {
        expect(decision.options.map((o) => o.id)).toContain(design[decision.id]);
      }
    }
  });

  it('only scores known criteria', () => {
    const ids = CRITERIA.map((c) => c.id);
    for (const option of DECISIONS.flatMap((d) => d.options)) {
      for (const key of Object.keys(option.effect)) expect(ids).toContain(key);
    }
  });

  it('keeps scores between 1 and 5 for every possible design', () => {
    const designs = DECISIONS.reduce((all, d) => all.flatMap((design) => d.options.map((o) => ({ ...design, [d.id]: o.id }))), [{}]);
    expect(designs.length).toBe(486);
    for (const design of designs) {
      for (const score of Object.values(scoreDesign(design))) {
        expect(score).toBeGreaterThanOrEqual(1);
        expect(score).toBeLessThanOrEqual(5);
      }
      for (const { questions } of partnerQuestions(design)) expect(questions.length).toBeGreaterThan(0);
    }
  });

  it('rejects an unknown option', () => {
    expect(() => scoreDesign({ ...start, logic: 'magic' })).toThrow(/Unknown/);
  });

  it('has no design, out of all of them, that does well on everything', () => {
    const designs = DECISIONS.reduce((all, d) => all.flatMap((design) => d.options.map((o) => ({ ...design, [d.id]: o.id }))), [{}]);
    for (const design of designs) {
      expect(Math.min(...Object.values(scoreDesign(design)))).toBeLessThanOrEqual(3);
    }
  });

  it('gives every preset a real weakness and a real strength', () => {
    for (const { design } of PRESETS) {
      const values = Object.values(scoreDesign(design));
      expect(Math.max(...values)).toBeGreaterThan(Math.min(...values));
    }
  });
});

describe('R34 scores reflect real tradeoffs', () => {
  it('trades simplicity for microservices, and change speed for edge logic', () => {
    expect(scoreDesign({ ...start, cloud: 'microservices' }).simplicity).toBeLessThan(scoreDesign(start).simplicity);
    expect(scoreDesign({ ...start, logic: 'edge' }).changeSpeed).toBeLessThan(scoreDesign(start).changeSpeed);
    expect(scoreDesign({ ...start, logic: 'edge' }).offline).toBeGreaterThanOrEqual(scoreDesign(start).offline);
  });

  it('rates audit by how records are kept', () => {
    const audit = (records) => scoreDesign({ ...start, records }).audit;
    expect(audit('state')).toBeLessThan(audit('log'));
    expect(audit('log')).toBeLessThan(audit('sourcing'));
  });

  it('makes a vendor simpler, but less flexible', () => {
    const bought = scoreDesign({ ...start, sourcing: 'vendor' });
    expect(bought.simplicity).toBeGreaterThan(scoreDesign(start).simplicity);
    expect(bought.changeSpeed).toBeLessThan(scoreDesign(start).changeSpeed);
  });
});

describe('R34 the arithmetic is right', () => {
  it('calculates data and cost by hand', () => {
    const data = dataEstimate({ ...start, logic: 'cloud' }, { vehicles: 100, intervalSeconds: 60, costPerMb: 0.02 });
    const reports = (ASSUMPTIONS.activeHours * 3600) / 60;
    const mb = (reports * (ASSUMPTIONS.payloadBytes + 60) * ASSUMPTIONS.daysPerMonth) / 1e6;
    expect(data.mbPerVehicle).toBeCloseTo(mb, 6);
    expect(data.fleetCost).toBeCloseTo(mb * 0.02 * 100, 6);
    expect(data.reportsPerDay).toBe(72000);
  });

  it('doubles cost when reporting twice as often', () => {
    const slow = dataEstimate(start, { ...inputs, intervalSeconds: 60 }).fleetCost;
    const fast = dataEstimate(start, { ...inputs, intervalSeconds: 30 }).fleetCost;
    expect(fast).toBeCloseTo(slow * 2, 6);
  });

  it('scales with fleet size', () => {
    expect(dataEstimate(start, { ...inputs, vehicles: 400 }).fleetCost).toBeCloseTo(dataEstimate(start, inputs).fleetCost * 2, 6);
  });

  it('sends less when more logic runs on the vehicle', () => {
    const volume = (logic) => dataEstimate({ ...start, logic }, inputs).mbPerVehicle;
    expect(volume('edge')).toBeLessThan(volume('hybrid'));
    expect(volume('hybrid')).toBeLessThan(volume('cloud'));
  });

  it('costs more for request/response overhead than events', () => {
    expect(dataEstimate({ ...start, telemetry: 'rest' }, inputs).mbPerVehicle).toBeGreaterThan(dataEstimate(start, inputs).mbPerVehicle);
  });

  it('makes batch data hours old', () => {
    expect(dataAgeSeconds(start, inputs)).toBeLessThan(60);
    expect(dataAgeSeconds({ ...start, telemetry: 'batch' }, inputs)).toBeGreaterThan(3600);
  });

  it('formats age', () => {
    expect(formatAge(35)).toBe('about 35 seconds');
    expect(formatAge(600)).toBe('about 10 minutes');
    expect(formatAge(21605)).toBe('about 6 hours');
  });
});

describe('R34 it flags risks and shapes partner conversations', () => {
  const risks = (design, overrides = {}) => risksFor(design, { ...inputs, ...overrides }).join(' ');

  it('warns about microservices only for a small team', () => {
    const design = { ...start, cloud: 'microservices' };
    expect(risks(design, { teamSize: 4 })).toMatch(/small team/);
    expect(risks(design, { teamSize: 12 })).not.toMatch(/small team/);
  });

  it('warns about heavy streaming only for a small fleet', () => {
    const design = { ...start, processing: 'full' };
    expect(risks(design, { vehicles: 200 })).toMatch(/streaming/);
    expect(risks(design, { vehicles: 5000 })).not.toMatch(/streaming/);
  });

  it('warns that batch alerts arrive late', () => {
    expect(risks({ ...start, telemetry: 'batch' })).toMatch(/hours late/);
  });

  it('gives every preset at least one risk, so none looks free', () => {
    for (const { design } of PRESETS) expect(risksFor(design, inputs).length).toBeGreaterThan(0);
  });

  it('warns that a monolith strains at scale, and that a tiny team may not want to build', () => {
    expect(risks(start, { teamSize: 20 })).toMatch(/monolith/i);
    expect(risks(start, { vehicles: 4000 })).toMatch(/monolith/i);
    expect(risks(start)).not.toMatch(/monolith/i);
    expect(risks(start, { teamSize: 3 })).toMatch(/Buying/);
  });

  it('changes the conversation when you buy instead of build', () => {
    const questions = (design) => partnerQuestions(design).find((p) => p.partner === 'Telematics hardware').questions.join(' ');
    expect(questions({ ...start, sourcing: 'vendor' })).toMatch(/own the data|owns the data/i);
    expect(questions(start)).not.toMatch(/owns the data/i);
    expect(questions(start)).toMatch(/certificates/);
  });

  it('covers every partner type', () => {
    expect(partnerQuestions(start).map((p) => p.partner)).toEqual(PARTNERS);
  });

  it('returns everything together', () => {
    const result = evaluateDesign(preset('platform'), inputs);
    expect(Object.keys(result.scores)).toHaveLength(CRITERIA.length);
    expect(result.risks.length).toBeGreaterThan(0);
    expect(result.data.fleetCost).toBeGreaterThan(0);
  });
});
