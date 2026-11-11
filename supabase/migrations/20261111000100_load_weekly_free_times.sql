-- The made-up weekly free times the agent has offered since the first version
-- (moved here from FREE_SLOT_PATTERN in src/lib/clinic.ts). 30 minutes each, clinic time (Dubai).
-- weekday: 0 = Sunday ... 6 = Saturday.

insert into public.weekly_free_times (weekday, start_time, duration_minutes) values
  (6, '10:00', 30), -- Saturday
  (6, '15:30', 30), -- Saturday
  (0, '09:30', 30), -- Sunday
  (0, '18:00', 30), -- Sunday
  (1, '11:00', 30), -- Monday
  (2, '14:00', 30), -- Tuesday
  (3, '10:30', 30), -- Wednesday
  (3, '19:00', 30), -- Wednesday
  (4, '17:30', 30), -- Thursday
  (5, '17:00', 30); -- Friday
