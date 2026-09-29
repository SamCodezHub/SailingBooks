-- Sailing Books cloud library: run once in the Supabase SQL editor.
-- The Vercel service role performs account-level quota reservations; browser
-- clients can only upload into a matching, unexpired reservation.

create extension if not exists pgcrypto;

create table if not exists public.cloud_books (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  author text,
  file_name text not null,
  book_type text not null check (book_type in ('epub', 'pdf', 'audio')),
  size_bytes bigint not null check (size_bytes > 0),
  storage_path text not null unique,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now()
);
create index if not exists cloud_books_user_status_idx on public.cloud_books(user_id, status, created_at desc);
alter table public.cloud_books enable row level security;
drop policy if exists "Users can read their cloud books" on public.cloud_books;
create policy "Users can read their cloud books" on public.cloud_books
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users can delete their cloud books" on public.cloud_books;
revoke insert, update, delete on public.cloud_books from anon, authenticated;
grant select on public.cloud_books to authenticated;

create table if not exists public.cloud_servers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  base_url text not null,
  credential_hash text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cloud_servers_user_idx on public.cloud_servers(user_id, created_at desc);
alter table public.cloud_servers enable row level security;
drop policy if exists "Users can read their servers" on public.cloud_servers;
create policy "Users can read their servers" on public.cloud_servers
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.cloud_servers from anon, authenticated;

create table if not exists public.server_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  server_id uuid not null references public.cloud_servers(id) on delete cascade,
  book_id uuid not null references public.cloud_books(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'complete', 'failed')),
  result_message text not null default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists server_jobs_poll_idx on public.server_jobs(server_id, status, created_at);
alter table public.server_jobs enable row level security;
drop policy if exists "Users can read their server jobs" on public.server_jobs;
create policy "Users can read their server jobs" on public.server_jobs
  for select to authenticated using (auth.uid() = user_id);
revoke all on public.server_jobs from anon, authenticated;

-- The Vercel API verifies the signed-in user in Auth, then accesses these
-- private tables with the server-only Supabase secret/service_role key.
grant usage on schema public to service_role;
grant all privileges on table public.cloud_books, public.cloud_servers, public.server_jobs to service_role;

create or replace function public.reserve_online_book_upload(
  p_user_id uuid, p_book_id uuid, p_file_name text, p_book_type text,
  p_size_bytes bigint, p_storage_path text, p_quota_bytes bigint
) returns public.cloud_books
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  used_bytes bigint;
  new_book public.cloud_books;
begin
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 2147483648 then
    raise exception 'The selected file size is not supported' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  delete from public.cloud_books
    where user_id = p_user_id and status = 'pending' and created_at < now() - interval '24 hours';
  select coalesce(sum(size_bytes), 0) into used_bytes
    from public.cloud_books
    where user_id = p_user_id and (status = 'ready' or (status = 'pending' and created_at >= now() - interval '24 hours'));
  if p_quota_bytes is not null and used_bytes + p_size_bytes > p_quota_bytes then
    raise exception 'This upload would exceed the 1 GB account limit' using errcode = '23514';
  end if;
  insert into public.cloud_books(id, user_id, file_name, book_type, size_bytes, storage_path)
    values (p_book_id, p_user_id, left(p_file_name, 180), p_book_type, p_size_bytes, p_storage_path)
    returning * into new_book;
  return new_book;
end;
$$;
revoke all on function public.reserve_online_book_upload(uuid,uuid,text,text,bigint,text,bigint) from public, anon, authenticated;
grant execute on function public.reserve_online_book_upload(uuid,uuid,text,text,bigint,text,bigint) to service_role;

create or replace function public.complete_online_book_upload(p_user_id uuid, p_book_id uuid)
returns boolean language plpgsql security definer set search_path = public, storage, pg_temp as $$
declare
  item public.cloud_books;
  actual_size bigint;
begin
  select * into item from public.cloud_books
    where id = p_book_id and user_id = p_user_id and status = 'pending' for update;
  if not found then return false; end if;
  select nullif(metadata->>'size', '')::bigint into actual_size
    from storage.objects where bucket_id = 'sailing-books' and name = item.storage_path;
  if actual_size is null or actual_size < 1 or actual_size > item.size_bytes then return false; end if;
  update public.cloud_books set status = 'ready', size_bytes = actual_size where id = p_book_id;
  return true;
end;
$$;
revoke all on function public.complete_online_book_upload(uuid,uuid) from public, anon, authenticated;
grant execute on function public.complete_online_book_upload(uuid,uuid) to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'sailing-books', 'sailing-books', false, 2147483648,
  array['application/epub+zip','application/pdf','audio/mpeg','audio/mp4','audio/wav','audio/ogg','audio/flac','audio/aac','application/octet-stream']
)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Reserved cloud book uploads" on storage.objects;
create policy "Reserved cloud book uploads" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'sailing-books'
    and name like auth.uid()::text || '/%'
    and exists (
      select 1 from public.cloud_books b
      where b.user_id = auth.uid() and b.storage_path = name and b.status = 'pending'
        and b.created_at >= now() - interval '24 hours'
        and coalesce(nullif(metadata->>'size', '')::bigint, 0) <= b.size_bytes
    )
  );
drop policy if exists "Users can remove their cloud book files" on storage.objects;
create policy "Users can remove their cloud book files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'sailing-books'
    and exists (select 1 from public.cloud_books b where b.user_id = auth.uid() and b.storage_path = name)
  );
