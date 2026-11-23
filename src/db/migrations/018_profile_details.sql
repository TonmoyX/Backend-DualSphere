-- Optional "About" details shown in the profile Intro: work, education, location, hobbies
ALTER TABLE users
  ADD COLUMN work      text NOT NULL DEFAULT '' CHECK (char_length(work) <= 100),
  ADD COLUMN education text NOT NULL DEFAULT '' CHECK (char_length(education) <= 100),
  ADD COLUMN location  text NOT NULL DEFAULT '' CHECK (char_length(location) <= 100),
  ADD COLUMN hobbies   text[] NOT NULL DEFAULT '{}' CHECK (cardinality(hobbies) <= 10);
