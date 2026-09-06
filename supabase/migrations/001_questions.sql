-- 面试鸭题库表。依赖基座仓的 002_federated.sql 创建 tampermonkey_base schema。
-- 本脚本幂等，可重复执行。

create extension if not exists pgcrypto;

create schema if not exists tampermonkey_base;

create table if not exists tampermonkey_base.questions (
  question_id    bigint primary key,
  question_no    int,
  title          text not null,
  difficulty     text,
  is_vip         boolean,
  tags           text[] not null default '{}',
  bank_ids       bigint[] not null default '{}',
  answer_key     text,
  extended_knowledge text,
  follow_ups     jsonb,
  content_md     text not null,
  content_hash   text not null,
  source_url     text not null,
  captured_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table tampermonkey_base.questions enable row level security;

grant usage on schema tampermonkey_base to anon, authenticated;
grant usage on schema tampermonkey_base to service_role;
grant all on all tables in schema tampermonkey_base to service_role;

-- 插件直连 upsert（Prefer: resolution=merge-duplicates）需要 insert + update 两种权限。
grant insert, update on tampermonkey_base.questions to anon;
grant select on tampermonkey_base.questions to authenticated;

drop policy if exists "questions anon insert" on tampermonkey_base.questions;
create policy "questions anon insert"
  on tampermonkey_base.questions
  for insert
  to anon
  with check (true);

drop policy if exists "questions anon update" on tampermonkey_base.questions;
create policy "questions anon update"
  on tampermonkey_base.questions
  for update
  to anon
  using (true)
  with check (true);

drop policy if exists "questions authenticated read" on tampermonkey_base.questions;
create policy "questions authenticated read"
  on tampermonkey_base.questions
  for select
  to authenticated
  using (true);

create index if not exists questions_updated_idx
  on tampermonkey_base.questions (updated_at desc);

create index if not exists questions_tags_idx
  on tampermonkey_base.questions using gin (tags);

create index if not exists questions_bank_ids_idx
  on tampermonkey_base.questions using gin (bank_ids);

comment on table tampermonkey_base.questions is
  '面试鸭题库采集数据。插件进入题目详情页自动解析并 upsert，核心内容变化时覆盖。';
