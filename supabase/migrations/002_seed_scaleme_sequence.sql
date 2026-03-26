-- Seed: ScaleMe 3-Step Cold Outreach Sequence

INSERT INTO public.sequences (id, name, description, goal, status)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'ScaleMe 3-Step Cold Outreach',
  'Initial cold email sequence targeting US business owners and founders who could benefit from affordable offshore team members to handle manual work and scale operations.',
  'Book discovery calls with US business owners interested in scaling their team affordably',
  'active'
);

-- Step 1: Initial outreach (send immediately on enrollment)
INSERT INTO public.sequence_steps (sequence_id, step_number, delay_days, subject_template, body_template)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  1,
  0,
  'Quick question about scaling {{company}}',
  E'Hi {{first_name}},\n\nI came across {{company}} and noticed you''re growing fast — congrats on that.\n\nI''m reaching out because a lot of companies like yours are hitting a wall when it comes to hiring for the roles that keep the engine running — data entry, admin, customer support, bookkeeping, etc.\n\nAt ScaleMe, we help US businesses add skilled, full-time offshore team members at a fraction of the cost of domestic hires. Think $10-15/hr all-in for people who are trained, managed, and ready to contribute from day one.\n\nWould it make sense to hop on a quick 15-min call this week to see if this could help {{company}} scale faster?\n\nBest,\n{{sender_name}}'
);

-- Step 2: Follow-up (3 days after step 1)
INSERT INTO public.sequence_steps (sequence_id, step_number, delay_days, subject_template, body_template)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  2,
  3,
  'Re: Quick question about scaling {{company}}',
  E'Hi {{first_name}},\n\nJust bumping this to the top of your inbox — I know things get busy.\n\nThe reason I reached out is that most of our clients save 60-70% on labor costs while getting the same (or better) output. One founder I spoke with last month freed up 20+ hours a week by offloading their ops work to a ScaleMe team member.\n\nIf that sounds interesting, I''d love to share how it works in a quick call. No pressure either way.\n\nWorth a chat?\n\n{{sender_name}}'
);

-- Step 3: Break-up email (4 days after step 2, 7 days total)
INSERT INTO public.sequence_steps (sequence_id, step_number, delay_days, subject_template, body_template)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  3,
  4,
  'Last note from me, {{first_name}}',
  E'Hi {{first_name}},\n\nI don''t want to be that person who keeps following up, so this will be my last email.\n\nIf scaling {{company}} with affordable, high-quality team members ever becomes a priority, just reply to this thread and I''ll pick it right back up.\n\nWishing you and the team all the best.\n\n{{sender_name}}'
);
