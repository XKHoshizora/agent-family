-- Up Migration
-- Memory's sizes are measured in weight (ceil(utf-8 bytes / 3), memory/weight.ts), no longer in code points: a room of 3000 weight
-- holds 9000 one-byte characters, and a model's entry of 200 weight is up to 600. The columns' checks stay as coarse guards,
-- widened to what the limits can now allow: a character weighs at least a third, so a text within a room's limit is within
-- 3 x the limit characters. (A note is never more than its room, 3000: 9000 characters; hearsay is a model's entry: 600.)
alter table owner_notes drop constraint owner_notes_text_check, add constraint owner_notes_text_check check (char_length(text) between 1 and 9000);
alter table agent_notes drop constraint agent_notes_text_check, add constraint agent_notes_text_check check (char_length(text) between 1 and 9000);
alter table agent_hearsay drop constraint agent_hearsay_text_check, add constraint agent_hearsay_text_check check (char_length(text) between 1 and 600);

-- Down Migration
alter table agent_hearsay drop constraint agent_hearsay_text_check, add constraint agent_hearsay_text_check check (char_length(text) between 1 and 200) not valid;
alter table agent_notes drop constraint agent_notes_text_check, add constraint agent_notes_text_check check (char_length(text) between 1 and 3000) not valid;
alter table owner_notes drop constraint owner_notes_text_check, add constraint owner_notes_text_check check (char_length(text) between 1 and 3000) not valid;
