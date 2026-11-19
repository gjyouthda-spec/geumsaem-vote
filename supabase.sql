-- =====================================================================
-- 금샘런웨이페스타 투표 시스템 - Supabase 설정 SQL
-- 사용법: Supabase 대시보드 > SQL Editor > New query 에 전체 붙여넣고 [Run]
-- 여러 번 실행해도 안전합니다 (기존 투표 데이터는 지워지지 않음)
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 테이블 ----------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  admin_pw_hash text not null
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  code text not null,
  sort_order int not null default 0,
  status text not null default 'waiting' check (status in ('waiting','open','closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.votes (
  id bigint generated always as identity primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  voter_type text not null check (voter_type in ('team','resident')),
  voter_key text not null,
  creativity int not null check (creativity between 0 and 50),
  expression int not null check (expression between 0 and 50),
  created_at timestamptz not null default now(),
  unique (team_id, voter_type, voter_key)
);

-- 테이블 직접 접근은 전부 막고, 아래 함수로만 읽고 쓰게 합니다.
alter table public.settings enable row level security;
alter table public.teams    enable row level security;
alter table public.votes    enable row level security;
revoke all on table public.settings, public.teams, public.votes from anon, authenticated;

-- 초기 관리자 비밀번호: geumsaem2026  (관리자 화면에서 꼭 바꿔 주세요)
insert into public.settings (id, admin_pw_hash)
values (1, extensions.crypt('geumsaem2026', extensions.gen_salt('bf')))
on conflict (id) do nothing;

-- ---------- 내부 함수 ----------
create or replace function public._check_admin(p_pw text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if p_pw is null or not exists (
    select 1 from settings where id = 1 and admin_pw_hash = crypt(p_pw, admin_pw_hash)
  ) then
    raise exception 'unauthorized';
  end if;
end $$;

create or replace function public._team_id(p_name text, p_code text)
returns uuid language sql stable security definer
set search_path = public as $$
  select id from teams where name = trim(p_name) and code = trim(p_code);
$$;

revoke all on function public._check_admin(text) from public, anon, authenticated;
revoke all on function public._team_id(text, text) from public, anon, authenticated;

-- ---------- 공개 함수 (누구나) ----------
-- 팀 목록과 투표 진행 상태 (점수·코드는 포함하지 않음)
create or replace function public.get_state()
returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(json_build_object(
           'id', id, 'name', name, 'status', status, 'sort', sort_order)
           order by sort_order, created_at), '[]'::json)
  from teams;
$$;

-- 주민: 이 기기가 이미 투표한 팀 id 목록
create or replace function public.resident_my_votes(p_device text)
returns json language sql stable security definer
set search_path = public as $$
  select coalesce(json_agg(team_id), '[]'::json)
  from votes where voter_type = 'resident' and voter_key = p_device;
$$;

-- 주민 투표
create or replace function public.resident_vote(p_team uuid, p_device text, p_c int, p_e int)
returns text language plpgsql security definer
set search_path = public as $$
declare v_status text;
begin
  if p_device is null or length(p_device) < 8 or length(p_device) > 100 then return 'invalid'; end if;
  if p_c is null or p_e is null or p_c not between 0 and 50 or p_e not between 0 and 50 then return 'invalid'; end if;
  select status into v_status from teams where id = p_team;
  if v_status is null then return 'no_team'; end if;
  if v_status <> 'open' then return 'closed'; end if;
  insert into votes (team_id, voter_type, voter_key, creativity, expression)
  values (p_team, 'resident', p_device, p_c, p_e)
  on conflict (team_id, voter_type, voter_key) do nothing;
  if not found then return 'already'; end if;
  return 'ok';
end $$;

-- 참가팀 로그인
create or replace function public.team_login(p_name text, p_code text)
returns json language plpgsql stable security definer
set search_path = public as $$
declare v_id uuid;
begin
  v_id := _team_id(p_name, p_code);
  if v_id is null then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'id', v_id, 'name', trim(p_name),
    'voted', (select coalesce(json_agg(team_id), '[]'::json) from votes
              where voter_type = 'team' and voter_key = v_id::text));
end $$;

-- 참가팀 투표 (자기 팀 불가)
create or replace function public.team_vote(p_name text, p_code text, p_target uuid, p_c int, p_e int)
returns text language plpgsql security definer
set search_path = public as $$
declare v_me uuid; v_status text;
begin
  v_me := _team_id(p_name, p_code);
  if v_me is null then return 'auth'; end if;
  if v_me = p_target then return 'self'; end if;
  if p_c is null or p_e is null or p_c not between 0 and 50 or p_e not between 0 and 50 then return 'invalid'; end if;
  select status into v_status from teams where id = p_target;
  if v_status is null then return 'no_team'; end if;
  if v_status <> 'open' then return 'closed'; end if;
  insert into votes (team_id, voter_type, voter_key, creativity, expression)
  values (p_target, 'team', v_me::text, p_c, p_e)
  on conflict (team_id, voter_type, voter_key) do nothing;
  if not found then return 'already'; end if;
  return 'ok';
end $$;

-- ---------- 관리자 함수 (비밀번호 필요) ----------
create or replace function public.admin_login(p_pw text)
returns boolean language plpgsql stable security definer
set search_path = public, extensions as $$
begin
  return exists (select 1 from settings where id = 1 and admin_pw_hash = crypt(p_pw, admin_pw_hash));
end $$;

create or replace function public.admin_change_pw(p_pw text, p_new text)
returns boolean language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform _check_admin(p_pw);
  if p_new is null or length(p_new) < 6 then raise exception 'too_short'; end if;
  update settings set admin_pw_hash = crypt(p_new, gen_salt('bf')) where id = 1;
  return true;
end $$;

