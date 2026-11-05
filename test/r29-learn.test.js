import { describe, expect, it } from 'vitest';
import { CATEGORIES, GLOSSARY, LESSONS, searchGlossary } from '../src/data/learn.js';
import { ROLES } from '../src/core/roles.js';

const TABS = ROLES.engineer.tabs;

describe('R29 the app teaches its own vocabulary', () => {
  it('has a usable glossary, with a term in every category', () => {
    expect(GLOSSARY.length).toBeGreaterThan(40);
    for (const category of CATEGORIES) expect(GLOSSARY.some((e) => e.category === category)).toBe(true);
  });

  it('gives every term a known category, a definition, and an analogy', () => {
    for (const entry of GLOSSARY) {
      expect(CATEGORIES).toContain(entry.category);
      expect(entry.definition.length).toBeGreaterThan(20);
      expect(entry.analogy.length).toBeGreaterThan(5);
    }
  });

  it('has no duplicate terms', () => {
    const terms = GLOSSARY.map((e) => e.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('only links to screens that exist', () => {
    for (const item of [...GLOSSARY, ...LESSONS]) {
      if (item.tab) expect(TABS).toContain(item.tab);
    }
  });

  it('gives every lesson what happened and what it taught', () => {
    expect(LESSONS.length).toBeGreaterThanOrEqual(10);
    for (const lesson of LESSONS) {
      expect(lesson.title).toBeTruthy();
      expect(lesson.happened.length).toBeGreaterThan(30);
      expect(lesson.lesson.length).toBeGreaterThan(20);
    }
  });

  it('lets every role learn', () => {
    for (const role of Object.values(ROLES)) expect(role.tabs).toContain('learn');
  });

  it('finds terms by name, expansion, and meaning', () => {
    expect(searchGlossary('bms').map((e) => e.term)).toContain('BMS');
    expect(searchGlossary('battery management').map((e) => e.term)).toContain('BMS');
    expect(searchGlossary('postmark').map((e) => e.term)).toContain('Event time vs. arrival time');
  });

  it('filters by category, sorts, and handles no results', () => {
    const results = searchGlossary('', 'Connectivity');
    expect(results.every((e) => e.category === 'Connectivity')).toBe(true);
    expect(results.map((e) => e.term)).toEqual([...results.map((e) => e.term)].sort((a, b) => a.localeCompare(b)));
    expect(searchGlossary('zzzzz')).toEqual([]);
  });
});
