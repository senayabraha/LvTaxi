import { isFixAcceptableForPresence } from '../presenceGate';
import { MAX_PRESENCE_ACCURACY_METERS } from '../constants';

describe('isFixAcceptableForPresence', () => {
  test('good accuracy, not mocked → accepted', () => {
    expect(isFixAcceptableForPresence({ accuracy: 12, mocked: false })).toEqual({
      ok: true,
      reason: 'ok',
    });
  });

  test('accuracy exactly at the ceiling → accepted', () => {
    const r = isFixAcceptableForPresence({ accuracy: MAX_PRESENCE_ACCURACY_METERS });
    expect(r.ok).toBe(true);
  });

  test('accuracy worse than the ceiling → rejected', () => {
    const r = isFixAcceptableForPresence({ accuracy: MAX_PRESENCE_ACCURACY_METERS + 1 });
    expect(r).toEqual({ ok: false, reason: 'accuracy_too_low' });
  });

  test('mocked location → rejected even with perfect accuracy', () => {
    expect(isFixAcceptableForPresence({ accuracy: 3, mocked: true })).toEqual({
      ok: false,
      reason: 'mocked_location',
    });
  });

  test('unknown accuracy (null/undefined) → not rejected (server backstop)', () => {
    expect(isFixAcceptableForPresence({ accuracy: null }).ok).toBe(true);
    expect(isFixAcceptableForPresence({}).ok).toBe(true);
  });

  test('negative sentinel accuracy → treated as unknown, not rejected', () => {
    expect(isFixAcceptableForPresence({ accuracy: -1 }).ok).toBe(true);
  });

  test('per-zone tighter ceiling is honoured', () => {
    expect(isFixAcceptableForPresence({ accuracy: 30 }, 20).ok).toBe(false);
    expect(isFixAcceptableForPresence({ accuracy: 15 }, 20).ok).toBe(true);
  });
});
