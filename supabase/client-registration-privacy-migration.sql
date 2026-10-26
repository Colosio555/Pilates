-- Ejecuta esta migración después de client-portal-migration.sql y
-- security-hardening-migration.sql en Supabase > SQL Editor.
-- Registra cuentas creadas por clientes, consentimiento y fecha en una sola
-- transacción de Auth. Las cuentas creadas por el personal no cambian.

create table if not exists public.privacy_consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  terms_version text not null,
  accepted_at timestamptz not null default now(),
  source text not null default 'self_registration',
  primary key (user_id, terms_version)
);

alter table public.privacy_consents enable row level security;
revoke all on table public.privacy_consents from public, anon, authenticated;

create or replace function public.register_self_service_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  registration jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  first_name text := pg_catalog.btrim(coalesce(registration ->> 'first_name', ''));
  paternal_name text := pg_catalog.btrim(coalesce(registration ->> 'paternal_name', ''));
  maternal_name text := pg_catalog.btrim(coalesce(registration ->> 'maternal_name', ''));
  phone_number text := pg_catalog.btrim(coalesce(registration ->> 'phone', ''));
  accepted_version text := coalesce(registration ->> 'terms_version', '');
  client_record jsonb;
  changed_rows integer;
begin
  -- Las cuentas creadas antes por el personal o por administración no llevan
  -- estos metadatos y se conservan sin cambios.
  if accepted_version = '' and coalesce(registration ->> 'terms_accepted', '') = '' then
    return new;
  end if;

  if accepted_version <> '2026-10-25-v1'
     or coalesce(registration ->> 'terms_accepted', '') <> 'true' then
    raise exception 'La aceptación vigente del aviso de privacidad es obligatoria.';
  end if;

  if new.email is null
     or pg_catalog.length(first_name) < 2 or pg_catalog.length(first_name) > 80
     or pg_catalog.length(paternal_name) < 2 or pg_catalog.length(paternal_name) > 80
     or pg_catalog.length(maternal_name) < 2 or pg_catalog.length(maternal_name) > 80
     or phone_number !~ '^[0-9+() .-]{7,25}$' then
    raise exception 'Los datos de registro no cumplen el formato requerido.';
  end if;

  client_record := pg_catalog.jsonb_build_object(
    'id', new.id::text,
    'authUserId', new.id::text,
    'codigoUsuario', '',
    'nombre', first_name,
    'apellidoPaterno', paternal_name,
    'apellidoMaterno', maternal_name,
    'contacto', phone_number,
    'cumpleanos', '',
    'planId', '',
    'paquete', 'Sin plan',
    'clasesContratadas', 0,
    'clasesRestantes', 0,
    'fechaContratacion', '',
    'fechaVencimiento', '',
    'pagos', '[]'::jsonb,
    'asistencias', '[]'::jsonb,
    'citas', '[]'::jsonb,
    'notas', ''
  );

  insert into public.app_collections as current_collection (key, payload)
  values ('clients', pg_catalog.jsonb_build_array(client_record))
  on conflict (key) do update
    set payload = current_collection.payload || excluded.payload,
        updated_at = pg_catalog.now()
    where pg_catalog.jsonb_typeof(current_collection.payload) = 'array';

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception 'No fue posible crear el expediente del cliente.';
  end if;

  insert into public.privacy_consents (user_id, terms_version, accepted_at, source)
  values (new.id, accepted_version, pg_catalog.now(), 'self_registration');

  return new;
end;
$$;

revoke all on function public.register_self_service_client() from public, anon, authenticated;

drop trigger if exists on_auth_user_register_client on auth.users;
create trigger on_auth_user_register_client
  after insert on auth.users
  for each row execute function public.register_self_service_client();
