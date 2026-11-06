import { describe, expect, it } from 'vitest';
import { ROLES, SCREENS } from '../src/core/roles.js';

const ENGINEERING = ['ota', 'vehicle', 'transfer', 'revocation', 'range', 'architecture'];

describe('R30 you start from who you are', () => {
  it('gives every persona a name and a plain summary', () => {
    for (const role of Object.values(ROLES)) {
      expect(role.label).toBeTruthy();
      expect(role.short.length).toBeLessThanOrEqual(10);
      expect(role.summary.length).toBeGreaterThan(20);
    }
  });

  it('groups every screen once, with a label', () => {
    for (const role of Object.values(ROLES)) {
      expect(new Set(role.tabs).size).toBe(role.tabs.length);
      for (const tab of role.tabs) expect(SCREENS[tab]).toBeTruthy();
      for (const group of role.groups) expect(group.label).toBeTruthy();
    }
  });

  it('keeps customer personas short and free of engineering screens', () => {
    for (const id of ['owner', 'dispatcher', 'technician']) {
      expect(ROLES[id].tabs.length).toBeLessThanOrEqual(6);
      for (const tab of ENGINEERING) expect(ROLES[id].tabs).not.toContain(tab);
    }
  });

  it('gives the engineer every screen, so nothing is unreachable', () => {
    expect([...ROLES.engineer.tabs].sort()).toEqual(Object.keys(SCREENS).sort());
  });

  it('starts the engineer on the system, not a customer screen', () => {
    expect(ROLES.engineer.tabs[0]).toBe('architecture');
  });

  it('puts Learn last, for everyone', () => {
    for (const role of Object.values(ROLES)) expect(role.tabs.at(-1)).toBe('learn');
  });

  it('gives different jobs different screens', () => {
    expect(ROLES.dispatcher.tabs).not.toContain('reports');
    expect(ROLES.technician.tabs).not.toContain('operator');
    expect(ROLES.owner.tabs).toContain('reports');
  });
});
