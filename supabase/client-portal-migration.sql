-- Ejecuta este archivo UNA vez en Supabase > SQL Editor.
-- Extiende el sistema existente para cuentas de clientes y clases grupales.
-- Después de esta migración, ejecuta supabase/security-hardening-migration.sql
-- para aplicar permisos mínimos y reservas atómicas.

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
    'cliente'::public.user_role
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Clases creadas por personal y reservas de clientes.
create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Clase de Pilates',
  color text not null default 'azul' check (color in ('azul', 'rojo', 'verde', 'amarillo', 'naranja', 'morado', 'rosa', 'cafe', 'gris')),
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

create policy "Usuarios autenticados consultan clases" on public.class_sessions
  for select to authenticated using (true);
create policy "Clientes consultan sus reservas" on public.class_bookings
  for select to authenticated using (client_auth_id = auth.uid() or public.is_staff());

drop function if exists public.class_has_space(uuid);

-- Los clientes no pueden consultar la colección global de expedientes/pagos.
drop policy if exists "Usuarios autenticados consultan datos" on public.app_collections;
drop policy if exists "Personal actualiza datos excepto planes" on public.app_collections;
create policy "Solo personal consulta datos globales" on public.app_collections
  for select to authenticated using (public.is_staff());
create policy "Personal inserta datos permitidos" on public.app_collections
  for insert to authenticated
  with check (
    (key = 'plans' and public.is_admin())
    or (key in ('clients', 'payments', 'history') and public.is_staff())
  );
create policy "Personal actualiza datos permitidos" on public.app_collections
  for update to authenticated
  using (
    (key = 'plans' and public.is_admin())
    or (key in ('clients', 'payments', 'history') and public.is_staff())
  )
  with check (
    (key = 'plans' and public.is_admin())
    or (key in ('clients', 'payments', 'history') and public.is_staff())
  );
