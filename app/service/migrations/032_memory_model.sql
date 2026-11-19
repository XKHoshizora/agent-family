-- Up Migration
-- The model the owner chose for tidying their memory (the shape of an Agent's model choice: {source: 'site', id} or
-- {source: 'provider', providerId, model}); null is the site's memory model.
alter table accounts add column memory_model jsonb;

-- Down Migration
alter table accounts drop column memory_model;
