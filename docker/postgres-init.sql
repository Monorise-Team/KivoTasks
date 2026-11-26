-- Baza kivo_tasks i jej role (ADR-0037, ADR-0096), tak jak w MonoriseCore i AvenMail:
-- - kivo_tasks_owner jest właścicielem tabel i uruchamia migracje,
-- - kivo_tasks_app to rola aplikacji: nie jest właścicielem tabel i nie ma BYPASSRLS, więc RLS obowiązuje ją zawsze.
-- Hasła tylko do pracy lokalnej i CI; na serwerze role i hasła zakłada infrastruktura.
CREATE ROLE kivo_tasks_owner LOGIN PASSWORD 'kivo_tasks_owner';
CREATE ROLE kivo_tasks_app LOGIN PASSWORD 'kivo_tasks_app';
CREATE DATABASE kivo_tasks OWNER kivo_tasks_owner;
-- Osobna baza testów lokalnych, żeby testy nie mieszały danych z pracą w przeglądarce
CREATE DATABASE kivo_tasks_test OWNER kivo_tasks_owner;
