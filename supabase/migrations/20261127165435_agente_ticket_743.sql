-- Cambios de estructura aplicados por el Agente IA (ticket #743, reserva-ecologica-caacupe-erp). Ya están en la base.

-- Registro de cheques emitidos y recibidos pendientes de acreditación o débito
create table if not exists reservacaacupe.cheques (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  sucursal_id uuid,
  tipo text not null check (tipo in ('recibido','emitido')),
  numero text not null,
  banco text not null,
  monto numeric not null check (monto > 0),
  fecha_prevista date not null,
  cuenta_id uuid not null,
  estado text not null default 'pendiente' check (estado in ('pendiente','acreditado','debitado','rechazado','anulado')),
  origen text,
  origen_id text,
  referencia text,
  observaciones text,
  confirmado_at timestamptz,
  confirmado_por text,
  creado_por text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant INSERT, DELETE, UPDATE, SELECT on "reservacaacupe".cheques to anon;
grant INSERT, SELECT, UPDATE, DELETE on "reservacaacupe".cheques to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on "reservacaacupe".cheques to authenticator;
grant DELETE, UPDATE, SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE on "reservacaacupe".cheques to service_role;
alter table "reservacaacupe".cheques enable row level security;
create policy cheques_delete_1 on "reservacaacupe".cheques for delete to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_insert_2 on "reservacaacupe".cheques for insert to public with check (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_select_3 on "reservacaacupe".cheques for select to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_update_4 on "reservacaacupe".cheques for update to public using (reservacaacupe.puede_acceder_empresa(empresa_id)) with check (reservacaacupe.puede_acceder_empresa(empresa_id));

-- Historial de confirmaciones de cheques con fecha y usuario
create table if not exists reservacaacupe.cheques_historial (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  cheque_id uuid not null,
  estado_anterior text,
  estado_nuevo text not null,
  motivo text,
  usuario_nombre text,
  created_at timestamptz not null default now()
);
grant INSERT, DELETE, UPDATE, SELECT on "reservacaacupe".cheques_historial to anon;
grant INSERT, SELECT, UPDATE, DELETE on "reservacaacupe".cheques_historial to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on "reservacaacupe".cheques_historial to authenticator;
grant DELETE, UPDATE, SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE on "reservacaacupe".cheques_historial to service_role;
alter table "reservacaacupe".cheques_historial enable row level security;
create policy cheques_historial_delete_1 on "reservacaacupe".cheques_historial for delete to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_historial_insert_2 on "reservacaacupe".cheques_historial for insert to public with check (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_historial_select_3 on "reservacaacupe".cheques_historial for select to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy cheques_historial_update_4 on "reservacaacupe".cheques_historial for update to public using (reservacaacupe.puede_acceder_empresa(empresa_id)) with check (reservacaacupe.puede_acceder_empresa(empresa_id));
