-- 028 / DATA-1: normalize and constrain zone_visits.classification.
--
-- Historical paths wrote mixed-case labels (for example STAGING/ABANDONED),
-- while dwell queries already compare lower(classification). Normalize existing
-- rows first, then enforce the known visit-classification vocabulary.

UPDATE zone_visits
SET classification = lower(classification)
WHERE classification IS NOT NULL
  AND classification <> lower(classification);

ALTER TABLE zone_visits
  DROP CONSTRAINT IF EXISTS zone_visits_classification_check;

ALTER TABLE zone_visits
  ADD CONSTRAINT zone_visits_classification_check
  CHECK (
    classification IS NULL
    OR lower(classification) IN (
      'staging',
      'drop_off',
      'passing',
      'unknown',
      'abandoned'
    )
  );
