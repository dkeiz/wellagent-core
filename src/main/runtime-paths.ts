import path = require('path');
const { resolveProjectPath } = require('./runtime-root');
const { DEFAULT_USER_ID, normalizeUserId } = require('./user-scope');

export interface RuntimePathOptions {
  [key: string]: any;
  agentinRoot?: string;
  app?: any;
  bundledAgentinRoot?: string;
  dataRoot?: string;
  dbPath?: string;
  userDataPath?: string | null;
}

export interface RuntimePaths {
  [key: string]: any;
  agentinRoot: string;
  bundledAgentinRoot: string;
  dataRoot: string;
  databasePath: string;
  userRoot: string;
  rendererPath: string;
  promptBasePath: string;
  promptTemplatesDir: string;
  sessionWorkspaceBase: string;
  knowledgeBaseDir: string;
  agentBasePath: string;
  connectorsDir: string;
  pluginsDir: string;
  memoryBasePath: string;
  workflowBasePath: string;
  researchBasePath: string;
  subtaskBasePath: string;
  a2aBaseDir: string;
  a2aTargetsDir: string;
  a2aTasksDir: string;
  a2aEventsDir: string;
  tasksBasePath: string;
  tasksQueueFile: string;
  uiBasePath: string;
  typefacesFile: string;
  userDataPath: string | null;
  userProfilePath: string;
  backgroundNotifyPromptPath: string;
  backgroundDaemonBasePath: string;
  coldStartTemplatePath: string;
}

export interface ScopedMutableRuntimePaths {
  agentinRoot: string;
  mutableRoot: string;
  userId: string;
  connectorsDir: string;
  knowledgeBaseDir: string;
  memoryBasePath: string;
  researchBasePath: string;
  userProfilePath: string;
}

function resolveDataRoot(options: RuntimePathOptions = {}): string {
  return path.resolve(options.dataRoot || options.userDataPath || resolveProjectPath(__dirname, 'data'));
}

function resolveBundledAgentinRoot(options: RuntimePathOptions = {}): string {
  return path.resolve(options.bundledAgentinRoot || resolveProjectPath(__dirname, 'agentin'));
}

function resolveDefaultAgentinRoot(options: RuntimePathOptions = {}): string {
  return path.resolve(options.agentinRoot || resolveBundledAgentinRoot(options));
}

function resolveScopedUserId(options: RuntimePathOptions = {}): string {
  return normalizeUserId(
    options.userId || options.user_id || options.requestContext?.userId || options.requestContext?.user_id,
    DEFAULT_USER_ID
  );
}

export function sanitizeScopedUserFolder(userId: string = DEFAULT_USER_ID): string {
  return normalizeUserId(userId).toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || DEFAULT_USER_ID;
}

export function resolveScopedMutableRootPath(agentinRoot: string, options: RuntimePathOptions = {}): string {
  const userId = resolveScopedUserId(options);
  return userId === DEFAULT_USER_ID
    ? agentinRoot
    : path.join(agentinRoot, 'users', sanitizeScopedUserFolder(userId));
}

export function buildScopedMutableRuntimePaths(options: RuntimePathOptions = {}): ScopedMutableRuntimePaths {
  const base = buildRuntimePaths(options);
  const mutableRoot = resolveScopedMutableRootPath(base.agentinRoot, options);
  return {
    agentinRoot: base.agentinRoot,
    mutableRoot,
    userId: resolveScopedUserId(options),
    connectorsDir: options.connectorsDir || base.connectorsDir,
    knowledgeBaseDir: options.knowledgeBaseDir || base.knowledgeBaseDir,
    memoryBasePath: options.memoryBasePath || path.join(mutableRoot, 'memory'),
    researchBasePath: options.researchBasePath || path.join(mutableRoot, 'research'),
    userProfilePath: options.userProfilePath || path.join(mutableRoot, 'userabout', 'memoryaboutuser.md')
  };
}

export function buildRuntimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const bundledAgentinRoot = resolveBundledAgentinRoot(options);
  const agentinRoot = resolveDefaultAgentinRoot(options);
  const dataRoot = resolveDataRoot(options);
  const userRoot = resolveScopedMutableRootPath(agentinRoot, options);
  const promptBasePath = options.promptBasePath || path.join(agentinRoot, 'prompts');
  const promptTemplatesDir = options.promptTemplatesDir || path.join(promptBasePath, 'templates');
  const a2aBaseDir = options.a2aBaseDir || path.join(userRoot, 'a2a');
  const tasksBasePath = options.tasksBasePath || path.join(userRoot, 'tasks');
  const uiBasePath = options.uiBasePath || path.join(agentinRoot, 'ui');
  const agentBasePath = options.agentBasePath || path.join(agentinRoot, 'agents');
  return {
    agentinRoot,
    bundledAgentinRoot,
    dataRoot,
    databasePath: path.resolve(options.dbPath || path.join(dataRoot, 'localagent.db')),
    userRoot,
    rendererPath: options.rendererPath || path.join(__dirname, '../renderer/index.html'),
    promptBasePath,
    promptTemplatesDir,
    sessionWorkspaceBase: options.sessionWorkspaceBase || path.join(userRoot, 'workspaces'),
    knowledgeBaseDir: options.knowledgeBaseDir || path.join(agentinRoot, 'knowledge'),
    agentBasePath,
    connectorsDir: options.connectorsDir || path.join(agentinRoot, 'connectors'),
    pluginsDir: options.pluginsDir || path.join(agentinRoot, 'plugins'),
    memoryBasePath: options.memoryBasePath || path.join(userRoot, 'memory'),
    workflowBasePath: options.workflowBasePath || path.join(agentinRoot, 'workflows'),
    researchBasePath: options.researchBasePath || path.join(userRoot, 'research'),
    subtaskBasePath: options.subtaskBasePath || path.join(userRoot, 'subtasks'),
    a2aBaseDir,
    a2aTargetsDir: options.a2aTargetsDir || path.join(agentinRoot, 'a2a', 'targets'),
    a2aTasksDir: options.a2aTasksDir || path.join(a2aBaseDir, 'tasks'),
    a2aEventsDir: options.a2aEventsDir || path.join(a2aBaseDir, 'events'),
    tasksBasePath,
    tasksQueueFile: options.tasksQueueFile || path.join(tasksBasePath, 'tasks.md'),
    uiBasePath,
    typefacesFile: options.typefacesFile || path.join(uiBasePath, 'typefaces.json'),
    userDataPath: dataRoot,
    userProfilePath: options.userProfilePath || path.join(userRoot, 'userabout', 'memoryaboutuser.md'),
    backgroundNotifyPromptPath: options.backgroundNotifyPromptPath || path.join(promptTemplatesDir, 'background-notify.md'),
    backgroundDaemonBasePath: options.backgroundDaemonBasePath || path.join(agentBasePath, 'pro', 'background-daemon'),
    coldStartTemplatePath: options.coldStartTemplatePath || path.join(promptTemplatesDir, 'cold-start-discovery.md')
  };
}
