import { createShareState, moveShareMembers } from "./share-state.js";

const app = document.querySelector("#app");
const nav = [...document.querySelectorAll("nav a")];
// 渲染后要恢复的提示消息：renderUsers 会重写 #app.innerHTML（清掉 #message），
// 操作类提示（新初始密码、新建用户密码）先存这里，渲染完成后再写回。
let pendingMessage = "";

async function api(path, options = {}) {
  const response = await fetch("/__teamhub/api" + path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (response.status === 401) { location.href = "/login?next=/admin"; return null; }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  return body;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
}

function badge(text, cls = "") { return `<span class="badge ${cls}">${esc(text)}</span>`; }

async function render() {
  closeShareDialogs();
  const page = location.hash.slice(1) || "overview";
  nav.forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + page));
  try {
    if (page === "users") return renderUsers();
    if (page === "workspaces") return renderWorkspaces();
    if (page === "audit") return renderAudit();
    if (page === "system") return renderSystem();
    return renderOverview();
  } catch (error) {
    app.innerHTML = `<section class="card"><h2>错误</h2><p class="error">${esc(error.message)}</p></section>`;
  }
}

async function renderOverview() {
  const data = await api("/overview");
  app.innerHTML = `<section class="card"><h2>总览</h2>
    <p>上游 DSH：<span class="mono">${esc(data.upstream)}</span></p>
    <p>用户：${data.users.length}；工作区：${data.workspaces.length}；会话：${data.sessions}</p></section>
    <section class="card"><h2>最近审计</h2>${auditTable(data.recentAudit)}</section>`;
}

async function renderUsers() {
  const users = await api("/users");
  app.innerHTML = `<section class="card"><h2>用户</h2>
    <form class="inline" id="create-user"><input name="name" placeholder="用户名" required>
    <select name="role"><option value="member">member</option><option value="admin">admin</option></select>
    <button>创建用户</button></form>
    <table><thead><tr><th>登录名</th><th>显示名</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>
    ${users.map(u => `<tr><td class="mono">${esc(u.name)}</td><td>${esc(u.displayName || u.name)}</td><td>${badge(u.role, u.role)}</td><td>${badge(u.status, u.status)}</td><td>${esc(u.lastLoginAt || "从未")}</td>
    <td><button class="secondary" data-action="rename" data-name="${esc(u.name)}" data-display="${esc(u.displayName || u.name)}">改名</button>
    <button class="secondary" data-action="reset" data-name="${esc(u.name)}">重置密码</button>
    <button class="secondary" data-action="${u.status === "disabled" ? "enable" : "disable"}" data-name="${esc(u.name)}">${u.status === "disabled" ? "启用" : "禁用"}</button></td></tr>`).join("")}
    </tbody></table><p id="message"></p></section>`;
  if (pendingMessage) {
    document.querySelector("#message").innerHTML = pendingMessage;
    pendingMessage = "";
  }
  document.querySelector("#create-user").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      const result = await api("/users", { method: "POST", body: { name: form.get("name"), role: form.get("role") } });
      const workspaceMessage = result.workspace ? `工作区已创建：${esc(result.workspace.title || result.user.name)}；` : "";
      pendingMessage = `${workspaceMessage}初始密码：<code class="mono">${esc(result.initialPassword)}</code>（只显示一次）`;
    } catch (error) {
      pendingMessage = `<span class="error">${esc(error.message)}</span>`;
    }
    await renderUsers();
  };
  app.onclick = async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const name = button.dataset.name;
    if (button.dataset.action === "rename") {
      const next = prompt("新的显示名（界面展示用，登录名不变）", button.dataset.display || "");
      if (next && next.trim()) await api(`/users/${encodeURIComponent(name)}/display-name`, { method: "POST", body: { displayName: next.trim() } });
      return renderUsers();
    }
    if (button.dataset.action === "reset") {
      const result = await api(`/users/${encodeURIComponent(name)}/reset-password`, { method: "POST" });
      pendingMessage = `新初始密码：<code class="mono">${esc(result.initialPassword)}</code>（只显示一次）`;
    } else {
      await api(`/users/${encodeURIComponent(name)}/status`, { method: "POST", body: { status: button.dataset.action === "disable" ? "disabled" : "active" } });
    }
    await renderUsers();
  };
}

