-- Up Migration
-- All purely declarative (no triggers).

-- A principal cannot own itself.
alter table principals add constraint principals_not_self_owned check (owner_id <> id);

-- Only humans carry an auth user.
alter table principals add constraint principals_agent_has_no_auth_user check (kind = 'human' or auth_user_id is null);

-- An agent's owner must be a human principal: (owner_id, owner_kind) must match a row of
-- (id, kind), and owner_kind is generated as the constant 'human' whenever an owner is set.
-- For humans owner_id is null, so owner_kind is null and the (MATCH SIMPLE) foreign key is not applied.
alter table principals add constraint principals_id_kind_key unique (id, kind);
alter table principals
  add column owner_kind text generated always as (case when owner_id is not null then 'human' end) stored;
alter table principals drop constraint principals_owner_id_fkey;
alter table principals
  add constraint principals_owner_is_human_fk
  foreign key (owner_id, owner_kind) references principals (id, kind) on delete restrict;

-- A membership cannot end before it began.
alter table memberships add constraint memberships_left_after_joined check (left_seq is null or left_seq >= joined_seq);

-- Down Migration
alter table memberships drop constraint memberships_left_after_joined;
alter table principals drop constraint principals_owner_is_human_fk;
alter table principals drop column owner_kind;
alter table principals add constraint principals_owner_id_fkey foreign key (owner_id) references principals (id) on delete restrict;
alter table principals drop constraint principals_id_kind_key;
alter table principals drop constraint principals_agent_has_no_auth_user;
alter table principals drop constraint principals_not_self_owned;
