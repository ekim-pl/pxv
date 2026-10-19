import { parseCurrentSimCards } from '../../packages/adapters/src/simcards-inspection.js';
import { afterEach, describe, expect, it, vi } from '../test-api.js';
import {
  AndroidAdapter,
  collectSimCards,
  inspectSimCards,
  normalizePhoneNumber,
  sameSimCards,
} from '@pxv/adapters';
import { device } from '../contracts/fixtures.js';
import { firstNumber, mockCollectionAndroid, secondNumber, subscriptions } from './collection-fixture.js';

const target = { device, transport: device.transports[0]! };
const android = () =>
  new AndroidAdapter({ runner: { run: () => Promise.reject(new Error('Unexpected process')) } });
afterEach(() => vi.restoreAllMocks());

describe('current SIM phone numbers', () => {
  it('reads multiple active physical/eSIM lines and excludes historical numbers', () => {
    const parsed = parseCurrentSimCards(subscriptions());
    expect(parsed).toEqual({
      known: true,
      lines: [
        { subscriptionId: 1, slotIndex: 0, number: firstNumber },
        { subscriptionId: 2, slotIndex: 1, number: secondNumber },
      ],
    });
    expect(normalizePhoneNumber('+48 (111) 222-333')).toBe(firstNumber);
    for (const value of ['unknown', '[hash]', '***123', 'null', '+'])
      expect(normalizePhoneNumber(value)).toBeUndefined();
  });
  it('distinguishes no SIM, masked numbers, unsupported dumps and ambiguous subscriptions', () => {
    expect(parseCurrentSimCards('Active subscriptions:\nAll subscriptions:\nold data')).toEqual({
      known: true,
      lines: [],
    });
    expect(parseCurrentSimCards('Permission denied')).toEqual({ known: false, lines: [] });
    expect(parseCurrentSimCards(subscriptions('[hash]')).lines[0]?.number).toBeUndefined();
    expect(() => parseCurrentSimCards(subscriptions().replace('id=2', 'id=1'))).toThrow('ambiguous');
    expect(parseCurrentSimCards(subscriptions().replace('id=1', 'id=999999999999999999999')).known).toBe(
      false,
    );
    expect(
      parseCurrentSimCards(
        subscriptions().replace(']\n  [SubscriptionInfoInternal:', '] [SubscriptionInfoInternal:'),
      ).known,
    ).toBe(false);
    const before = parseCurrentSimCards(subscriptions());
    expect(sameSimCards(before, parseCurrentSimCards(subscriptions().replace('id=2', 'id=4')))).toBe(false);
  });
  it('offers manual entry for unreadable lines and keeps explicit skips', async () => {
    const { state } = mockCollectionAndroid('simcards');
    state.subscriptions = subscriptions('[hash]', '');
    const manual = vi.fn((slot?: number) => Promise.resolve(slot === 0 ? firstNumber : undefined));
    const result = await collectSimCards(android(), target, { lease: {}, manual });
    expect(result.numbers).toEqual([firstNumber]);
    expect(result.outcomes.map((entry) => entry.status)).toEqual(['collected', 'skipped']);
    expect(manual.mock.calls.map((entry) => entry[0])).toEqual([0, 1]);
  });
  it('does not prompt without SIMs and supports private entry on unsupported inspection', async () => {
    const { state } = mockCollectionAndroid('simcards');
    state.subscriptions = 'Active subscriptions:\nAll subscriptions:\n';
    const manual = vi.fn(() => Promise.resolve(firstNumber + '\n' + secondNumber));
    const absent = await collectSimCards(android(), target, { lease: {}, manual });
    expect(absent.outcomes[0]?.status).toBe('not-present');
    expect(manual).not.toHaveBeenCalled();
    state.subscriptions = 'Unknown format';
    const entered = await collectSimCards(android(), target, { lease: {}, manual });
    expect(entered.numbers).toEqual([firstNumber, secondNumber]);
    const unavailable = await collectSimCards(android(), target, {
      lease: {},
      manual: () => Promise.resolve(undefined),
    });
    expect(unavailable.outcomes[0]?.status).toBe('unavailable');
  });
});

it('uses private fallback when telephony access is denied without exposing raw diagnostics', async () => {
  const simulation = mockCollectionAndroid('simcards');
  simulation.shell.mockRejectedValueOnce(new Error(firstNumber));
  expect(await inspectSimCards(android(), target)).toEqual({ known: false, lines: [] });
});
