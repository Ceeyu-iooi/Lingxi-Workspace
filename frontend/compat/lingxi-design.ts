// @ts-nocheck
/** Shared product surfaces. Preview and the authenticated app use these builders. */
(() => {
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const request = (...args) => window.workbenchRequest(...args);
  function identity(host, options = {}) {
    host.innerHTML = `<form id="${options.create ? "profile-create-form" : "lingxi-identity-form"}" class="lingxi-identity"><div class="lingxi-avatar-editor"><img class="wb-avatar-preview" alt="头像预览" ${options.avatar ? `src="${escape(options.avatar)}"` : "hidden"}><span class="wb-avatar-preview wb-avatar-placeholder" ${options.avatar ? "hidden" : ""}>${escape(Array.from(options.name || "我").slice(0,2).join(""))}</span><label class="onboarding-action secondary">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar hidden></label><button type="button" class="onboarding-action quiet" data-avatar-remove>移除</button><small>PNG、JPEG、WebP，最大 3 MB；也可稍后设置。</small></div><label class="control-field">用户名<input id="${options.create ? "profile-username" : "profile-name"}" name="displayName" value="${escape(options.name)}" required maxlength="30" autocomplete="off" placeholder="给你的工作坊起个名字"></label><p class="login-error onboarding-error" role="alert"></p><button type="submit" class="onboarding-action">${options.create ? "创建 Profile 并继续" : "保存资料"}</button></form>`;
    const form = host.querySelector("form"), file = form.querySelector("[data-avatar]"), image = form.querySelector("img");
    let avatar = null, remove = false, imageUrl = null, busy = false, revision = 0, reading = false;
    form.addEventListener("input",()=>revision++);
    file.onchange = async () => {
      const selected = file.files[0]; if (!selected) return;
      if (selected.size > 3 * 1024 * 1024) { form.querySelector("[role=alert]").textContent = "头像最大为 3 MB"; file.value = ""; return; }
      revision++; reading=true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(selected); image.src = imageUrl; image.hidden = false;
      form.querySelector(".wb-avatar-placeholder").hidden = true; remove = false;
      avatar = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(selected); }); reading=false;
    };
    form.querySelector("[data-avatar-remove]").onclick = () => { revision++; avatar = null; remove = true; file.value = ""; image.hidden = true; form.querySelector(".wb-avatar-placeholder").hidden = false; };
    form.onsubmit = async event => {
      event.preventDefault(); if (busy || reading || !form.reportValidity()) return;
      const savedRevision=revision;
      busy = true; const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try { await options.save?.(form.elements.displayName.value.trim(), avatar, remove); if(savedRevision===revision)form.querySelectorAll("[data-wb-dirty]").forEach(e=>delete e.dataset.wbDirty); if (imageUrl&&!form.isConnected) URL.revokeObjectURL(imageUrl); }
      catch (error) { if (form.isConnected) form.querySelector("[role=alert]").textContent = error.message; }
      finally { busy = false; if (button.isConnected) button.disabled = false; }
    };
  }
  function connectButton() {
    return '<button class="cir-btn" type="button" data-codex-login>连接Codex<svg class="cir-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></button>';
  }
  function profileMenuMarkup(name, avatar="") {
    const initials=Array.from(name||"我").slice(0,2).join("").toLocaleUpperCase();
    return `<button type="button" class="lingxi-profile-identity" role="menuitem" data-profile-identity><span class="account-avatar" aria-hidden="true">${avatar?`<img src="${escape(avatar)}" alt="">`:escape(initials)}</span><strong>${escape(name)}</strong></button><div class="lingxi-profile-menu-separator"></div><a role="menuitem" href="#/settings/general"><span aria-hidden="true">⚙</span>设置</a><a role="menuitem" href="#/settings/about"><span aria-hidden="true">ⓘ</span>关于</a><a role="menuitem" href="#/settings/data"><span aria-hidden="true">⇄</span>切换实例</a>`;
  }
  function about() {
    const version=typeof __LINGXI_VERSION__!=="undefined"?__LINGXI_VERSION__:"0.0.34";
    return `<section class="lingxi-about"><header class="lingxi-about-brand"><img src="assets/lingxi-logo.svg" alt="灵犀" width="48"><div><h2>灵犀工作坊</h2><p>版本 ${version}</p></div></header><div class="lingxi-about-cards"><article class="lingxi-about-card"><div><h3>检查更新</h3><p>${window.workbenchDesktop?.checkUpdate?"检查正式版与预发布版，下载和安装由你确认。":"联网检查最新版与预发布，直接获取并校验安装包。"}</p><p class="lingxi-about-update-status" data-about-update-status role="status"></p></div>${window.workbenchDesktop?.checkUpdate?'<div class="lingxi-about-card-actions"><button type="button" class="btn lingxi-update-primary" data-about-check-update>检查更新</button><a href="#/settings/updates">更新详情 ↗</a></div>':'<button type="button" class="lingxi-update-primary" data-about-check-update>检查更新</button>'}</article><article class="lingxi-about-card"><div><h3>GitHub</h3><p>项目源码、使用说明与问题反馈。</p></div><a href="https://github.com/Ceeyu-iooi/lingxi-workbench-web" target="_blank" rel="noopener noreferrer">查看 GitHub ↗</a></article><article class="lingxi-about-card"><div><h3>设计预览</h3><p>查看灵犀的实际组件、浅深配色与交互状态。</p></div><div class="lingxi-about-card-actions"><a href="preview.html" target="_blank" rel="noopener">浅色 ↗</a><a href="preview-dark.html" target="_blank" rel="noopener">深色 ↗</a></div></article><article class="lingxi-about-card"><div><h3>引用与致谢</h3><p>设计展示结构参考 VoltAgent awesome-design-md；原生绘图适配参考 DeepSeek Harness。实际控件来自已核验的集成组件。</p><details><summary>查看来源</summary><p><a href="https://github.com/VoltAgent/awesome-design-md" target="_blank" rel="noopener noreferrer">VoltAgent awesome-design-md ↗</a><br><a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener noreferrer">DeepSeek Harness ↗</a><br>JellyRadio、LatticeLoader、SlideCommit、SquishSwitch、WakeSlider：React Bits 应用内集成，保留来源与许可证。</p></details></div></article><article class="lingxi-about-card"><div><h3>许可证</h3><p>灵犀工作坊采用 CC-BY-NC-4.0。第三方组件遵循各自许可证。</p><details><summary>查看许可说明</summary><p>React Bits：MIT + Commons Clause，仅作为应用集成分发；Codex CLI：Apache-2.0；设计参考及 DeepSeek Harness：MIT。完整许可和来源说明随产品提供。</p></details></div></article><article class="lingxi-about-card"><div><h3>隐私与资料</h3><p>资料保存在当前 Profile。凭据只由本机后端读取，查询发送至对应官方服务。</p><details><summary>查看隐私说明</summary><p>不上传工作内容作为遥测。网页与桌面资料相互独立；携带凭据的备份必须使用加密 Profile 备份。旧桌面客户端首次进入预发布更新机制，请手动下载新安装包，升级保留 Profile。</p></details></div></article>${window.workbenchDesktop?.closeBehavior?'<article class="lingxi-about-card"><div><h3>桌面行为</h3><p>关闭窗口后保留后台，随时从托盘恢复。</p></div><label>收至托盘 <input type="checkbox" data-tray-setting checked></label></article>':''}</div></section>`;
  }
  function mountAbout(host) {
    host.innerHTML=about();
    const check=host.querySelector('[data-about-check-update]');
    const bridge=window.workbenchDesktop || {checkUpdate:()=>request('POST','/api/updates/check',{}),downloadUpdate:()=>request('POST','/api/updates/download',{}),updateState:()=>request('GET','/api/updates/state')};
    if(check) {
      let current={status:'idle'};
      check.onclick=async()=>{
        const status=host.querySelector('[data-about-update-status]');check.disabled=true;
        try{
          if(current.status==='available'||current.status==='cancelled'){status.textContent='正在下载更新…';current=await bridge.downloadUpdate();}
          else if(current.status==='downloaded'){
            if(!window.workbenchDesktop){const a=document.createElement('a');a.href='/api/updates/file';a.download=current.file||'';a.click();status.textContent='安装包已下载并校验，打开安装包即可安装。';return;}
            if(!confirm('保存当前状态并重启安装更新？Profile 将保留。'))return;
            await window.wbLayoutStorage?.flush?.();current=await window.workbenchDesktop.installUpdate();
          }else{status.textContent='正在检查更新…';current=await bridge.checkUpdate();}
          const render=state=>{if(!check.isConnected)return;current=state;status.textContent=state.status==='available'?'发现新版本 '+state.availableVersion:state.status==='latest'?'当前已是最新版本':state.status==='downloaded'?'下载与校验完成，可确认安装':state.status==='downloading'?'正在下载 '+Math.round(state.progress||0)+'%':state.error||'';check.textContent=state.status==='available'||state.status==='cancelled'?'下载更新':state.status==='downloaded'?(window.workbenchDesktop?'确认安装':'获取安装包'):'检查更新';check.disabled=['checking','downloading','installing'].includes(state.status);};
          render(current);
          if(current.status==='downloading'){const timer=setInterval(async()=>{if(!check.isConnected){clearInterval(timer);return;}try{const state=await bridge.updateState();render(state);if(state.status!=='downloading')clearInterval(timer);}catch{clearInterval(timer);check.disabled=false;}},750);}
        }catch(error){status.textContent=error.message;}finally{if(check.isConnected&&current.status!=='downloading')check.disabled=false;}
      };
    }
    const tray=host.querySelector('[data-tray-setting]');
    if(tray){window.workbenchDesktop.closeState().then(state=>{if(tray.isConnected)tray.checked=state.closeToTray;});tray.onchange=()=>window.workbenchDesktop.closeBehavior(tray.checked).catch(error=>{host.querySelector('[data-about-update-status]').textContent=error.message;});}
  }
  function resetBatteries(host,resetCredits) {
    const count=Number.isSafeInteger(resetCredits?.availableCount)&&resetCredits.availableCount>=0?resetCredits.availableCount:null;
    host.innerHTML=`<div class="lingxi-reset-inline"><span>重置卡：${count===null?'—':count}张</span><div class="lingxi-reset-batteries">${count===null?'':Array.from({length:count},(_,i)=>`<span class="lingxi-reset-battery" data-reset-index="${i}" tabindex="0"><span data-battery-gauge></span></span>`).join('')}</div></div>`;
    const paint=()=>host.querySelectorAll('[data-reset-index]').forEach(node=>{
      const card=resetCredits?.credits?.[Number(node.dataset.resetIndex)],expires=Number.isFinite(card?.expiresAt)?card.expiresAt*1000:null,granted=Number.isFinite(card?.grantedAt)?card.grantedAt*1000:null;
      const left=expires===null?null:Math.max(0,expires-Date.now()),percent=left===null||granted===null||expires<=granted?null:Math.min(100,Math.max(0,left/(expires-granted)*100));
      const duration=left===null?'未返回到期时间':left===0?'已到期':left>=86400000?Math.ceil(left/86400000)+'天后到期':Math.ceil(left/3600000)+'小时后到期';
      const date=expires===null?'':new Date(expires).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
      node._expiryInfo={duration,date,percent};
      node.title=duration+(date?' · '+date:'');node.setAttribute("aria-label",node.title);node.dataset.unknown=String(percent===null);const gauge=node.querySelector("[data-battery-gauge]");window.WorkbenchReact.resetBattery(gauge,{value:percent,label:node.title});gauge.tabIndex=-1;
      if(!node._expiryTip&&window.usageCharts){node._expiryTip=window.usageCharts.tooltip(node);const show=e=>{const r=node.getBoundingClientRect(),info=node._expiryInfo;node._expiryTip.show({primary:info.duration,date:info.date,rows:info.percent===null?[]:[{label:'剩余有效期',value:info.percent.toFixed(1)+'%',color:'#2563EB'}]},e?.clientX??r.left+r.width/2,e?.clientY??r.top);};node.addEventListener('pointerenter',show);node.addEventListener('pointermove',show);node.addEventListener('focus',()=>show());node.addEventListener('pointerleave',()=>node._expiryTip.hide());node.addEventListener('blur',()=>node._expiryTip.hide());}
    });
    paint();return paint;
  }
  async function login(host, completed = () => {}) {
    let timer, alive = true, ownedId=null;
    host.innerHTML = `<div class="lingxi-codex-login"><h2>连接 Codex 账户</h2><p class="meta">登录仅用于查询订阅额度、Credit 与重置卡。凭据保存在当前 Profile。</p><div class="control-actions"><button type="button" class="onboarding-action" data-browser>使用 ChatGPT 登录</button><button type="button" class="onboarding-action secondary" data-device>使用设备码</button><button type="button" class="onboarding-action quiet" data-cancel>取消登录</button></div><p data-login-status role="status"></p><a data-auth-url target="_blank" rel="noopener noreferrer" hidden>打开官方授权页面 ↗</a><code data-user-code></code></div>`;
    const paint = async s => {
      if(s.loginId)ownedId=s.loginId;
      if (!host.isConnected || !alive) {if(s.loginId)request("POST","/api/codex/login/cancel",{loginId:s.loginId}).catch(()=>{});return;}
      host.querySelector("[data-login-status]").textContent = ({starting:"正在准备授权…",waiting:"请在官方页面完成授权",success:"账户已连接",cancelled:"登录已取消",expired:"登录已超时",error:s.error})[s.status] || "";
      host.querySelector("[data-user-code]").textContent = s.userCode || "";
      const a = host.querySelector("[data-auth-url]"); a.hidden = !s.authUrl; if (s.authUrl) a.href = s.authUrl;
      if (s.status === "success") { clearInterval(timer); completed(); }
      if (["error","cancelled","expired"].includes(s.status)) clearInterval(timer);
    };
    for (const mode of ["browser","device"]) host.querySelector(`[data-${mode}]`).onclick = async () => {
      clearInterval(timer);
      try { const s=await request("POST","/api/codex/login/start",{mode}); await paint(s); timer=setInterval(async()=>{if(!host.isConnected){clearInterval(timer);if(ownedId)await request("POST","/api/codex/login/cancel",{loginId:ownedId}).catch(()=>{});return;}try{await paint(await request("GET","/api/codex/login/status"));}catch{clearInterval(timer);}},1500); }
      catch(error){paint({status:"error",error:error.message});}
    };
    host.querySelector("[data-cancel]").onclick = async()=>{clearInterval(timer);paint(await request("POST","/api/codex/login/cancel",{}));};
    return () => { alive=false; clearInterval(timer); if(ownedId)request("POST","/api/codex/login/cancel",{loginId:ownedId}).catch(()=>{}); };
  }
  function tooltipMarkup(data) {
    if (typeof data === "string") {
      const lines = data.split("\n"), dateIndex = lines.findIndex(l => /^\d{4}[-年/]\d/.test(l));
      const date = dateIndex >= 0 ? lines.splice(dateIndex,1)[0] : null;
      // Legacy callers keep their information until converted to structured rows.
      data = { primary: lines.shift() || "—", date, rows: lines.map((l,i)=>({ label:l, value:"", color:["#2563EB","#F28C38","#2A9D99"][i%3] })) };
    }
    return `<strong class="lingxi-tip-primary">${escape(data.primary)}</strong>${data.date?`<small class="lingxi-tip-date">${escape(data.date)}</small>`:""}${data.rows?.length?`<div class="lingxi-tip-rows">${data.rows.map(r=>`<div><i style="background:${/^#[0-9a-f]{3,8}$/i.test(r.color)?r.color:'#2563EB'}"></i><span title="${escape(r.label)}">${escape(r.label)}</span><b>${escape(r.value)}</b></div>`).join("")}</div>`:""}`;
  }
  function header() {
    const main=document.getElementById("main"), shell=main?.parentElement; if(!main||!shell) return;
    let source=main.querySelector(".usage-tabs") || main.querySelector(".module-tabs") || main.querySelector(".module-surface .page-head");
    if(source && !source.textContent.trim())source=null;
    const panel=main.querySelector(".agent-value-panel"), valueHost=main.querySelector("[data-codex-value]");if(panel&&valueHost&&main.querySelector("#usage-body")?.dataset.usageScope==="codex"&&panel.parentElement!==valueHost)valueHost.replaceChildren(panel);
    let bar=shell.querySelector(":scope > .lingxi-module-bar");
    if(!bar){bar=document.createElement("div");bar.className="lingxi-module-bar";shell.prepend(bar);}
    const inSettings=location.hash.startsWith("#/settings"); if(inSettings) return;
    if(source){
      if(!source.classList.contains('lingxi-module-source'))source.classList.add('lingxi-module-source');
      const signature=source.innerHTML;
      if(bar._signature!==signature){
        const focusLabel=bar.contains(document.activeElement)?document.activeElement.textContent.trim():null;
        const clone=source.cloneNode(true);clone.classList.remove('lingxi-module-source');clone.removeAttribute('id');clone.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));
        const originals=[...source.querySelectorAll('button,a')];clone.querySelectorAll('button,a').forEach((e,i)=>e.addEventListener('click',event=>{event.preventDefault();originals[i]?.click();}));
        clone.querySelectorAll('[role=tab]').forEach((tab,i)=>tab.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...clone.querySelectorAll('[role=tab]')],next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();}));
        bar.replaceChildren(clone);bar._signature=signature;
        if(focusLabel)[...bar.querySelectorAll('button')].find(e=>e.textContent.trim()===focusLabel)?.focus();
      }
      bar.dataset.view=location.hash.split('/')[1]||"overview";
    }
    else if(!bar.textContent.trim() || bar.dataset.view!==location.hash.split('/')[1]){const label=document.querySelector('#nav a.on .nav-label')?.textContent||"工作台";bar.textContent=label;bar.dataset.view=location.hash.split('/')[1]||"overview";}
  }
  window.LingxiDesign = { resetBatteries, mountAbout, profileMenuMarkup, connectButton, identity, about, login, tooltipMarkup, header, escape };
  const ready=()=>{const main=document.getElementById("main");if(!main)return;let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;header();});}).observe(main,{childList:true,subtree:true,attributes:true,attributeFilter:["class","aria-selected","aria-pressed"]});header();};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else queueMicrotask(ready);
})();
