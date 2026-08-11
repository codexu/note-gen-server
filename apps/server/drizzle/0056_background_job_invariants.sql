ALTER TABLE "background_jobs"
  ADD CONSTRAINT "background_jobs_payload_version_check" CHECK ("payload_version" > 0),
  ADD CONSTRAINT "background_jobs_queue_generation_check" CHECK ("queue_generation" > 0),
  ADD CONSTRAINT "background_jobs_min_handler_version_check" CHECK ("min_handler_version" > 0),
  ADD CONSTRAINT "background_jobs_attempt_check" CHECK ("attempt" >= 0),
  ADD CONSTRAINT "background_jobs_max_attempts_check" CHECK ("max_attempts" > 0);