create or replace function public.admin_add_team(p_pw text, p_name text)
returns json language plpgsql security definer
set search_path = public as $$
declare v_code text; v_sort int; v_id uuid;
begin
  perform _check_admin(p_pw);
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'empty_name'; end if;
  if exists (select 1 from teams where name = trim(p_name)) then raise exception 'duplicate_name'; end if;
  v_code := lpad((floor(random() * 10000))::int::text, 4, '0');
  select coalesce(max(sort_order), 0) + 1 into v_sort from teams;
  insert into teams (name, code, sort_order) values (trim(p_name), v_code, v_sort) returning id into v_id;
  return json_build_object('id', v_id, 'name', trim(p_name), 'code', v_code);
end $$;

create or replace function public.admin_rename_team(p_pw text, p_id uuid, p_name text)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'empty_name'; end if;
  if exists (select 1 from teams where name = trim(p_name) and id <> p_id) then raise exception 'duplicate_name'; end if;
  update teams set name = trim(p_name) where id = p_id;
  return true;
end $$;

create or replace function public.admin_delete_team(p_pw text, p_id uuid)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  delete from teams where id = p_id;
  return true;
end $$;

-- 순서 저장: 배열 순서대로 1,2,3...
create or replace function public.admin_set_order(p_pw text, p_ids uuid[])
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  update teams t set sort_order = x.ord
  from unnest(p_ids) with ordinality as x(id, ord)
  where t.id = x.id;
  return true;
end $$;

-- 상태 변경. 'open'으로 바꾸면 다른 진행 중인 팀은 자동으로 마감됩니다.
create or replace function public.admin_set_status(p_pw text, p_id uuid, p_status text)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  if p_status not in ('waiting','open','closed') then raise exception 'bad_status'; end if;
  if p_status = 'open' then
    update teams set status = 'closed' where status = 'open' and id <> p_id;
  end if;
  update teams set status = p_status where id = p_id;
  return true;
end $$;

-- 팀 목록 + 코드 + 투표 수 (관리자용)
create or replace function public.admin_teams(p_pw text)
returns json language plpgsql stable security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  return (
    select coalesce(json_agg(json_build_object(
      'id', t.id, 'name', t.name, 'code', t.code, 'status', t.status, 'sort', t.sort_order,
      'team_count', (select count(*) from votes v where v.team_id = t.id and v.voter_type = 'team'),
      'res_count',  (select count(*) from votes v where v.team_id = t.id and v.voter_type = 'resident'),
      'team_voted', (select count(*) from votes v where v.voter_type = 'team' and v.voter_key = t.id::text)
    ) order by t.sort_order, t.created_at), '[]'::json)
    from teams t
  );
end $$;

-- 결과 집계: 참가팀 평균×0.7 + 주민 평균×0.3 (각 평균은 100점 만점 기준)
create or replace function public.admin_results(p_pw text)
returns json language plpgsql stable security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  return (
    select coalesce(json_agg(r order by r.final desc, r.team_avg desc nulls last, r.sort), '[]'::json)
    from (
      select t.id, t.name, t.sort_order as sort, t.status,
        count(v.id) filter (where v.voter_type = 'team')     as team_count,
        count(v.id) filter (where v.voter_type = 'resident') as res_count,
        round(avg(v.creativity + v.expression) filter (where v.voter_type = 'team'), 2)     as team_avg,
        round(avg(v.creativity + v.expression) filter (where v.voter_type = 'resident'), 2) as res_avg,
        round(avg(v.creativity) filter (where v.voter_type = 'team'), 2)     as team_c,
        round(avg(v.expression) filter (where v.voter_type = 'team'), 2)     as team_e,
        round(avg(v.creativity) filter (where v.voter_type = 'resident'), 2) as res_c,
        round(avg(v.expression) filter (where v.voter_type = 'resident'), 2) as res_e,
        round(
          coalesce(avg(v.creativity + v.expression) filter (where v.voter_type = 'team'), 0) * 0.7
        + coalesce(avg(v.creativity + v.expression) filter (where v.voter_type = 'resident'), 0) * 0.3
        , 2) as final
      from teams t
      left join votes v on v.team_id = t.id
      group by t.id
    ) r
  );
end $$;

-- 리허설 후 투표만 전부 삭제 (팀은 유지, 상태는 '대기'로)
create or replace function public.admin_reset_votes(p_pw text)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  delete from votes where true;
  update teams set status = 'waiting' where true;
  return true;
end $$;

-- 종이 투표 수기 입력 (데이터가 안 터지는 관객용). 마감된 팀에도 입력 가능
create or replace function public.admin_add_paper_vote(p_pw text, p_team uuid, p_c int, p_e int)
returns boolean language plpgsql security definer
set search_path = public as $$
begin
  perform _check_admin(p_pw);
  if p_c is null or p_e is null or p_c not between 0 and 50 or p_e not between 0 and 50 then raise exception 'bad_score'; end if;
  insert into votes (team_id, voter_type, voter_key, creativity, expression)
  values (p_team, 'resident', 'paper-' || gen_random_uuid()::text, p_c, p_e);
  return true;
end $$;

-- ---------- 실행 권한 ----------
grant execute on function
  public.get_state(), public.resident_my_votes(text), public.resident_vote(uuid, text, int, int),
  public.team_login(text, text), public.team_vote(text, text, uuid, int, int),
  public.admin_login(text), public.admin_change_pw(text, text), public.admin_add_team(text, text),
  public.admin_rename_team(text, uuid, text), public.admin_delete_team(text, uuid),
  public.admin_set_order(text, uuid[]), public.admin_set_status(text, uuid, text),
  public.admin_teams(text), public.admin_results(text), public.admin_reset_votes(text),
  public.admin_add_paper_vote(text, uuid, int, int)
to anon, authenticated;
