import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorbellDebounce } from './doorbellDebounce';

test('ring isolé légitime déclenche HomeKit', () => {
  const debounce = new DoorbellDebounce(2000);
  assert.equal(debounce.shouldTrigger(1_000), true);
});

test('un second ring sous le seuil est filtré', () => {
  const debounce = new DoorbellDebounce(2000);
  assert.equal(debounce.shouldTrigger(1_000), true);
  assert.equal(debounce.shouldTrigger(1_000 + 500), false);
});

test('deux rings espacés au-delà du seuil déclenchent tous les deux', () => {
  const debounce = new DoorbellDebounce(2000);
  assert.equal(debounce.shouldTrigger(1_000), true);
  assert.equal(debounce.shouldTrigger(1_000 + 2_001), true);
});

test('un ring exactement au seuil est accepté (intervalle inclusif)', () => {
  const debounce = new DoorbellDebounce(2000);
  assert.equal(debounce.shouldTrigger(1_000), true);
  assert.equal(debounce.shouldTrigger(1_000 + 2_000), true);
});

test('un seuil à 0 désactive le debounce (tout ring passe)', () => {
  const debounce = new DoorbellDebounce(0);
  assert.equal(debounce.shouldTrigger(1_000), true);
  assert.equal(debounce.shouldTrigger(1_000), true);
});

test("un ring filtré ne réarme pas le cooldown (l'horloge reste ancrée sur le dernier accepté)", () => {
  const debounce = new DoorbellDebounce(2000);
  assert.equal(debounce.shouldTrigger(1_000), true);
  assert.equal(debounce.shouldTrigger(1_500), false); // filtré, n'avance pas lastTriggerAt
  assert.equal(debounce.shouldTrigger(2_500), false); // 2500-1000=1500 < 2000 : toujours filtré
  assert.equal(debounce.shouldTrigger(3_001), true); // 3001-1000=2001 >= 2000 : repasse
});
