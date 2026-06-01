-- ============================================================
-- 013_finalize_visit_classification.sql
-- Closes the cross-table consistency window from Phase 2.1.
--
-- Background: at zone exit the app wrote the visit's classification to TWO
-- tables with two separate network calls:
--   1. trajectories.ai_classification / ai_confidence  (persistTrajectorySafe)
--   2. zone_visits.classification / confidence_score   (saveClassificationSafe)
-- If one succeeded and the other failed (transient error / partial offline),
-- the tables were momentarily out of sync until an offline replay caught up.
--
-- This migration adds ONE transactional RPC that performs both writes in a
-- single transaction, so the two tables can never diverge. Non-destructive:
-- CREATE OR REPLACE + GRANT only; no tables or old migrations are touched.
--
-- Security model matches 012: SECURITY DEFINER + search_path pinned, and the
-- caller must own the visit (service_role bypasses the ownership check).
-- ============================================================

CREATE OR REPLACE FUNCTION finalize_visit_classification(
  p_visit_id        uuid,
  p_gps_points      jsonb,
  p_features        jsonb,
  p_classification  text,
  p_confidence      double precision
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_service boolean := coalesce(auth.jwt() ->> 'role', '') = 'service_role';
  v_owner      uuid;
BEGIN
  -- Ownership: only the visit's own driver (or service_role) may finalize it.
  SELECT driver_id INTO v_owner FROM zone_visits WHERE id = p_visit_id;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Unknown visit %', p_visit_id;
  END IF;
  IF v_owner IS DISTINCT FROM auth.uid() AND NOT v_is_service THEN
    RAISE EXCEPTION 'Cannot finalize a visit for another driver';
  END IF;

  -- Both writes happen in this single function's transaction → atomic. The
  -- trajectories row owns ai_classification/ai_confidence; zone_visits owns
  -- classification/confidence_score. They are written together or not at all.
  INSERT INTO trajectories (
    visit_id, gps_points, features, ai_classification, ai_confidence
  ) VALUES (
    p_visit_id, p_gps_points, p_features, p_classification, p_confidence
  )
  ON CONFLICT (visit_id) DO UPDATE SET
    gps_points        = EXCLUDED.gps_points,
    features          = EXCLUDED.features,
    ai_classification = EXCLUDED.ai_classification,
    ai_confidence     = EXCLUDED.ai_confidence;

  UPDATE zone_visits
  SET classification   = p_classification,
      confidence_score = p_confidence
  WHERE id = p_visit_id;
END;
$$;

GRANT EXECUTE ON FUNCTION finalize_visit_classification(uuid, jsonb, jsonb, text, double precision) TO authenticated;
