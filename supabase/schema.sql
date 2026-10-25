-- Ejecuta este archivo una sola vez en Supabase: SQL Editor > New query.
create type public.user_role as enum ('admin', 'trabajador', 'cliente');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.user_role not null default 'cliente',
  created_at timestamptz not null default now()
);

create table public.app_collections (
  key text primary key check (key in ('clients', 'plans', 'payments', 'history')),
  payload jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'cliente');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

insert into public.app_collections (key, payload) values
  ('clients', '[]'),
  ('plans', '[{"id":"basico","nombre":"Básico","clases":4,"costo":700,"vigencia":30},{"id":"intensivo","nombre":"Intensivo","clases":8,"costo":1200,"vigencia":30},{"id":"ilimitado","nombre":"Ilimitado","clases":99,"costo":1800,"vigencia":30}]'),
  ('payments', '[]'),
  ('history', '[]');

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;

alter table public.profiles enable row level security;
alter table public.app_collections enable row level security;

create policy "Usuarios leen su perfil" on public.profiles
  for select to authenticated using (id = auth.uid());

create policy "Usuarios autenticados consultan datos" on public.app_collections
  for select to authenticated using (true);

create policy "Personal actualiza datos excepto planes" on public.app_collections
  for all to authenticated
  using (key <> 'plans' or public.is_admin())
  with check (key <> 'plans' or public.is_admin());

-- Las cuentas nuevas comienzan con rol cliente. Después de crear la cuenta
-- del administrador en Authentication > Users, ejecute:
-- update public.profiles set role = 'admin'
-- where id = (select id from auth.users where email = 'tu-correo@ejemplo.com');
