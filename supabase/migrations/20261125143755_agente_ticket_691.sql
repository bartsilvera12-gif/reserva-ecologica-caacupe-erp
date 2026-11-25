-- Cambios de estructura aplicados por el Agente IA (ticket #691, reserva-ecologica-caacupe-erp). Ya están en la base.

-- Auditoría de cambios de medio de pago en ventas
create table if not exists reservacaacupe.ventas_cambios_pago (id uuid primary key default gen_random_uuid(), empresa_id uuid not null, venta_id uuid not null, usuario_id uuid, usuario_nombre text, metodo_anterior text, metodo_nuevo text not null, tarjeta_tipo_anterior text, tarjeta_tipo_nuevo text, cuenta_id_nueva uuid, motivo text not null, created_at timestamptz not null default now());
grant INSERT, DELETE, UPDATE, SELECT on "reservacaacupe".ventas_cambios_pago to anon;
grant INSERT, SELECT, UPDATE, DELETE on "reservacaacupe".ventas_cambios_pago to authenticated;
grant DELETE, INSERT, SELECT, UPDATE on "reservacaacupe".ventas_cambios_pago to authenticator;
grant DELETE, UPDATE, SELECT, INSERT, REFERENCES, TRIGGER, TRUNCATE on "reservacaacupe".ventas_cambios_pago to service_role;
alter table "reservacaacupe".ventas_cambios_pago enable row level security;
create policy ventas_cambios_pago_delete_1 on "reservacaacupe".ventas_cambios_pago for delete to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy ventas_cambios_pago_insert_2 on "reservacaacupe".ventas_cambios_pago for insert to public with check (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy ventas_cambios_pago_select_3 on "reservacaacupe".ventas_cambios_pago for select to public using (reservacaacupe.puede_acceder_empresa(empresa_id));
create policy ventas_cambios_pago_update_4 on "reservacaacupe".ventas_cambios_pago for update to public using (reservacaacupe.puede_acceder_empresa(empresa_id)) with check (reservacaacupe.puede_acceder_empresa(empresa_id));
