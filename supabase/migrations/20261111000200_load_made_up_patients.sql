-- Made-up patients and appointments, so the agent has something to work with.
-- Everything here is invented: first names only and fake phone numbers (+971 50 000 00xx).
-- All rows are marked is_synthetic = true. To remove them later:
--   delete from public.appointments where is_synthetic;
--   delete from public.patients where is_synthetic;
--
-- Appointments are at clinic time (Dubai, +04). They avoid the weekly free times on purpose,
-- so the agent still has free times to offer next to them.

insert into public.patients (full_name, phone, preferred_language, notes, is_synthetic) values
  ('Amira',   '+971500000001', 'ar', 'Made-up patient', true),
  ('Omar',    '+971500000002', 'ar', 'Made-up patient', true),
  ('Layla',   '+971500000003', 'ar', 'Made-up patient', true),
  ('Yusuf',   '+971500000004', 'ar', 'Made-up patient', true),
  ('Noor',    '+971500000005', 'en', 'Made-up patient', true),
  ('Sarah',   '+971500000006', 'en', 'Made-up patient', true),
  ('Daniel',  '+971500000007', 'en', 'Made-up patient', true),
  ('Priya',   '+971500000008', 'en', 'Made-up patient', true),
  ('Fatima',  '+971500000009', 'ar', 'Made-up patient', true),
  ('Hassan',  '+971500000010', 'ar', 'Made-up patient', true);

insert into public.appointments (patient_id, starts_at, duration_minutes, status, treatment, notes, is_synthetic)
select p.id, v.starts_at, 30, v.status::public.appointment_status, v.treatment, 'Made-up appointment', true
from (values
  ('+971500000001', timestamptz '2026-11-10 15:00+04', 'completed', 'Check-up'),
  ('+971500000002', timestamptz '2026-11-14 11:00+04', 'booked',    'Check-up'),
  ('+971500000003', timestamptz '2026-11-15 14:00+04', 'booked',    'Cleaning'),
  ('+971500000006', timestamptz '2026-11-16 16:30+04', 'booked',    'Filling'),
  ('+971500000008', timestamptz '2026-11-17 10:00+04', 'booked',    'Whitening'),
  ('+971500000010', timestamptz '2026-11-19 12:00+04', 'booked',    'Root canal')
) as v (phone, starts_at, status, treatment)
join public.patients p on p.phone = v.phone;
