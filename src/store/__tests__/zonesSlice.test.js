import reducer, {
  setStats,
  setStatsDegraded,
  updateZoneStat,
} from '../zonesSlice';

describe('zonesSlice stats replacement and degraded state', () => {
  test('setStats replaces the full stats map and prunes omitted zones', () => {
    let state = reducer(undefined, setStats([
      { zone_id: 'zone-a', cars_staged: 2 },
      { zone_id: 'zone-b', cars_staged: 4 },
    ]));

    state = reducer(state, setStats([
      { zone_id: 'zone-a', cars_staged: 1 },
    ]));

    expect(state.stats).toEqual({
      'zone-a': { zone_id: 'zone-a', cars_staged: 1 },
    });
  });

  test('statsDegraded marks legacy fallback and clears after live data returns', () => {
    let state = reducer(undefined, setStatsDegraded(true));
    expect(state.statsDegraded).toBe(true);

    state = reducer(state, setStatsDegraded(false));
    expect(state.statsDegraded).toBe(false);
  });

  test('updateZoneStat still preserves live staged counts for lean realtime rows', () => {
    let state = reducer(undefined, setStats([
      {
        zone_id: 'zone-a',
        cars_staged: 3,
        nearby_unconfirmed: 1,
        wait_status: 'HIGH',
      },
    ]));

    state = reducer(state, updateZoneStat({
      zone_id: 'zone-a',
      flow_rate_per_hour: 5,
    }));

    expect(state.stats['zone-a']).toEqual(
      expect.objectContaining({
        cars_staged: 3,
        nearby_unconfirmed: 1,
        flow_rate_per_hour: 5,
      })
    );
  });
});
