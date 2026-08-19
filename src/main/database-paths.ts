import path = require('path');

export interface DbPathOptions {
  [key: string]: any;
  dataRoot?: string;
  dbPath?: string;
  profileDbPath?: string;
  userDataPath?: string | null;
}

export function resolveDbPath(options: DbPathOptions = {}): string {
  if (options.dbPath) return path.resolve(options.dbPath);
  if (options.profileDbPath) return path.resolve(options.profileDbPath);
  if (options.dataRoot) return path.join(path.resolve(options.dataRoot), 'localagent.db');
  if (options.userDataPath) return path.join(path.resolve(options.userDataPath), 'localagent.db');
  throw new Error('Database path resolution requires a path from the application runtime provider.');
}