async function renderWorkspaces() {
  const [rows, users] = await Promise.all([api("/workspaces"), api("/users")]);
  const eligible = users.filter(user => user.role === "member" && user.status === "active");
  app.innerHTML = `<section class="card"><h2>工作区共享</h2><p>授权成员可以查看共享工作区及历史会话。工作区所有者无需授权。</p>
    <div id="workspace-message"></div><table><thead><tr><th>工作区 / 路径</th><th>所有者</th><th>共享给</th><th>操作</th></tr></thead><tbody>
    ${rows.map((w, index) => `<tr><td>${esc(w.title)}<br><small class="mono">${esc(w.path || w.workspaceId)}</small></td><td>${esc(w.owner)}</td>
      <td>${(w.members || []).map(esc).join("、") || "未共享"}</td>
      <td><button data-share="${index}">设置共享成员</button></td></tr>`).join("")}
    </tbody></table></section>`;
  app.onclick = async event => {
    const button = event.target.closest("button[data-share]");
    if (!button) return;
    const workspace = rows[Number(button.dataset.share)];
    if (!workspace) return;
    try {
      const saved = await openShareDialog({
        workspace,
        users: eligible,
        onSubmit: members => api(`/workspaces/${encodeURIComponent(workspace.workspaceId)}/sharing`, {
          method: "POST", body: { members }
        })
      });
      if (!saved || (location.hash.slice(1) || "overview") !== "workspaces") return;
      await renderWorkspaces();
      document.querySelector("#workspace-message").textContent = "共享成员已更新；已登录成员刷新页面即可看到变化";
    } catch (error) {
      const message = document.querySelector("#workspace-message");
      if (message) message.textContent = error.message;
    }
  };
}

function closeShareDialogs() {
  for (const node of document.querySelectorAll(".modal-backdrop")) {
    if (typeof node.closeDialog === "function") node.closeDialog();
    else node.remove();
  }
}

