// @ts-nocheck
(function bootstrapCompanionActivity(global) {
  const { escapeHtml, formatDateTime } = global.LocalAgentCompanionUtils;

  function labelFor(type) {
    return String(type || '')
      .replace(/[:_-]+/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function createActivityController(app) {
    const ui = {
      refreshButton: document.getElementById('refresh-activity-btn'),
      activityList: document.getElementById('activity-list'),
      permissionList: document.getElementById('permission-request-list'),
      taskList: document.getElementById('task-queue-list')
    };
    const events = [];
    const permissions = [];
    let tasks = [];

    async function loadTaskQueue() {
      try {
        const response = await app.client.listTaskQueue();
        const payload = response && response.result != null ? response.result : response;
        tasks = Array.isArray(payload && payload.tasks) ? payload.tasks.slice(0, 8) : [];
        renderTasks();
      } catch (error) {
        recordEvent('task-queue-error', { message: error.message || 'Task queue unavailable' });
      }
    }

    async function updateTask(action, taskId) {
      if (!taskId) return;
      try {
        const response = await app.client.updateTask(String(action || '').replace('task-queue:', ''), taskId);
        const payload = response && response.result != null ? response.result : response;
        if (!payload || !payload.success) throw new Error((payload && payload.error) || 'Task update failed');
        await loadTaskQueue();
      } catch (error) {
        app.showToast(error.message || 'Task update failed', 'error');
      }
    }

    function recordEvent(type, payload = {}) {
      events.unshift({
        type,
        payload,
        at: new Date().toISOString()
      });
      if (events.length > 12) events.length = 12;
      renderEvents();
    }

    function addPermissionRequest(payload = {}) {
      const id = String(payload.requestId || payload.id || `${Date.now()}-${permissions.length}`);
      permissions.unshift({
        id,
        toolName: String(payload.toolName || payload.name || 'Tool request'),
        description: String(payload.description || (payload.toolDefinition && payload.toolDefinition.description) || payload.message || ''),
        sessionId: payload.sessionId || '',
        at: new Date().toISOString()
      });
      if (permissions.length > 6) permissions.length = 6;
      renderPermissions();
    }

    function dismissPermission(id) {
      const index = permissions.findIndex((entry) => entry.id === id);
      if (index >= 0) permissions.splice(index, 1);
      renderPermissions();
    }

    function renderEvents() {
      ui.activityList.innerHTML = events.length
        ? events.map((event) => `
          <div class="activity-item">
            <strong>${escapeHtml(labelFor(event.type))}</strong>
            <span>${escapeHtml((event.payload && (event.payload.message || event.payload.summary)) || formatDateTime(event.at))}</span>
          </div>
        `).join('')
        : '<div class="empty-state">No companion events yet.</div>';
    }

    function renderPermissions() {
      ui.permissionList.innerHTML = permissions.length
        ? permissions.map((request) => `
          <div class="permission-item">
            <strong>${escapeHtml(request.toolName)}</strong>
            <span>${escapeHtml(request.description || 'Approve or deny this request on the desktop app.')}</span>
            <button class="ghost-btn compact-btn" type="button" data-dismiss-permission="${escapeHtml(request.id)}">Dismiss</button>
          </div>
        `).join('')
        : '<div class="empty-state">No pending tool permissions.</div>';
      ui.permissionList.querySelectorAll('[data-dismiss-permission]').forEach((button) => {
        button.addEventListener('click', () => dismissPermission(button.dataset.dismissPermission));
      });
    }

    function renderTasks() {
      ui.taskList.innerHTML = tasks.length
        ? tasks.map((task) => `
          <div class="task-item">
            <strong>${escapeHtml(task.title || task.summary || task.id)}</strong>
            <span>${escapeHtml(task.status || 'pending')} / ${escapeHtml(task.priority || 'normal')}</span>
            <div class="task-actions">
              <button class="secondary-btn compact-btn" type="button" data-task-action="task-queue:approve" data-task-id="${escapeHtml(task.id)}">Approve</button>
              <button class="ghost-btn compact-btn" type="button" data-task-action="task-queue:defer" data-task-id="${escapeHtml(task.id)}">Defer</button>
              <button class="ghost-btn compact-btn" type="button" data-task-action="task-queue:cancel" data-task-id="${escapeHtml(task.id)}">Cancel</button>
            </div>
          </div>
        `).join('')
        : '<div class="empty-state">No actionable tasks.</div>';
      ui.taskList.querySelectorAll('[data-task-action]').forEach((button) => {
        button.addEventListener('click', () => updateTask(button.dataset.taskAction, button.dataset.taskId));
      });
    }

      if (ui.refreshButton) ui.refreshButton.addEventListener('click', () => loadTaskQueue());
    renderEvents();
    renderPermissions();
    renderTasks();

    return {
      addPermissionRequest,
      loadTaskQueue,
      recordEvent
    };
  }

  global.LocalAgentCompanionActivity = {
    createActivityController
  };
})(window);
