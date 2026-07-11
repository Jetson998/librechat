import { Dropdown, Icon } from '@clickhouse/click-ui';
import { PrincipalType } from 'librechat-data-provider';

import type { ComponentProps } from 'react';
import type { ConfigValue } from './config';

export type IconName = ComponentProps<typeof Icon>['name'];
export type MenuIconName = ComponentProps<typeof Dropdown.Item>['icon'];

export interface ConfigScope {
  _id?: string;
  principalType: PrincipalType;
  principalId: string;
  name: string;
  priority: number;
  memberCount?: number;
  isActive: boolean;
}

export type ScopeSelection = { type: 'BASE' } | { type: 'SCOPE'; scope: ConfigScope };

export interface FieldProfileValue {
  scope: ConfigScope;
  value: NonNullable<ConfigValue>;
}

export interface ScopePermissions {
  canView: boolean;
  canEdit: boolean;
  /** Whether the user can create/delete scopes and manage profile values.
   *  Requires ASSIGN_CONFIGS or MANAGE_CONFIGS. Falls back to `canEdit` when
   *  not explicitly provided, preserving backwards compatibility. */
  canAssign?: boolean;
}

/** Principal types that can have config scopes (excludes PUBLIC). */
export type ScopePrincipalType = PrincipalType.ROLE | PrincipalType.GROUP | PrincipalType.USER;

export interface ScopeTypeConfigEntry {
  icon: IconName;
  color: string;
  labelKey: string;
  badgeClass: string;
}
