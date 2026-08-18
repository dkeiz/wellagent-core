// ---------------------------------------------------------------------------
// lib/tools/permissions.ts — Tool policy and approval state
// ---------------------------------------------------------------------------

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolPermission,
  SettingsStore,
  Logger,
} from '../core/types';
import { ScopedSettingsAccessor } from '../core/settings';

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  toolName: string;
}

export interface ToolPolicy {
  checkTool(
    tool: ToolDefinition,
    params: Record<string, any>,
    context: ToolExecutionContext
  ): PermissionCheckResult | Promise<PermissionCheckResult>;
}

export class ToolPermissions extends ScopedSettingsAccessor implements ToolPolicy {
  private _masterEnabled: boolean;
  private _groups: Map<string, { enabled: boolean; tools: Set<string> }>;
  private _grants: Map<string, ToolPermission>;
  private _logger: Logger;

  constructor(db: SettingsStore, options: { logger?: Logger; enabled?: boolean } = {}) {
    super(db);
    this._masterEnabled = options.enabled ?? true;
    this._groups = new Map();
    this._grants = new Map();
    this._logger = options.logger ?? console;
  }

  setMasterEnabled(enabled: boolean): void {
    this._masterEnabled = enabled;
  }

  get masterEnabled(): boolean {
    return this._masterEnabled;
  }

  defineGroup(groupId: string, tools: string[], enabled: boolean = true): void {
    this._groups.set(groupId, { enabled, tools: new Set(tools) });
  }

  setGroupEnabled(groupId: string, enabled: boolean): void {
    const group = this._groups.get(groupId);
    if (group) group.enabled = enabled;
  }

  setToolPermission(toolName: string, permission: Partial<ToolPermission>): void {
    this._grants.set(toolName, {
      toolName,
      allowed: permission.allowed ?? true,
      reason: permission.reason,
      grantedBy: permission.grantedBy,
      expiresAt: permission.expiresAt,
    });
  }

  check(toolName: string): PermissionCheckResult {
    if (!this._masterEnabled) {
      return { allowed: false, reason: 'Master switch is disabled', toolName };
    }

    const grant = this._getActiveGrant(toolName);
    if (grant) {
      return {
        allowed: grant.allowed,
        reason: grant.reason || (grant.allowed ? 'Explicitly granted' : 'Explicitly denied'),
        toolName,
      };
    }

    const group = this._findGroup(toolName);
    if (group) {
      return {
        allowed: group.value.enabled,
        reason: group.value.enabled
          ? 'Allowed via group "' + group.id + '"'
          : 'Group "' + group.id + '" is disabled',
        toolName,
      };
    }

    return { allowed: true, reason: 'No restrictions', toolName };
  }

  checkTool(
    tool: ToolDefinition,
    _params: Record<string, any>,
    _context: ToolExecutionContext
  ): PermissionCheckResult {
    const decision = this.check(tool.name);
    if (!decision.allowed) return decision;

    const needsApproval = tool.safe === false || tool.requiresConfirmation === true;
    const hasExplicitGrant = Boolean(this._getActiveGrant(tool.name));
    const hasConfiguredGroup = Boolean(this._findGroup(tool.name));
    if (needsApproval && !hasExplicitGrant && !hasConfiguredGroup) {
      return {
        allowed: false,
        reason: 'Tool "' + tool.name + '" requires an explicit policy approval',
        toolName: tool.name,
      };
    }

    return decision;
  }

  checkAll(toolNames: string[]): PermissionCheckResult[] {
    return toolNames.map(name => this.check(name));
  }

  getState(): { masterEnabled: boolean; groups: Record<string, boolean>; grants: Record<string, boolean> } {
    const groups: Record<string, boolean> = {};
    for (const [id, group] of this._groups) groups[id] = group.enabled;

    const grants: Record<string, boolean> = {};
    for (const [name, grant] of this._grants) grants[name] = grant.allowed;
    return { masterEnabled: this._masterEnabled, groups, grants };
  }

  private _getActiveGrant(toolName: string): ToolPermission | null {
    const grant = this._grants.get(toolName);
    if (!grant) return null;
    if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) {
      this._grants.delete(toolName);
      return null;
    }
    return grant;
  }

  private _findGroup(toolName: string): { id: string; value: { enabled: boolean; tools: Set<string> } } | null {
    for (const [id, group] of this._groups) {
      if (group.tools.has(toolName)) return { id, value: group };
    }
    return null;
  }
}
