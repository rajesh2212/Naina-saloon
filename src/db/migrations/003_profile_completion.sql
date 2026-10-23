-- 003_profile_completion.sql
-- The four details a customer is asked for before they can hold a chair time:
-- an age, a written address, which Block they live in, and an optional photo of
-- their own. All four are nullable, so every account that already exists keeps
-- working and simply shows as an incomplete profile until the person fills it in.
--
-- `block` is checked against the seven Blocks of Bhadrak district the studio
-- serves — the exact spellings are the ones shown in the dropdown, and a value
-- outside the list is refused by the database as well as by the form.
--
-- `photo_path` is only ever a path inside public/uploads/avatars, written by
-- src/lib/uploads.js. The image bytes stay on disk; the row holds where they are.

ALTER TABLE users ADD COLUMN age INTEGER CHECK (age IS NULL OR (age BETWEEN 1 AND 120));
ALTER TABLE users ADD COLUMN address TEXT;
ALTER TABLE users ADD COLUMN block TEXT
  CHECK (block IS NULL OR TRIM(block) = '' OR block IN (
    'Bhadrak Block',
    'Basudevpur Block',
    'Bhandaripokhari Block',
    'Bonth Block',
    'Chandabali Block',
    'Dhamnagar Block',
    'Tihidi Block'
  ));
ALTER TABLE users ADD COLUMN photo_path TEXT;
