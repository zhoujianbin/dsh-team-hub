const app = document.querySelector("#app");
const nav = [...document.querySelectorAll("nav a")];

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
    <table><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>最近登录</th><th>操作</th></tr></thead><tbody>
    ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${badge(u.role, u.role)}</td><td>${badge(u.status, u.status)}</td><td>${esc(u.lastLoginAt || "从未")}</td>
    <td><button class="secondary" data-action="reset" data-name="${esc(u.name)}">重置密码</button>
    <button class="secondary" data-action="${u.status === "disabled" ? "enable" : "disable"}" data-name="${esc(u.name)}">${u.status === "disabled" ? "启用" : "禁用"}</button></td></tr>`).join("")}
    </tbody></table><p id="message"></p></section>`;
  document.querySelector("#create-user").onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.target);
    const result = await api("/users", { method: "POST", body: { name: form.get("name"), role: form.get("role") } });
    document.querySelector("#message").innerHTML = `初始密码：<code class="mono">${esc(result.initialPassword)}</code>（只显示一次）`;
    await renderUsers();
  };
  app.onclick = async event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const name = button.dataset.name;
    if (button.dataset.action === "reset") {
      const result = await api(`/users/${encodeURIComponent(name)}/reset-password`, { method: "POST" });
      document.querySelector("#message").innerHTML = `新初始密码：<code class="mono">${esc(result.initialPassword)}</code>（只显示一次）`;
    } else {
      await api(`/users/${encodeURIComponent(name)}/status`, { method: "POST", body: { status: button.dataset.action === "disable" ? "disabled" : "active" } });
    }
    await renderUsers();
  };
}

async function renderWorkspaces() {
  const rows = await api("/workspaces");
  app.innerHTML = `<section class="card"><h2>工作区</h2><table><thead><tr><th>Workspace ID</th><th>Owner</th></tr></thead><tbody>
  ${rows.map(w => `<tr><td class="mono">${esc(w.workspaceId)}</td><td>${esc(w.owner)}</td></tr>`).join("")}
  </tbody></table></section>`;
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
