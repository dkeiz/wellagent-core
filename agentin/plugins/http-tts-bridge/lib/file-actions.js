'use strict';

const fs = require('fs');
const path = require('path');

function sanitizeFileName(fileName) {
  return String(fileName || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'file';
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function findFilesRecursive(rootDir, predicate) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const results = [];
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        pending.push(path.join(current, entry));
      }
      continue;
    }
    if (predicate(current)) {
      results.push(current);
    }
  }

  return results;
}

function newestFile(files) {
  return files
    .map(filePath => ({ filePath, stat: fs.statSync(filePath) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0]?.filePath || '';
}

function findPiperVoiceFiles(sourceDir, voiceId) {
  const modelName = `${voiceId}.onnx`;
  const configName = `${voiceId}.onnx.json`;
  const matches = findFilesRecursive(sourceDir, (filePath) => {
    const base = path.basename(filePath).toLowerCase();
    return base === modelName.toLowerCase() || base === configName.toLowerCase();
  });

  let modelPath = matches.find(filePath => path.basename(filePath).toLowerCase() === modelName.toLowerCase()) || '';
  let configPath = matches.find(filePath => path.basename(filePath).toLowerCase() === configName.toLowerCase()) || '';

  if (!modelPath) {
    const nestedModel = path.join(sourceDir, 'en', 'en_US', 'lessac', 'medium', modelName);
    if (fs.existsSync(nestedModel)) modelPath = nestedModel;
  }
  if (!configPath) {
    const nestedConfig = path.join(sourceDir, 'en', 'en_US', 'lessac', 'medium', configName);
    if (fs.existsSync(nestedConfig)) configPath = nestedConfig;
  }

  return { modelPath, configPath };
}

function importPiperAssets({ sourceDir, targetPiperDir, voiceId }) {
  const sourceRoot = String(sourceDir || '').trim();
  if (!sourceRoot) {
    throw new Error('Piper source directory is required');
  }
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`Piper source directory not found: ${sourceRoot}`);
  }

  ensureDir(targetPiperDir);
  ensureDir(path.join(targetPiperDir, 'bin'));

  const files = findPiperVoiceFiles(sourceRoot, voiceId);
  if (!files.modelPath || !files.configPath) {
    throw new Error(`Could not find Piper voice files for '${voiceId}' in ${sourceRoot}`);
  }

  const targetModelPath = path.join(targetPiperDir, `${voiceId}.onnx`);
  const targetConfigPath = path.join(targetPiperDir, `${voiceId}.onnx.json`);
  fs.copyFileSync(files.modelPath, targetModelPath);
  fs.copyFileSync(files.configPath, targetConfigPath);

  const wheelFiles = findFilesRecursive(sourceRoot, (filePath) => /piper_tts-.*\.whl$/i.test(path.basename(filePath)));
  const newestWheel = newestFile(wheelFiles);
  if (newestWheel) {
    fs.copyFileSync(newestWheel, path.join(targetPiperDir, 'bin', path.basename(newestWheel)));
  }

  const runtimeSource = path.join(sourceRoot, 'bin', 'piper_runtime');
  if (fs.existsSync(runtimeSource) && fs.statSync(runtimeSource).isDirectory()) {
    fs.cpSync(runtimeSource, path.join(targetPiperDir, 'bin', 'piper_runtime'), { recursive: true, force: true });
  }

  return {
    success: true,
    voiceId,
    targetModelPath,
    targetConfigPath,
    wheelCopied: Boolean(newestWheel),
    runtimeCopied: fs.existsSync(runtimeSource)
  };
}

function copyVoiceSourceFile({ sourceFilePath, targetVoicesDir }) {
  const sourcePath = String(sourceFilePath || '').trim();
  if (!sourcePath) {
    throw new Error('Source file path is required');
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Source audio file not found: ${sourcePath}`);
  }

  ensureDir(targetVoicesDir);
  const ext = path.extname(sourcePath) || '.wav';
  const base = sanitizeFileName(path.basename(sourcePath, ext));
  let targetName = `${base}${ext}`;
  let targetPath = path.join(targetVoicesDir, targetName);
  let suffix = 1;

  while (fs.existsSync(targetPath)) {
    targetName = `${base}_${suffix}${ext}`;
    targetPath = path.join(targetVoicesDir, targetName);
    suffix += 1;
  }

  fs.copyFileSync(sourcePath, targetPath);
  return {
    success: true,
    fileName: targetName,
    filePath: targetPath,
    sizeBytes: fs.statSync(targetPath).size
  };
}

module.exports = {
  copyVoiceSourceFile,
  importPiperAssets,
  sanitizeFileName
};
