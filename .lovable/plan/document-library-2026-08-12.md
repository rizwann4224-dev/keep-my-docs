# Document Library

Build a page where you upload documents and they stay saved permanently in the cloud.

## What you get

- Sign in / sign up with email + password
- Upload area (drag-and-drop or file picker), multiple files at once
- List of your saved documents: name, type icon, size, upload date
- Download, preview link, rename, and delete
- Search box to filter by file name
- Only you see your own files — each account's documents are private

## Two ways to add files

- In chat: attach files to a message so I can read them while building (these are not stored in the app).
- In the app: the upload page above, which keeps files permanently.

## Technical notes

- Enable Lovable Cloud for storage, auth, and database.
- Private storage bucket `documents`, objects stored under `{user_id}/{uuid}-{filename}`; downloads use signed URLs.
- Table `public.documents`: id, user_id, name, storage_path, mime_type, size_bytes, created_at. Grants for `authenticated` + `service_role`, RLS enabled, policies scoped to `auth.uid()`.
- Storage RLS on `storage.objects` restricting select/insert/update/delete to the owner's folder prefix.
- Routes: `/` = document library (redirects to `/auth` when signed out), `/auth` = sign in / sign up. Library route sits under the authenticated gate.
- Upload from the browser client directly to storage, then insert the metadata row; delete removes both object and row.
- Client-side limits: 20 MB per file, common doc/image/pdf types; friendly errors via toasts.
