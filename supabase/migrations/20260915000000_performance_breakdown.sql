-- Performance breakdown: one validated classification row per marked attempt + part.
--
-- Why a table: the topic/subtopic charts are arithmetic over real marks, so the
-- rows they aggregate have to be stored (and editable) rather than re-derived by
-- parsing markdown on every load. The unique index is the database half of
-- "duplicate attempt + part records are rejected" — an app bug or a second
-- device can no longer double-count one part.
CREATE TABLE public.performance_breakdown (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subject_id uuid REFERENCES public.subjects(id) ON DELETE CASCADE,
  qa_entry_id uuid REFERENCES public.qa_entries(id) ON DELETE SET NULL,
  attempt integer NOT NULL,
  part text NOT NULL DEFAULT 'whole',
  topic text NOT NULL,
  subtopic text NOT NULL,
  -- Confidence in the CLASSIFICATION (not in the candidate). 'low' rows are
  -- excluded from every percentage and shown as "Needs review".
  confidence text NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  evidence text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'not stated',
  -- Null means the marking report never stated a mark: never guessed as 0.
  awarded numeric(7,2) CHECK (awarded IS NULL OR awarded >= 0),
  available numeric(7,2) CHECK (available IS NULL OR available > 0),
  -- A mark can never be worth more than the question offered.
  CHECK (awarded IS NULL OR available IS NULL OR awarded <= available),
  weakness text NOT NULL DEFAULT 'None',
  action text NOT NULL DEFAULT 'None',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt >= 1)
);

CREATE UNIQUE INDEX performance_breakdown_attempt_part_uidx
  ON public.performance_breakdown (subject_id, attempt, lower(part));

CREATE INDEX performance_breakdown_subject_topic_idx
  ON public.performance_breakdown (subject_id, topic);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.performance_breakdown TO authenticated;
GRANT ALL ON public.performance_breakdown TO service_role;

ALTER TABLE public.performance_breakdown ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own performance breakdown"
  ON public.performance_breakdown FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own performance breakdown"
  ON public.performance_breakdown FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own performance breakdown"
  ON public.performance_breakdown FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete their own performance breakdown"
  ON public.performance_breakdown FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
