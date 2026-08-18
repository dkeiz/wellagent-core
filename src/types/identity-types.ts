export type UserRole = 'owner' | 'member' | 'guest';

export interface UserIdentity {
  userId: string;
  role: UserRole;
  username?: string;
  displayName?: string;
}

export interface LocalProfile {
  userId: string;
  displayName: string;
  userRoot: string;
  isDefault?: boolean;
  status?: 'active' | 'archived';
  createdAt?: string;
  lastUsedAt?: string;
  archivedAt?: string | null;
}
