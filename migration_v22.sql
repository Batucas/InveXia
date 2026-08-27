-- ============================================================
--  InveXia · migración v22
--  Arreglo: "new row violates row-level security policy" al subir
--  la foto de perfil en el onboarding.
--
--  Causa: el bucket 'media' no tenía una política que permitiera
--  a los usuarios (clientes) subir archivos. Esta migración lo
--  habilita para cualquier usuario autenticado.
--
--  Ejecutar en Supabase → SQL Editor.
-- ============================================================

-- Subir archivos al bucket 'media' (avatares, entregas de cursos, etc.)
drop policy if exists "media insert authenticated" on storage.objects;
create policy "media insert authenticated"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'media');

-- Actualizar / borrar lo que cada quien subió
drop policy if exists "media update own" on storage.objects;
create policy "media update own"
  on storage.objects for update to authenticated
  using (bucket_id = 'media' and owner = auth.uid());

drop policy if exists "media delete own" on storage.objects;
create policy "media delete own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'media' and owner = auth.uid());
