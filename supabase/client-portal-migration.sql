-- Ejecuta este archivo UNA vez en Supabase > SQL Editor.
-- Extiende el sistema existente para cuentas de clientes y clases grupales.

alter type public.user_role add value if not exists 'cliente';

-- El expediente vincula al usuario de Auth que puede entrar al portal.
-- El valor vive dentro del JSON existente como "authUserId" para conservar los datos actuales.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role)
  values (
    new.id,
    case when coalesce(new.raw_user_meta_data ->> 'role', '') = 'cliente'
      then 'cliente'::public.user_role
      else 'trabajador'::public.user_role
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Clases creadas por personal y reservas de clientes.
create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Clase de Pilates',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null check (capacity > 0),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.class_bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id) on delete cascade,
  client_auth_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (session_id, client_auth_id)
);

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'trabajador')) $$;

alter table public.class_sessions enable row level security;
alter table public.class_bookings enable row level security;

create policy "Personal gestiona clases" on public.class_sessions
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy "Clientes consultan clases" on public.class_sessions
  for select to authenticated using (true);
create policy "Clientes consultan sus reservas" on public.class_bookings
  for select to authenticated using (client_auth_id = auth.uid() or public.is_staff());

create or replace function public.class_has_space(target_session uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(b.id) < s.capacity
  from public.class_sessions s
  left join public.class_bookings b on b.session_id = s.id
  where s.id = target_session
  group by s.id, s.capacity
$$;

create policy "Cliente se inscribe si hay cupo" on public.class_bookings
  for insert to authenticated
  with check (client_auth_id = auth.uid() and public.class_has_space(session_id));

create policy "Cliente cancela su reserva" on public.class_bookings
  for delete to authenticated using (client_auth_id = auth.uid() or public.is_staff());

-- Los clientes no pueden consultar la colección global de expedientes/pagos.
drop policy if exists "Usuarios autenticados consultan datos" on public.app_collections;
drop policy if exists "Personal actualiza datos excepto planes" on public.app_collections;
create policy "Solo personal consulta datos globales" on public.app_collections
  for select to authenticated using (public.is_staff());
create policy "Personal actualiza datos globales" on public.app_collections
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
