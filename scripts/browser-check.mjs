import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function browserCheck(base, memberCookies, { isolatedHost = false, mockModel = false, sessionProbe = false, sessionPrompt = false } = {}) {
  for (const memberCookie of memberCookies) await browserCheckOne(base, memberCookie, isolatedHost, mockModel, sessionProbe, sessionPrompt);
}

async function browserCheckOne(base, memberCookie, isolatedHost, mockModel, sessionProbe, sessionPrompt) {
  if (!fs.existsSync(chrome)) throw new Error("Chrome is unavailable for browser acceptance");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "teamhub-chrome-"));
  const child = spawn(chrome, ["--headless=new", "--no-first-run", "--disable-background-networking",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" });
  const sockets = new Set();
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(portFile)) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Chrome debugging port unavailable");
      await pause(75);
    }
    const port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0]);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(t => t.type === "page");
    if (!target) throw new Error("Chrome page target unavailable");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    sockets.add(socket);
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    let nextId = 0;
    const pending = new Map();
    const messages = [];
    socket.on("message", data => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg.id) { messages.push(msg); return; }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message)); else entry.resolve(msg.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send("Network.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    for (const [member, cookie] of [memberCookie]) {
      const [name, value] = cookie.split("=", 2);
      if (!name || !value) throw new Error("Invalid member cookie for browser acceptance");
      await send("Network.setCookie", { name, value, url: base, httpOnly: true, sameSite: "Lax" });
      await send("Page.navigate", { url: base });
      await pause(3500);
      await send("Runtime.evaluate", { expression: `[...document.querySelectorAll("button")].find(e=>e.textContent?.trim()==="Continue")?.click()` });
      await pause(900);
      await send("Runtime.evaluate", { expression: `document.querySelector('button[aria-label="Open sidebar"]')?.click()` });
      await pause(500);
      const state = await send("Runtime.evaluate", { expression: `({href:location.href, title:document.title, text:document.body?.innerText.slice(0,700), workspaceLabels:[...document.querySelectorAll('[role="treeitem"]')].map(e=>e.getAttribute("aria-label")||e.textContent?.trim()).slice(0,12), composer:document.querySelector("textarea")?.placeholder, controls:[...document.querySelectorAll("button")].map(e=>({text:e.textContent?.trim().slice(0,50),label:e.getAttribute("aria-label"),title:e.title,visible:e.getClientRects().length>0})).slice(0,25), links:[...document.querySelectorAll("a")].map(e=>e.textContent?.trim()).filter(Boolean).slice(0,12)})`, returnByValue: true });
      const view = state.result?.value;
      const failed = messages.filter(msg => msg.method === "Network.loadingFailed" && msg.params?.errorText !== "net::ERR_ABORTED");
      const usageOverviewStatuses = messages.filter(msg => msg.method === "Network.responseReceived" &&
        new URL(msg.params.response.url).pathname.endsWith("/api/dsh-usage/overview")).map(msg => msg.params.response.status);
      const scriptErrors = messages.filter(msg => msg.method === "Runtime.exceptionThrown").map(msg =>
        ({ text: msg.params?.exceptionDetails?.exception?.description?.slice(0, 350) || msg.params?.exceptionDetails?.text, url: msg.params?.exceptionDetails?.url?.slice(0, 160) })).slice(0, 5);
      const websocketUrls = messages.filter(msg => msg.method === "Network.webSocketCreated").map(msg => {
        try { const url = new URL(msg.params.url); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return "invalid"; }
      });
      const websocketErrors = messages.filter(msg => ["Network.webSocketFrameError", "Network.webSocketClosed"].includes(msg.method)).length;
      const sentEndpoints = messages.filter(msg => msg.method === "Network.webSocketFrameSent").map(msg => {
        try { return JSON.parse(msg.params.response.payloadData).endpoint; } catch { return null; }
      }).filter(Boolean);
      const receivedWorkspaceBaseline = messages.some(msg => {
        if (msg.method !== "Network.webSocketFrameReceived") return false;
        try { const frame = JSON.parse(msg.params.response.payloadData); return frame.type === "item" && frame.value?.type === "baseline" && Array.isArray(frame.value?.value?.items); } catch { return false; }
      });
      console.log("member browser boot", JSON.stringify({ member, workspaceLabels: view?.workspaceLabels,
        visibleHostControls: view?.controls?.filter(control => control.visible && ["Plugins", "Task Board", "Skill Center", "SSH", "Remote access", "Add workspace"].includes(control.label)).map(control => control.label),
        newSessionVisible: view?.controls?.some(control => control.visible && control.label === "New session"),
        previewNotice: view?.text?.includes("Preview Notice"), failedPlugins: view?.text?.includes("Failed to load plugins"),
        loginPage: view?.href?.includes("/login"), changePasswordPage: view?.href?.includes("/change-password"),
        websocketUrls: [...new Set(websocketUrls)], websocketErrors, sentEndpoints: [...new Set(sentEndpoints)], receivedWorkspaceBaseline,
        usageOverviewStatuses, networkFailures: failed.length, scriptErrors: scriptErrors.length }));
      if (!view?.href?.startsWith(base) || view.href.includes("/login") ||
          view.href.includes("/change-password") || view.text?.includes("Failed to load plugins") ||
          view.text?.includes("Preview Notice") || !view.workspaceLabels?.includes(member) ||
          !view.controls?.some(control => control.visible && control.label === "New session") ||
          view.controls?.some(control => control.visible && ["Plugins", "Task Board", "Skill Center", "SSH", "Remote access", "Add workspace"].includes(control.label)) ||
          view.controls?.some(control => control.visible && control.text?.includes("Failed to load: usage")) ||
          usageOverviewStatuses.some(status => status >= 400) || failed.length > 0 || scriptErrors.length > 0)
        throw new Error(`${member} did not initialize the DSH browser shell`);
      if (sessionProbe && !isolatedHost) {
        await pause(7000);
        const expansionStates = [];
        for (let index = 0; index < 6; index += 1) {
          const state = await send("Runtime.evaluate", { expression: `(()=>{const e=[...document.querySelectorAll('[role="treeitem"]')].find(el=>(el.getAttribute('aria-label')||el.textContent||'').trim()===${JSON.stringify(member)});return e?.getAttribute('aria-expanded')??null})()`, returnByValue: true });
          expansionStates.push(state.result?.value ?? null);
          await pause(500);
        }
        const beforeProbe = messages.length;
        const opened = await send("Runtime.evaluate", { expression: `(()=>{const rows=[...document.querySelectorAll('[role="treeitem"]')].filter(e=>e.getClientRects().length);const target=rows.find(e=>{const label=(e.getAttribute('aria-label')||e.textContent||'').trim();return label&&label!==${JSON.stringify(member)}&&label!=='New Session'&&label!=='New session'});if(!target)return false;target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));return true})()`, returnByValue: true });
        await pause(3500);
        const probeMessages = messages.slice(beforeProbe);
        const follows = probeMessages.filter(msg => msg.method === "Network.webSocketFrameSent").map(msg => {
          try { const frame = JSON.parse(msg.params.response.payloadData); return frame.endpoint === "session/follow" ? frame.streamId : null; } catch { return null; }
        }).filter(Boolean);
        const followTypes = probeMessages.filter(msg => msg.method === "Network.webSocketFrameReceived").map(msg => {
          try { const frame = JSON.parse(msg.params.response.payloadData); return follows.includes(frame.streamId) ? `${frame.type}:${frame.value?.type || frame.error?.code || ""}` : null; } catch { return null; }
        }).filter(Boolean);
        const probe = await send("Runtime.evaluate", { expression: `({loading:document.body?.innerText.includes('Loading history'),failed:document.body?.innerText.includes('Failed to load history'),composer:!!document.querySelector('textarea,[contenteditable=true][role=textbox]'),workspaceRows:[...document.querySelectorAll('[role="treeitem"]')].length})`, returnByValue: true });
        console.log("member session probe", JSON.stringify({ member, expansionStates, opened: opened.result?.value === true, followOpened: follows.length > 0, followTypes: [...new Set(followTypes)], loading: probe.result?.value?.loading, failed: probe.result?.value?.failed, composer: probe.result?.value?.composer, workspaceRows: probe.result?.value?.workspaceRows }));
        if (new Set(expansionStates).size !== 1 || expansionStates[0] !== "true" ||
            opened.result?.value !== true || follows.length === 0 || !followTypes.includes("item:snapshot") ||
            probe.result?.value?.loading || probe.result?.value?.failed || !probe.result?.value?.composer)
          throw new Error(`${member} existing session history did not load`);
        if (sessionPrompt) {
          const promptStart = messages.length;
          const focused = await send("Runtime.evaluate", { expression: `(()=>{const e=document.querySelector('[contenteditable=true][role=textbox]');if(!e)return false;e.focus();return true})()`, returnByValue: true });
          if (focused.result?.value !== true) throw new Error(`${member} existing session composer unavailable`);
          await send("Input.insertText", { text: "Team Hub 回归测试，请只回复 TEST_OK。" });
          const sendReady = await send("Runtime.evaluate", { expression: `(()=>{const b=document.querySelector('button[aria-label="Send message"]');if(!b||b.disabled)return false;b.click();return true})()`, returnByValue: true });
          if (sendReady.result?.value !== true) throw new Error(`${member} existing session prompt was not sendable`);
          const deadline = Date.now() + 7000;
          let responses = [];
          while (Date.now() < deadline) {
            responses = messages.slice(promptStart).filter(msg => msg.method === "Network.responseReceived" && new URL(msg.params.response.url).pathname.endsWith("/api/session/prompt"));
            if (responses.length) break;
            await pause(100);
          }
          const results = [];
          for (const response of responses) {
            const body = await send("Network.getResponseBody", { requestId: response.params.requestId });
            try { results.push(JSON.parse(body.body).result?.ok === true); } catch { results.push(false); }
          }
          await pause(1200);
          console.log("member existing prompt", JSON.stringify({ member, statuses: responses.map(response => response.params.response.status), accepted: results.includes(true) }));
          if (!responses.some(response => response.params.response.status === 200) || !results.includes(true))
            throw new Error(`${member} existing session prompt was not accepted`);
        }
        await send("Network.clearBrowserCookies");
        messages.length = 0;
        continue;
      }
      await send("Runtime.evaluate", { expression: "document.querySelector('button[aria-label=Settings]')?.click()" });
      await pause(700);
      const settingsState = await send("Runtime.evaluate", { expression: "({text:document.body?.innerText.slice(0,850),labels:[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label')||e.textContent?.trim()).slice(0,28)})", returnByValue: true });
      console.log("member settings", JSON.stringify({ member, generalVisible: settingsState.result?.value?.text?.includes("Settings\nGeneral"), internalError: settingsState.result?.value?.text?.includes("internal:") }));
      if (!settingsState.result?.value?.text?.includes("Settings\nGeneral") ||
          settingsState.result.value.text.includes("internal:") || settingsState.result.value.text.includes("tenant-leak") ||
          settingsState.result.value.labels.some(label => ["Models", "Built-in plugins", "Agent presets", "Plugin Market", "Web Plugins", "Usage Statistics"].includes(label)))
        throw new Error(`${member} settings screen failed or leaked Host data`);
      if (isolatedHost) {
        await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find(e=>e.textContent?.trim()==='Close')?.click()" });
        await pause(350);
        await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='New session'&&e.getClientRects().length)?.click()" });
        await pause(900);
        const created = messages.filter(msg => msg.method === "Network.responseReceived" && msg.params?.response?.url?.endsWith("/api/session/create")).map(msg => msg.params.response.status);
        if (!created.includes(200)) throw new Error(`${member} browser session creation failed`);
        console.log("disposable browser session", JSON.stringify({ member, createStatuses: created }));
        const initialModel = await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.startsWith('Select model,')&&e.getClientRects().length)?.getAttribute('aria-label')", returnByValue: true });
        await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.startsWith('Select model,')&&e.getClientRects().length)?.click()" });
        await pause(600);
        const chooser = await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label')||e.textContent?.trim()).slice(-25)", returnByValue: true });
        const modelVisible = chooser.result?.value?.some(label => label.startsWith("Model") && label.length > 5);
        if (!modelVisible || !chooser.result?.value?.some(label => label.startsWith("Effort")))
          throw new Error(`${member} per-session model selector unavailable`);
        console.log("member model chooser", JSON.stringify({ member, modelVisible, effortVisible: true }));
        await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('[role=menu] button')].find(e=>e.innerText?.trim().startsWith('Model'))?.click()" });
        await pause(450);
        const targetModel = initialModel.result?.value?.includes("current DeepSeek-V4-Pro") ? "DeepSeek-V41-Flash" : "DeepSeek-V4-Pro";
        const targetModelId = targetModel === "DeepSeek-V4-Pro" ? "deepseek-v4-pro" : "deepseek-flash";
        const selectedModel = await send("Runtime.evaluate", { expression: `(()=>{const e=[...document.querySelectorAll('[role=menu] button, [role=menuitem], [role=option]')].find(e=>e.getClientRects().length&&e.innerText?.trim()===${JSON.stringify(targetModel)});e?.click();return !!e})()`, returnByValue: true });
        const selectionDeadline = Date.now() + 5000;
        while (!messages.some(msg => msg.method === "Network.responseReceived" &&
          msg.params?.response?.url?.endsWith("/api/session/selectModel")) && Date.now() < selectionDeadline)
          await pause(100);
        await pause(150);
        const selectionStatuses = messages.filter(msg => msg.method === "Network.responseReceived" && msg.params?.response?.url?.endsWith("/api/session/selectModel")).map(msg => msg.params.response.status);
        const selectedLabel = await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')?.startsWith('Select model,'))?.getAttribute('aria-label')", returnByValue: true });
        const selectionRequests = messages.filter(msg => msg.method === "Network.responseReceived" && msg.params?.response?.url?.endsWith("/api/session/selectModel"));
        const selectionResults = [];
        for (const entry of selectionRequests) {
          const body = await send("Network.getResponseBody", { requestId: entry.params.requestId });
          const result = JSON.parse(body.body).result;
          selectionResults.push({ ok: result?.ok === true, model: result?.value?.selected?.model });
        }
        if (!selectedModel.result?.value || !selectionStatuses.includes(200) ||
            !selectionResults.some(result => result.ok && result.model === targetModelId) || !selectedLabel.result?.value?.includes(targetModel))
          throw new Error(`${member} per-session model selection did not persist in real browser`);
        console.log("disposable model selection", JSON.stringify({ member, status: 200, selected: true }));
        const editor = await send("Runtime.evaluate", { expression: "({x:(()=>{let e=document.querySelector('[contenteditable=true][role=textbox]');let r=e?.getBoundingClientRect();return r?.x+r?.width/2})(),y:(()=>{let e=document.querySelector('[contenteditable=true][role=textbox]');let r=e?.getBoundingClientRect();return r?.y+r?.height/2})()})", returnByValue: true });
        if (!Number.isFinite(editor.result?.value?.x)) throw new Error("member composer unavailable");
        await send("Input.insertText", { text: "Reply with the word READY only." });
        const inputState = await send("Runtime.evaluate", { expression: "({text:document.querySelector('[contenteditable=true][role=textbox]')?.textContent,sendDisabled:document.querySelector('button[aria-label=\"Send message\"]')?.disabled})", returnByValue: true });
        if (inputState.result?.value?.sendDisabled !== false || inputState.result?.value?.text !== "Reply with the word READY only.")
          throw new Error("member composer did not accept input");
        await send("Runtime.evaluate", { expression: "document.querySelector('button[aria-label=\"Send message\"]')?.click()" });
        await pause(2200);
        const turn = await send("Runtime.evaluate", { expression: "({text:document.body?.innerText.slice(-850)})", returnByValue: true });
        const promptResponses = messages.filter(msg => msg.method === "Network.responseReceived" && msg.params?.response?.url?.endsWith("/api/session/prompt"));
        const promptStatuses = promptResponses.map(msg => msg.params.response.status);
        const promptResults = [];
        for (const entry of promptResponses) {
          const body = await send("Network.getResponseBody", { requestId: entry.params.requestId });
          promptResults.push(JSON.parse(body.body).result?.ok === true);
        }
        console.log("disposable browser turn", JSON.stringify({ member, promptStatuses, promptResults, historyVisible: turn.result?.value?.text?.includes("Reply with the word READY only."), failedHistory: turn.result?.value?.text?.includes("Failed to load history") }));
        if (!promptStatuses.includes(200) || !promptResults.includes(true) || turn.result?.value?.text?.includes("Failed to load history") ||
            !turn.result?.value?.text?.includes("Reply with the word READY only."))
          throw new Error(`${member} session history stream failed in real browser`);
        if (mockModel) {
          const deadline = Date.now() + 22000;
          let text = turn.result?.value?.text || "";
          while (!/\bREADY\b/.test(text.replace("Reply with the word READY only.", "")) && Date.now() < deadline) {
            await pause(200);
            const state = await send("Runtime.evaluate", { expression: "document.body?.innerText.slice(-1200)", returnByValue: true });
            text = state.result?.value || "";
          }
          if (!/\bREADY\b/.test(text.replace("Reply with the word READY only.", "")) || text.includes("Failed to load history"))
            throw new Error(`${member} synthetic model answer did not render in Chrome`);
          console.log("disposable model answer", JSON.stringify({ member, readyVisible: true }));
        }
      }
      await send("Network.clearBrowserCookies");
      messages.length = 0;
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    const waitForClose = ms => new Promise(resolve => {
      const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, ms);
      const onClose = () => { clearTimeout(timer); resolve(true); };
      child.once("close", onClose);
    });
    if (child.exitCode === null && child.signalCode === null) {
      const close = waitForClose(3000);
      child.kill("SIGTERM");
      if (!await close && child.exitCode === null && child.signalCode === null) {
        const killed = waitForClose(2000);
        child.kill("SIGKILL");
        await killed;
      }
    }
    if (child.exitCode === null && child.signalCode === null)
      throw new Error(`Chrome did not stop; preserving temporary profile ${profile}`);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
