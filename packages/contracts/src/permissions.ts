import { definePermissions, type PermissionKeyOf } from "@monorise-team/permissions";

/**
 * Uprawnienia KivoTasks deklarowane w kodzie produktu (ADR-0036, karta produktu KivoTasks).
 * Manifest i gotowe role są rejestrowane w MonoriseCore poleceniem `pnpm permissions:register`.
 */
export const KIVOTASKS_PERMISSIONS = definePermissions("kivotasks", {
  "entries.read_own": "Odczyt własnych wpisów czasu pracy",
  "entries.write_own": "Rejestracja własnego czasu pracy",
  "entries.read": "Podgląd wpisów czasu pracy pracowników w zakresie uprawnień",
  "entries.approve": "Zatwierdzanie i odrzucanie poprawek wpisów czasu pracy",
  "leave.approve": "Zatwierdzanie i odrzucanie wniosków urlopowych",
  "reports.export": "Eksport raportów czasu pracy",
});

export const KIVOTASKS_PERMISSION_MANIFEST = KIVOTASKS_PERMISSIONS.manifest;

export type KivotasksPermissionKey = PermissionKeyOf<typeof KIVOTASKS_PERMISSIONS>;

export interface KivotasksRoleTemplate {
  readonly key: `kivotasks.${string}`;
  readonly name: string;
  readonly description: string;
  readonly permissions: readonly [KivotasksPermissionKey, ...KivotasksPermissionKey[]];
}

/**
 * Gotowe role (szablony) KivoTasks wysyłane do MonoriseCore zaraz po manifeście uprawnień (ADR-0033, ADR-0036).
 */
export const KIVOTASKS_ROLE_TEMPLATES = [
  {
    key: "kivotasks.employee",
    name: "Pracownik",
    description: "Rejestruje i przegląda własny czas pracy",
    permissions: [KIVOTASKS_PERMISSIONS.keys["entries.read_own"], KIVOTASKS_PERMISSIONS.keys["entries.write_own"]],
  },
  {
    key: "kivotasks.manager",
    name: "Kierownik",
    description: "Przegląda i zatwierdza czas pracy, urlopy i raporty zespołu w swoim zakresie",
    permissions: [
      KIVOTASKS_PERMISSIONS.keys["entries.read_own"],
      KIVOTASKS_PERMISSIONS.keys["entries.write_own"],
      KIVOTASKS_PERMISSIONS.keys["entries.read"],
      KIVOTASKS_PERMISSIONS.keys["entries.approve"],
      KIVOTASKS_PERMISSIONS.keys["leave.approve"],
      KIVOTASKS_PERMISSIONS.keys["reports.export"],
    ],
  },
] as const satisfies readonly KivotasksRoleTemplate[];
