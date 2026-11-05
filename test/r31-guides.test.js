import { describe, expect, it } from 'vitest';
import { decodeFrame, formula, parseFrame, SAMPLE_SIGNALS } from '../src/core/can.js';
import { powerCutOutcome, STAGES } from '../src/core/flash.js';
import { GUIDES } from '../src/data/guides.js';
import { CATEGORIES, GLOSSARY, searchGlossary } from '../src/data/learn.js';

const values = (text) => decodeFrame(parseFrame(text).bytes).map((s) => s.value);

describe('R31 the CAN decoder gets real answers', () => {
  it('decodes the worked example', () => {
    expect(values('13 38 3C B4 00 00 00 00')).toEqual([49.2, 20, 90]);
  });

  it('decodes the practice frame', () => {
    expect(values('12 C0 46 64 00 00 00 00')).toEqual([48, 30, 50]);
  });

  it('shows the working', () => {
    const [voltage, temperature] = decodeFrame(parseFrame('13 38 3C B4').bytes);
    expect(voltage).toMatchObject({ hex: '13 38', raw: 4920 });
    expect(formula(voltage)).toBe('× 0.01');
    expect(formula(temperature)).toBe('− 40');
  });

  it('handles negatives from an offset', () => {
    expect(values('00 00 1E 00')[1]).toBe(-10);
  });

  it('accepts lowercase and extra spaces', () => {
    expect(values('  13 38   3c b4 ')).toEqual([49.2, 20, 90]);
  });

  it.each([
    ['', /Enter/],
    ['13 38 3C B4 00 00 00 00 00', /at most 8/],
    ['13 3G', /two hex/],
    ['1338', /two hex/],
  ])('rejects %j', (text, message) => {
    expect(parseFrame(text).error).toMatch(message);
  });

  it('marks signals a short frame does not contain', () => {
    const decoded = decodeFrame(parseFrame('13').bytes);
    expect(decoded.every((s) => s.missing)).toBe(true);
    expect(decodeFrame(parseFrame('13 38').bytes)[0].value).toBe(49.2);
  });

  it('has a sample definition for three signals', () => {
    expect(SAMPLE_SIGNALS).toHaveLength(3);
  });
});

describe('R31 the power-cut simulator follows the real logic', () => {
  it('is always safe with two slots', () => {
    for (const { id } of STAGES) expect(powerCutOutcome({ slots: 2, stage: id }).state).toBe('safe');
  });

  it('is only dangerous with one slot, while writing', () => {
    const states = STAGES.map(({ id }) => powerCutOutcome({ slots: 1, stage: id }).state);
    expect(states).toEqual(['safe', 'bad', 'safe', 'safe']);
  });

  it('turns a stranded vehicle into a recoverable one with a recovery path', () => {
    expect(powerCutOutcome({ slots: 1, stage: 'writing', recoveryPath: true }).state).toBe('warn');
  });
});

describe('R31 the guides are general and complete', () => {
  it('gives every guide a title, summary, content, and checks', () => {
    expect(GUIDES.length).toBeGreaterThanOrEqual(5);
    for (const guide of GUIDES) {
      expect(guide.title && guide.summary).toBeTruthy();
      expect(guide.blocks.length).toBeGreaterThan(2);
      expect(guide.checks.length).toBeGreaterThanOrEqual(2);
      for (const check of guide.checks) expect(check.q.length && check.a.length).toBeTruthy();
    }
  });

  it('has unique ids and known block types', () => {
    expect(new Set(GUIDES.map((g) => g.id)).size).toBe(GUIDES.length);
    const known = ['p', 'h', 'note', 'table', 'list', 'ordered', 'code', 'figure', 'widget'];
    for (const block of GUIDES.flatMap((g) => g.blocks)) expect(known).toContain(block.t);
  });

  it('keeps table rows the same width as their headers', () => {
    for (const block of GUIDES.flatMap((g) => g.blocks).filter((b) => b.t === 'table')) {
      for (const row of block.rows) expect(row).toHaveLength(block.head.length);
    }
  });

  it('links glossary terms only to guides that exist', () => {
    const ids = GUIDES.map((g) => g.id);
    const linked = GLOSSARY.filter((e) => e.guide);
    expect(linked.length).toBeGreaterThan(25);
    for (const entry of linked) expect(ids).toContain(entry.guide);
  });

  it('covers the vocabulary the guides teach', () => {
    for (const term of ['A/B partitions', 'Bootloader', 'DBC file', 'CAN frame', 'Broker', 'QoS', 'Signal catalog']) {
      expect(searchGlossary(term).map((e) => e.term)).toContain(term);
    }
  });

  it('uses every glossary category', () => {
    for (const category of CATEGORIES) expect(GLOSSARY.some((e) => e.category === category)).toBe(true);
  });
});