function openShareDialog({ workspace, users, onSubmit }) {
  closeShareDialogs();
  let state = createShareState(users, workspace.owner, workspace.members || []);
  const selected = { granted: new Set(), available: new Set() };
  let busy = false;
  let done = false;
  const controller = new AbortController();
  const trigger = document.activeElement;
  let resolveResult;
  const result = new Promise(resolve => { resolveResult = resolve; });
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title" aria-describedby="share-dialog-help">
      <h2 id="share-dialog-title">设置共享成员</h2>
      <p class="modal-subtitle">${esc(workspace.title)} <span class="mono">${esc(workspace.path || workspace.workspaceId)}</span></p>
      <p class="modal-help" id="share-dialog-help">点击成员姓名可多选，再用中间按钮调整是否授权。授权成员只能查看该工作区及其历史会话。</p>
      <div class="dual-list">
        <section class="dual-list-column" aria-labelledby="granted-heading">
          <h3 class="dual-list-heading" id="granted-heading">已有权限 <span class="count" data-count="granted">0</span></h3>
          <div class="listbox" data-list="granted" role="listbox" aria-multiselectable="true" aria-labelledby="granted-heading" tabindex="0"></div>
        </section>
        <div class="move-buttons">
          <button type="button" class="secondary" data-move="revoke" aria-label="移除所选成员的权限" title="移除所选成员的权限" disabled>→</button>
          <button type="button" class="secondary" data-move="grant" aria-label="授权所选成员" title="授权所选成员" disabled>←</button>
        </div>
        <section class="dual-list-column" aria-labelledby="available-heading">
          <h3 class="dual-list-heading" id="available-heading">尚未授权 <span class="count" data-count="available">0</span></h3>
          <div class="listbox" data-list="available" role="listbox" aria-multiselectable="true" aria-labelledby="available-heading" tabindex="0"></div>
        </section>
      </div>
      <p class="error" id="share-dialog-error" role="alert" hidden></p>
      <div class="modal-actions">
        <button type="button" class="secondary" data-close>取消</button>
        <button type="button" data-save>保存</button>
      </div>
    </section>`;
  const dialog = backdrop.querySelector(".modal");
  const listNodes = {
    granted: backdrop.querySelector('[data-list="granted"]'),
    available: backdrop.querySelector('[data-list="available"]')
  };
  const countNodes = {
    granted: backdrop.querySelector('[data-count="granted"]'),
    available: backdrop.querySelector('[data-count="available"]')
  };
  const moveNodes = {
    grant: backdrop.querySelector('[data-move="grant"]'),
    revoke: backdrop.querySelector('[data-move="revoke"]')
  };
  const saveNode = backdrop.querySelector("[data-save]");
  const closeNode = backdrop.querySelector("[data-close]");
  const errorNode = backdrop.querySelector("#share-dialog-error");

  function renderLists() {
    for (const side of ["granted", "available"]) {
      const list = listNodes[side];
      list.replaceChildren();
      const names = state[side];
      countNodes[side].textContent = String(names.length);
      for (const name of names) {
        const candidate = state.candidates.find(user => user.name === name);
        const option = document.createElement("button");
        option.type = "button";
        option.className = "list-option";
        option.dataset.name = name;
        option.dataset.side = side;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(selected[side].has(name)));
        option.classList.toggle("selected", selected[side].has(name));
        option.textContent = candidate?.displayName && candidate.displayName !== name
          ? `${candidate.displayName}（${name}）` : name;
        list.append(option);
      }
      if (!names.length) {
        const empty = document.createElement("p");
        empty.className = "list-empty";
        empty.textContent = side === "granted" ? "还没有授权任何成员" : "所有成员都已有权限";
        list.append(empty);
      }
    }
    dialog.setAttribute("aria-busy", String(busy));
    moveNodes.grant.disabled = busy || selected.available.size === 0;
    moveNodes.revoke.disabled = busy || selected.granted.size === 0;
    saveNode.disabled = busy;
    closeNode.disabled = busy;
    saveNode.textContent = busy ? "保存中…" : "保存";
  }

  function finish(value) {
    if (done) return;
    done = true;
    controller.abort();
    backdrop.remove();
    if (trigger && trigger.isConnected) trigger.focus();
    resolveResult(value);
  }

  // Navigation replaces the page while this dialog may still be awaiting a
  // result; resolve it as cancelled instead of leaving the caller suspended.
  backdrop.closeDialog = () => finish(false);

  backdrop.addEventListener("click", async event => {
    const option = event.target.closest(".list-option");
    if (option) {
      const side = option.dataset.side;
      const name = option.dataset.name;
      if (selected[side].has(name)) selected[side].delete(name);
      else selected[side].add(name);
      renderLists();
      [...listNodes[side].children].find(node => node.dataset.name === name)?.focus();
      return;
    }
    const move = event.target.closest("button[data-move]");
    if (move) {
      const direction = move.dataset.move;
      const names = [...selected[direction === "grant" ? "available" : "granted"]];
      const next = moveShareMembers(state, direction, names);
      if (next !== state) {
        state = next;
        selected.granted.clear();
        selected.available.clear();
        renderLists();
      }
      return;
    }
    if (event.target.closest("[data-close]")) {
      if (!busy) finish(false);
      return;
    }
    if (event.target.closest("[data-save]")) {
      if (busy) return;
      busy = true;
      errorNode.hidden = true;
      renderLists();
      try {
        await onSubmit([...state.granted]);
        finish(true);
      } catch (cause) {
        busy = false;
        renderLists();
        errorNode.textContent = cause?.message || "保存失败，请重试";
        errorNode.hidden = false;
      }
      return;
    }
    if (event.target === backdrop) finish(false);
  }, { signal: controller.signal });

  backdrop.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) finish(false);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button:not([disabled]), [tabindex='0']")]
      .filter(node => node.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, { signal: controller.signal });

  document.body.append(backdrop);
  renderLists();
  listNodes[state.granted.length ? "granted" : "available"].focus();
  return result;
}

function auditTable(rows) {
  return `<table><thead><tr><th>时间</th><th>类型</th><th>用户</th><th>详情</th></tr></thead><tbody>
  ${rows.map(row => `<tr><td>${esc(row.at)}</td><td>${esc(row.type)}</td><td>${esc(row.user || "")}</td><td class="mono">${esc(JSON.stringify({ ...row, at: undefined, type: undefined, user: undefined }))}</td></tr>`).join("")}
  </tbody></table>`;
}

async function renderAudit() {
  const rows = await api("/audit?limit=200");
  app.innerHTML = `<section class="card"><h2>审计</h2>${auditTable(rows)}</section>`;
}

async function renderSystem() {
  const data = await api("/system");
  app.innerHTML = `<section class="card"><h2>系统</h2><pre class="mono">${esc(JSON.stringify(data, null, 2))}</pre>
  <button id="selftest">运行兼容性自检</button><p id="selftest-result"></p></section>`;
  document.querySelector("#selftest").onclick = async () => {
    const result = await api("/selftest", { method: "POST" });
    document.querySelector("#selftest-result").textContent = result.ok ? "自检通过" : "自检失败：" + result.error;
  };
}

addEventListener("hashchange", render);
render();
