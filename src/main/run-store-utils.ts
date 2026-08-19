// @ts-nocheck
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function initRunBase(basePath, subDirs = []) {
  ensureDir(basePath);
  for (const subDir of subDirs) {
    ensureDir(path.join(basePath, subDir));
  }
}

function generateRunId(prefix = 'run') {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function appendJsonLine(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function appendTraceSection(tracePath, title, body) {
  fs.appendFileSync(tracePath, `## ${title}\n\n${body}\n\n`, 'utf-8');
}

function writeTraceFile(tracePath, lines = []) {
  fs.writeFileSync(tracePath, `${lines.join('\n')}\n`, 'utf-8');
}

function listRunDirectories(runsPath) {
  if (!fs.existsSync(runsPath)) {
    return [];
  }
  return fs.readdirSync(runsPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
}

module.exports = {
  appendJsonLine,
  appendTraceSection,
  ensureDir,
  generateRunId,
  initRunBase,
  listRunDirectories,
  readJson,
  writeJson,
  writeTraceFile
};
