const fs = require('fs');
const path = require('path');

const PLAN_FILE = 'plan.md';
let runtimeContext = null;

function emptyPlan() {
  return { phase: 'planning', goal: '', tasks: [], last_run: '', next: '' };
}

function parsePlan(content) {
  const plan = emptyPlan();
  if (!content) return plan;

  const phaseMatch = content.match(/^phase:\s*(.+)$/mi);
  if (phaseMatch) plan.phase = phaseMatch[1].trim() || 'planning';

  const goalMatch = content.match(/^goal:\s*(.+)$/mi);
  if (goalMatch) plan.goal = goalMatch[1].trim();

  const taskRe = /^\s*-\s*\[( |x|X)\]\s*(.+)$/gm;
  let match;
  while ((match = taskRe.exec(content)) !== null) {
    plan.tasks.push({ text: match[2].trim(), done: match[1].toLowerCase() === 'x' });
  }

  const lastRun = content.match(/##\s*Last Run\s*\n([\s\S]*?)(?=\n##|\n*$)/i);
  if (lastRun) plan.last_run = lastRun[1].trim();

  const next = content.match(/##\s*Next\s*\n([\s\S]*?)(?=\n##|\n*$)/i);
  if (next) plan.next = next[1].trim();

  return plan;
}

function renderPlan(plan) {
  const safe = plan || emptyPlan();
  const taskLines = (Array.isArray(safe.tasks) ? safe.tasks : [])
    .map((task) => {
      const text = typeof task === 'string' ? task : (task && task.text ? task.text : '');
      const done = task && typeof task === 'object' ? task.done === true : false;
      return `- [${done ? 'x' : ' '}] ${text}`;
    })
    .join('\n');
  return `# Coding Plan

phase: ${safe.phase || 'planning'}
goal: ${safe.goal || ''}

## Tasks
${taskLines || '- [ ] (no tasks yet)'}

## Last Run
${safe.last_run || ''}

## Next
${safe.next || ''}
`;
}

function planFilePath(params) {
  const home = params && params._agentInfo && params._agentInfo.folderPath;
  if (home) return path.join(home, 'tasks', PLAN_FILE);
  return path.join(runtimeContext ? runtimeContext.dataDir : '.', PLAN_FILE);
}

function readPlan(params) {
  const file = planFilePath(params);
  if (!fs.existsSync(file)) {
    return { exists: false, path: file, content: '', plan: emptyPlan() };
  }
  const content = fs.readFileSync(file, 'utf-8');
  return { exists: true, path: file, content, plan: parsePlan(content) };
}

function writePlan(params, plan) {
  const file = planFilePath(params);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = renderPlan(plan);
  fs.writeFileSync(file, content, 'utf-8');
  return { exists: true, path: file, content, plan };
}

function normalizeTasks(raw) {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((task) => {
    if (typeof task === 'string') return { text: task, done: false };
    if (task && typeof task === 'object') {
      return { text: String(task.text || ''), done: task.done === true };
    }
    return { text: String(task || ''), done: false };
  });
}

async function codingPlan(params, context) {
  const action = String((params && params.action) || 'status').toLowerCase().trim();

  if (action === 'status') {
    const state = readPlan(params);
    return { action, exists: state.exists, plan: state.plan, content: state.content };
  }

  if (action === 'reset') {
    const file = planFilePath(params);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    const plan = emptyPlan();
    return { action, exists: false, plan, content: renderPlan(plan) };
  }

  if (action === 'update') {
    const current = readPlan(params).plan;
    const nextPlan = {
      phase: params.phase !== undefined ? (String(params.phase || '').trim() || current.phase) : current.phase,
      goal: params.goal !== undefined ? String(params.goal || '') : current.goal,
      tasks: normalizeTasks(params.tasks) || current.tasks,
      last_run: params.last_run !== undefined ? String(params.last_run || '') : current.last_run,
      next: params.next !== undefined ? String(params.next || '') : current.next
    };
    const state = writePlan(params, nextPlan);
    return { action, exists: true, plan: nextPlan, content: state.content };
  }

  return { error: `Unknown coding_plan action "${action}". Use status, update, or reset.` };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function phaseClass(phase) {
  const normalized = String(phase || 'planning').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (normalized === 'ready_for_commit' || normalized === 'ready-for-commit' || normalized === 'done' || normalized === 'complete') return 'is-done';
  if (normalized === 'testing') return 'is-testing';
  if (normalized === 'debugging') return 'is-debugging';
  if (normalized === 'blocked') return 'is-blocked';
  return 'is-progress';
}

function readPlanForAgent(agentInfo) {
  const home = agentInfo && agentInfo.folderPath;
  if (home) {
    const file = path.join(home, 'tasks', PLAN_FILE);
    if (fs.existsSync(file)) {
      return { exists: true, plan: parsePlan(fs.readFileSync(file, 'utf-8')) };
    }
  }
  return { exists: false, plan: emptyPlan() };
}

function renderPanel(agentInfo) {
  const { exists, plan } = readPlanForAgent(agentInfo);
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const taskList = tasks.length
    ? `<ul class="coding-plan-tasks">${tasks.map((task) =>
        `<li class="${task.done ? 'is-done' : ''}">${escapeHtml(task.text)}</li>`).join('')}</ul>`
    : '<p class="coding-plan-empty">No tasks yet.</p>';

  return `<section class="coding-plan-card">
    <div class="coding-plan-head">
      <div>
        <span class="coding-plan-kicker">Coding Plan</span>
        <strong>${exists ? escapeHtml(plan.goal || 'Untitled task') : 'No active plan'}</strong>
      </div>
      <span class="coding-plan-phase ${phaseClass(plan.phase)}">${escapeHtml(plan.phase || 'planning')}</span>
    </div>
    ${taskList}
    ${plan.last_run ? `<div class="coding-plan-meta"><span>Last run</span><strong>${escapeHtml(plan.last_run)}</strong></div>` : ''}
    ${plan.next ? `<div class="coding-plan-meta"><span>Next</span><strong>${escapeHtml(plan.next)}</strong></div>` : ''}
    ${!exists ? '<p class="coding-plan-empty">Start a task and the agent will track its phase, checklist, and next step here.</p>' : ''}
  </section>`;
}

const css = `
.coding-plan-card{border:1px solid var(--border-color,#303744);border-radius:12px;padding:12px;margin-bottom:12px;background:linear-gradient(145deg,rgba(120,90,255,.08),rgba(20,24,32,.18))}
.coding-plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
.coding-plan-head strong{font-size:14px;display:block}
.coding-plan-kicker{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;opacity:.55;margin-bottom:3px}
.coding-plan-phase{display:inline-flex;align-items:center;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(120,90,255,.14);color:#a78bfa;white-space:nowrap}
.coding-plan-phase.is-done{background:rgba(34,197,94,.14);color:#22c55e}
.coding-plan-phase.is-testing{background:rgba(59,130,246,.14);color:#60a5fa}
.coding-plan-phase.is-debugging{background:rgba(239,68,68,.14);color:#f87171}
.coding-plan-phase.is-blocked{background:rgba(245,158,11,.14);color:#f59e0b}
.coding-plan-tasks{list-style:none;margin:0;padding:0;display:grid;gap:4px}
.coding-plan-tasks li{font-size:12px;padding:5px 8px;border-radius:6px;background:rgba(127,127,127,.06)}
.coding-plan-tasks li.is-done{opacity:.55;text-decoration:line-through}
.coding-plan-meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border-color,#303744)}
.coding-plan-meta span{opacity:.55}
.coding-plan-meta strong{font-weight:500;text-align:right;overflow-wrap:anywhere}
.coding-plan-empty{font-size:12px;opacity:.6;margin:6px 0 0}
`;

async function onEnable(context) {
  runtimeContext = context;

  context.registerHandler('coding_plan', {
    toolName: 'coding_plan',
    privateSafe: true,
    description: 'Durable plan/phase tracker for the current coding task. Use action="status" to recall the plan (especially when resuming or after a long run), and action="update" to record your phase, task checklist, last command/test result, and next step. Optional but recommended for multi-step tasks; it persists across context resets.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Operation: status | update | reset. status returns the current plan; update writes the given fields and returns the full updated plan; reset clears the plan.' },
        phase: { type: 'string', description: 'Free-form current phase, e.g. planning, implementing, testing, debugging, ready_for_commit.' },
        goal: { type: 'string', description: 'One-line goal of the current task.' },
        tasks: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } } }, description: 'Checklist of tasks with done flags.' },
        last_run: { type: 'string', description: 'Outcome of the last command or test run, e.g. "npm test -> 2 failures".' },
        next: { type: 'string', description: 'Immediate next step to take.' }
      },
      required: ['action']
    }
  }, (params) => codingPlan(params, context));

  context.registerChatUI({
    title: 'Coding Plan',
    async renderPanel(agentInfo) {
      return renderPanel(agentInfo);
    },
    css,
    actions: {
      async refresh({ agentInfo }) {
        return { success: true, html: renderPanel(agentInfo), css };
      }
    }
  });

  context.log('Coding plan tool and panel registered');
}

async function onDisable() {
  runtimeContext = null;
}

module.exports = {
  onEnable,
  onDisable,
  _test: { parsePlan, renderPlan, emptyPlan, normalizeTasks, phaseClass }
};
