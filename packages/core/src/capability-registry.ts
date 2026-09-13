export type CapabilityState = 'available' | 'needs_auth' | 'disabled' | 'unavailable';

export interface CapabilityRegistration {
  tool: string;
  actions: readonly string[];
  state: CapabilityState;
  reason?: string;
}

export interface CapabilitySnapshot {
  tool: string;
  action: string;
  state: CapabilityState;
  reason?: string;
}

export interface CapabilityCheckResult {
  ok: boolean;
  state?: CapabilityState;
  reason?: string;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, CapabilitySnapshot>();

  register(registration: CapabilityRegistration): void {
    const tool = registration.tool.trim();
    if (!tool) throw new Error('Capability tool is required');
    if (registration.actions.length === 0) {
      throw new Error(`Capability registration for ${tool} has no actions`);
    }

    for (const rawAction of registration.actions) {
      const action = rawAction.trim();
      if (!action) throw new Error(`Capability action is required for ${tool}`);
      this.entries.set(key(tool, action), {
        tool,
        action,
        state: registration.state,
        ...(registration.reason ? { reason: registration.reason } : {}),
      });
    }
  }

  setState(
    tool: string,
    state: CapabilityState,
    reason?: string,
    actions?: readonly string[],
  ): void {
    const targets = actions?.length
      ? actions.map((action) => key(tool, action))
      : Array.from(this.entries.keys()).filter((entryKey) => entryKey.startsWith(`${tool}\u0000`));

    for (const target of targets) {
      const current = this.entries.get(target);
      if (!current) continue;
      this.entries.set(target, {
        ...current,
        state,
        ...(reason ? { reason } : { reason: undefined }),
      });
    }
  }

  check(tool: string, action: string): CapabilityCheckResult {
    const capability = this.entries.get(key(tool, action));
    if (!capability) {
      return {
        ok: false,
        state: 'unavailable',
        reason: `Capability not registered: ${tool}.${action}`,
      };
    }

    if (capability.state !== 'available') {
      return {
        ok: false,
        state: capability.state,
        reason: capability.reason ?? `Capability ${tool}.${action} is ${capability.state}`,
      };
    }

    return { ok: true, state: 'available' };
  }

  snapshot(): CapabilitySnapshot[] {
    return Array.from(this.entries.values())
      .map((entry) => ({ ...entry }))
      .sort((a, b) => `${a.tool}.${a.action}`.localeCompare(`${b.tool}.${b.action}`));
  }

  availableCatalog(): Record<string, string[]> {
    const catalog: Record<string, string[]> = {};
    for (const entry of this.entries.values()) {
      if (entry.state !== 'available') continue;
      (catalog[entry.tool] ??= []).push(entry.action);
    }
    for (const actions of Object.values(catalog)) actions.sort();
    return catalog;
  }

  allAllowedTools(): Set<string> {
    return new Set(Array.from(this.entries.values(), (entry) => entry.tool));
  }

  allAllowedActions(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const entry of this.entries.values()) {
      let actions = result.get(entry.tool);
      if (!actions) {
        actions = new Set<string>();
        result.set(entry.tool, actions);
      }
      actions.add(entry.action);
    }
    return result;
  }
}

function key(tool: string, action: string): string {
  return `${tool.trim()}\u0000${action.trim()}`;
}
