-- Домашна аптечка: база данни за Supabase
-- Поставете целия файл в Supabase → SQL Editor → New query и натиснете Run.
-- Файлът може да се пуска повторно без да се губят данни.

create extension if not exists pgcrypto;

-- ---------- Таблици ----------

create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  invite_code text not null unique,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

-- Всеки потребител е член на най-много едно семейство.
create table if not exists public.family_members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  family_id    uuid not null references public.families (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 60),
  joined_at    timestamptz not null default now()
);
create index if not exists family_members_family_idx on public.family_members (family_id);

create table if not exists public.medicines (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  expiry      date not null,
  photo_path  text,
  added_by    text not null default '' check (char_length(added_by) <= 60),
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists medicines_family_idx on public.medicines (family_id);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists medicines_touch on public.medicines;
create trigger medicines_touch before update on public.medicines
  for each row execute function public.touch_updated_at();

-- ---------- Помощни функции ----------

create or replace function public.my_family_id() returns uuid
language sql stable security definer set search_path = public as $$
  select family_id from public.family_members where user_id = auth.uid()
$$;

create or replace function public.is_family_member(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.family_members where family_id = fid and user_id = auth.uid())
$$;

-- Снимките се пазят като "<family_id>/<файл>.jpg"
create or replace function public.can_access_photo(object_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  folder text := split_part(object_name, '/', 1);
begin
  if folder !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_family_member(folder::uuid);
end $$;

-- Код за покана: 6 знака без лесни за объркване (0/O, 1/I/L)
create or replace function public.new_invite_code() returns text
language plpgsql volatile set search_path = public, extensions as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  bytes bytea;
begin
  loop
    bytes := gen_random_bytes(6);
    code := '';
    for i in 0..5 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % length(alphabet)), 1);
    end loop;
    exit when not exists (select 1 from public.families where invite_code = code);
  end loop;
  return code;
end $$;

-- ---------- Действия, извиквани от приложението ----------

create or replace function public.create_family(p_name text, p_display_name text)
returns public.families
language plpgsql security definer set search_path = public as $$
declare
  fam public.families;
begin
  if auth.uid() is null then
    raise exception 'Не сте влезли в профила си';
  end if;
  if exists (select 1 from public.family_members where user_id = auth.uid()) then
    raise exception 'Вече сте член на семейство';
  end if;
  insert into public.families (name, invite_code, created_by)
    values (coalesce(nullif(trim(p_name), ''), 'Нашето семейство'), public.new_invite_code(), auth.uid())
    returning * into fam;
  insert into public.family_members (user_id, family_id, display_name)
    values (auth.uid(), fam.id, left(coalesce(trim(p_display_name), ''), 60));
  return fam;
end $$;

create or replace function public.join_family(p_code text, p_display_name text)
returns public.families
language plpgsql security definer set search_path = public as $$
declare
  fam public.families;
begin
  if auth.uid() is null then
    raise exception 'Не сте влезли в профила си';
  end if;
  if exists (select 1 from public.family_members where user_id = auth.uid()) then
    raise exception 'Вече сте член на семейство';
  end if;
  select * into fam from public.families where invite_code = upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
  if not found then
    raise exception 'Няма семейство с такъв код';
  end if;
  insert into public.family_members (user_id, family_id, display_name)
    values (auth.uid(), fam.id, left(coalesce(trim(p_display_name), ''), 60));
  return fam;
end $$;

create or replace function public.leave_family() returns void
language sql security definer set search_path = public as $$
  delete from public.family_members where user_id = auth.uid();
$$;

revoke execute on function public.create_family(text, text), public.join_family(text, text), public.leave_family() from public, anon;
grant execute on function public.create_family(text, text), public.join_family(text, text), public.leave_family() to authenticated;

-- ---------- Правила за достъп (всеки вижда само своето семейство) ----------

alter table public.families enable row level security;
alter table public.family_members enable row level security;
alter table public.medicines enable row level security;

drop policy if exists "members read family" on public.families;
create policy "members read family" on public.families
  for select to authenticated using (public.is_family_member(id));

drop policy if exists "members read members" on public.family_members;
create policy "members read members" on public.family_members
  for select to authenticated using (public.is_family_member(family_id));

drop policy if exists "members update own name" on public.family_members;
create policy "members update own name" on public.family_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and family_id = public.my_family_id());

drop policy if exists "members manage medicines" on public.medicines;
create policy "members manage medicines" on public.medicines
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

grant select on public.families to authenticated;
grant select, update (display_name) on public.family_members to authenticated;
grant select, insert, update, delete on public.medicines to authenticated;

-- ---------- Снимки ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('medicine-photos', 'medicine-photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "family photos read" on storage.objects;
create policy "family photos read" on storage.objects
  for select to authenticated using (bucket_id = 'medicine-photos' and public.can_access_photo(name));

drop policy if exists "family photos insert" on storage.objects;
create policy "family photos insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'medicine-photos' and public.can_access_photo(name));

drop policy if exists "family photos update" on storage.objects;
create policy "family photos update" on storage.objects
  for update to authenticated using (bucket_id = 'medicine-photos' and public.can_access_photo(name));

drop policy if exists "family photos delete" on storage.objects;
create policy "family photos delete" on storage.objects
  for delete to authenticated using (bucket_id = 'medicine-photos' and public.can_access_photo(name));

-- ---------- Обновяване на живо между телефоните ----------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'medicines'
  ) then
    alter publication supabase_realtime add table public.medicines;
  end if;
end $$;
