import { definePermissions, type PermissionKeyOf } from "@monorise-team/permissions";

/**
 * Uprawnienia KivoTasks deklarowane w kodzie produktu (ADR-0036, ADR-0103, karta produktu KivoTasks).
 * Manifest i gotowe role są rejestrowane w MonoriseCore poleceniem `pnpm permissions:register`.
 * Zespół w KivoTasks odpowiada jednostce organizacyjnej Core (zakres `UNIT` lub `ORGANIZATION`).
 */
export const KIVOTASKS_PERMISSIONS = definePermissions("kivotasks", {
  "issues.read": "Podgląd zadań w dostępnych zespołach i projektach",
  "issues.write": "Tworzenie i edycja zadań w dostępnych zespołach",
  "teams.manage": "Ustawienia zespołów: klucze, statusy i etykiety",
  "projects.manage": "Tworzenie i zarządzanie projektami",
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
    key: "kivotasks.member",
    name: "Członek KivoTasks",
    description: "Przegląda, tworzy i edytuje zadania we własnych zespołach",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"], KIVOTASKS_PERMISSIONS.keys["issues.write"]],
  },
  {
    key: "kivotasks.admin",
    name: "Administrator KivoTasks",
    description: "Zarządza zespołami, obiegami statusów, etykietami, projektami oraz zadaniami",
    permissions: [
      KIVOTASKS_PERMISSIONS.keys["issues.read"],
      KIVOTASKS_PERMISSIONS.keys["issues.write"],
      KIVOTASKS_PERMISSIONS.keys["teams.manage"],
      KIVOTASKS_PERMISSIONS.keys["projects.manage"],
    ],
  },
  {
    key: "kivotasks.guest",
    name: "Gość",
    description: "Przegląda zadania w udostępnionych projektach",
    permissions: [KIVOTASKS_PERMISSIONS.keys["issues.read"]],
  },
] as const satisfies readonly KivotasksRoleTemplate[];
