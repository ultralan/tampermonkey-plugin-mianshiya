-- 面试鸭题库表。依赖基座仓的 002_federated.sql 创建 tampermonkey_base schema。
-- 本脚本幂等，可重复执行。

create extension if not exists pgcrypto;

create schema if not exists tampermonkey_base;

create table if not exists tampermonkey_base.questions (
  -- 站点 ID 是 19 位数字，超出 JS Number 精度（2^53），插件侧与表侧都按字符串处理。
  question_id    text primary key,
  question_no    int,
  title          text not null,
  difficulty     text,
  is_vip         boolean,
  tags           text[] not null default '{}',
  bank_ids       text[] not null default '{}',
  answer_key     text,
  extended_knowledge text,
  follow_ups     jsonb,
  content_md     text not null,
  content_hash   text not null,
  source_url     text not null,
  -- 个人笔记，由人手动维护；插件的 upsert payload 不含该列，永不覆盖。
  note           text,
  note_updated_at timestamptz,
  captured_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table tampermonkey_base.questions enable row level security;

grant usage on schema tampermonkey_base to anon, authenticated;
grant usage on schema tampermonkey_base to service_role;
grant all on all tables in schema tampermonkey_base to service_role;

-- 插件直连 upsert（Prefer: resolution=merge-duplicates）需要 select + insert + update
-- 三种权限：冲突判定与 RETURNING 都走 SELECT。
grant select, insert, update on tampermonkey_base.questions to anon;
grant select on tampermonkey_base.questions to authenticated;

drop policy if exists "questions anon select" on tampermonkey_base.questions;
create policy "questions anon select"
  on tampermonkey_base.questions
  for select
  to anon
  using (true);

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

-- 兼容早期按 bigint 建的表：ID 精度丢失问题修复后的列类型转换（幂等）。
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'tampermonkey_base'
      and table_name = 'questions'
      and column_name = 'question_id'
      and data_type = 'bigint'
  ) then
    alter table tampermonkey_base.questions
      alter column question_id type text using question_id::text,
      alter column bank_ids type text[] using bank_ids::text[];
  end if;
end $$;

-- 笔记字段（幂等）。
alter table tampermonkey_base.questions
  add column if not exists note text,
  add column if not exists note_updated_at timestamptz;
