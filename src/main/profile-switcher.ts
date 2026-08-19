import type { LocalProfile } from '../../shared/types';
import {
  createProfileRegistry,
  type ProfileOverrides,
  type ProfileRegistry,
  type ProfileRegistryOptions
} from './profile-registry';

export interface ProfileSwitcherOptions extends ProfileRegistryOptions {
  [key: string]: any;
  profileRegistry?: ProfileRegistry | null;
}

export interface ProfileSwitcher {
  getActiveProfile: () => LocalProfile;
  listProfiles: () => LocalProfile[];
  registry: ProfileRegistry;
  resolveProfile: (userId?: string | null, overrides?: ProfileOverrides) => LocalProfile;
  selectProfile: (userId: string, overrides?: ProfileOverrides) => LocalProfile;
}

export interface BootstrapProfileOptions extends ProfileSwitcherOptions {
  args?: string[];
  agentinRoot?: string;
  dbPath?: string;
  userId?: string | null;
  profileSwitcher?: ProfileSwitcher | null;
}

export interface BootstrapProfileResolution {
  agentinRoot: string;
  dbPath?: string;
  profile: LocalProfile;
  userId: string;
  profileRegistry: ProfileRegistry;
  profileSwitcher: ProfileSwitcher;
  userDataPath: string;
}

export function getRequestedProfileIdFromArgs(args: string[] = []): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (value.startsWith('--profile=')) return value.slice('--profile='.length).trim() || null;
    if (value === '--profile') return String(args[index + 1] || '').trim() || null;
  }
  return null;
}

export function createProfileSwitcher(options: ProfileSwitcherOptions = {}): ProfileSwitcher {
  const registry = options.profileRegistry || createProfileRegistry(options);
  return {
    registry,
    getActiveProfile: () => registry.getActiveProfile(),
    listProfiles: () => registry.listProfiles(),
    resolveProfile(userId: string | null = null, overrides: ProfileOverrides = {}) {
      return userId ? registry.ensureProfile(userId, overrides) : registry.getActiveProfile();
    },
    selectProfile: (userId: string, overrides: ProfileOverrides = {}) => registry.setActiveProfile(userId, overrides)
  };
}

// Compatibility for explicit --profile callers. Normal startup no longer calls this.
export function resolveBootstrapProfile(options: BootstrapProfileOptions = {}): BootstrapProfileResolution {
  const profileSwitcher = options.profileSwitcher || createProfileSwitcher(options);
  const requestedUserId = String(options.userId || getRequestedProfileIdFromArgs(options.args || []) || '').trim() || null;
  const profile = requestedUserId
    ? profileSwitcher.selectProfile(requestedUserId)
    : profileSwitcher.getActiveProfile();
  return {
    agentinRoot: String(options.agentinRoot || '').trim(),
    dbPath: options.dbPath,
    profile,
    userId: profile.userId,
    profileRegistry: profileSwitcher.registry,
    profileSwitcher,
    userDataPath: profileSwitcher.registry.getUserDataPath()
  };
}
