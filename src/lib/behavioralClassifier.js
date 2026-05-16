export const VISIT_CLASS = {
  STAGING: 'staging',
  DROP_OFF: 'drop_off',
  PASSING: 'passing',
  UNKNOWN: 'unknown',
};

const STAGING_THRESHOLD = 70;
const DROP_OFF_THRESHOLD = 20;

function isPeakStagingHour(date = new Date()) {
  const h = date.getHours();
  return (h >= 6 && h < 10) || h >= 20 || h < 2;
}

export function classifyVisit(features, driverHistory = null, now = new Date()) {
  const f = features ?? {};
  let score = 0;

  const dwell = f.dwellTime ?? 0;
  if (dwell < 90) score -= 50;
  else if (dwell < 180) score += 0;
  else if (dwell < 600) score += 40;
  else score += 60;

  const avgSpeed = f.avgSpeedInZone ?? 0;
  if (avgSpeed > 10) score -= 80;
  if (f.isStopStartPattern || (f.stopCount ?? 0) >= 2) score -= 50;
  if (avgSpeed < 3) score += 35;
  if ((f.timeStationary ?? 0) > 120) score += 30;

  if (f.exitedSameSide) score -= 40;
  if (f.movedForwardGradually || (f.forwardCreep ?? 0) > 5) score += 40;
  if (f.stoppedAtEntrance) score -= 40;
  if ((f.positionVariance ?? Infinity) < 5) score += 20;

  const entrySpeed = f.entrySpeed ?? 0;
  if (entrySpeed > 15) score -= 20;
  if ((f.entryAcceleration ?? 0) < -2) score -= 15;
  if (entrySpeed < 8) score += 20;

  const historyScore = driverHistory?.history_score ?? 0;
  score += Math.max(-25, Math.min(25, historyScore));

  if (isPeakStagingHour(now)) score += 15;

  let classification;
  if (score >= STAGING_THRESHOLD) classification = VISIT_CLASS.STAGING;
  else if (score <= DROP_OFF_THRESHOLD) {
    classification = avgSpeed > 10 ? VISIT_CLASS.PASSING : VISIT_CLASS.DROP_OFF;
  } else classification = VISIT_CLASS.UNKNOWN;

  const distanceFromThreshold =
    classification === VISIT_CLASS.STAGING
      ? score - STAGING_THRESHOLD
      : classification === VISIT_CLASS.UNKNOWN
      ? 0
      : DROP_OFF_THRESHOLD - score;
  const confidence =
    classification === VISIT_CLASS.UNKNOWN
      ? Math.max(
          5,
          Math.round(
            50 -
              (Math.min(
                STAGING_THRESHOLD - score,
                score - DROP_OFF_THRESHOLD
              ) /
                (STAGING_THRESHOLD - DROP_OFF_THRESHOLD)) *
                100
          )
        )
      : Math.max(50, Math.min(99, 50 + Math.round(distanceFromThreshold)));

  return { classification, confidence, score };
}
