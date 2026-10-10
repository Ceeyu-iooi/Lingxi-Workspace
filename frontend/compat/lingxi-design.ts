// @ts-nocheck
/** Shared product surfaces. Preview and the authenticated app use these builders. */
(() => {
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const request = (...args) => window.workbenchRequest(...args);
  function identity(host, options = {}) {
    host.innerHTML = `<form id="${options.create ? "profile-create-form" : "lingxi-identity-form"}" class="lingxi-identity"><div class="lingxi-avatar-editor"><img class="wb-avatar-preview" alt="头像预览" ${options.avatar ? `src="${escape(options.avatar)}"` : "hidden"}><span class="wb-avatar-preview wb-avatar-placeholder" ${options.avatar ? "hidden" : ""}>${escape(Array.from(options.name || "我").slice(0,2).join(""))}</span><label class="onboarding-action secondary">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" data-avatar hidden></label><button type="button" class="onboarding-action quiet" data-avatar-remove>移除</button><small>PNG、JPEG、WebP，最大 3 MB；也可稍后设置。</small></div><label class="control-field">用户名<input id="${options.create ? "profile-username" : "profile-name"}" name="displayName" value="${escape(options.name)}" required maxlength="30" autocomplete="off" placeholder="给你的工作坊起个名字"></label><p class="login-error onboarding-error" role="alert"></p><button type="submit" class="onboarding-action">${options.create ? "创建 Profile 并继续" : "保存资料"}</button></form>`;
    const form = host.querySelector("form"), file = form.querySelector("[data-avatar]"), image = form.querySelector("img");
    let avatar = null, remove = false, imageUrl = null, busy = false, revision = 0, reading = false, avatarReadSequence=0;
    form.addEventListener("input",()=>revision++);
    let wasConnected=form.isConnected;const identityObserver=new MutationObserver(()=>{if(form.isConnected){wasConnected=true;return;}if(wasConnected){avatarReadSequence++;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;identityObserver.disconnect();}});identityObserver.observe(document.body,{childList:true,subtree:true});
    file.onchange = async () => {
      const selected = file.files[0]; if (!selected) return;
      if (selected.size > 3 * 1024 * 1024) { form.querySelector("[role=alert]").textContent = "头像最大为 3 MB"; file.value = ""; return; }
      revision++; reading=true;const avatarTicket=++avatarReadSequence;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(selected); image.src = imageUrl; image.hidden = false;
      form.querySelector(".wb-avatar-placeholder").hidden = true; remove = false;
      const readAvatar = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(selected); }); if(avatarTicket===avatarReadSequence){avatar=readAvatar;reading=false;}
    };
    form.querySelector("[data-avatar-remove]").onclick = () => { revision++; avatarReadSequence++;reading=false;avatar = null; remove = true; file.value = ""; image.hidden = true; form.querySelector(".wb-avatar-placeholder").hidden = false; };
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
    return '<button class="cir-btn" type="button" data-codex-login>读取Codex<svg class="cir-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10"/></svg></button>';
  }
  function profileMenuMarkup(name, avatar="") {
    const initials=Array.from(name||"我").slice(0,2).join("").toLocaleUpperCase();
    return `<button type="button" class="lingxi-profile-identity" role="menuitem" data-profile-identity><span class="account-avatar" aria-hidden="true">${avatar?`<img src="${escape(avatar)}" alt="">`:escape(initials)}</span><strong>${escape(name)}</strong></button><div class="lingxi-profile-menu-separator"></div><a role="menuitem" href="#/settings/general"><span aria-hidden="true">⚙</span>设置</a><a role="menuitem" href="#/settings/about"><span aria-hidden="true">ⓘ</span>关于</a><button type="button" role="menuitem" data-profile-switch><span aria-hidden="true">⇄</span>切换实例</button>`;
  }
  async function profileCards(host, selecting=false) {
    const native=window.workbenchDesktop;
    const state=await (native?.profile?.() || request('GET','/api/profile/location'));
    if(!host.isConnected)return;
    host.innerHTML='<div class="onboarding-cards lingxi-profile-cards"><article class="onboarding-card" data-selected="true"><h2>当前 Profile</h2><p data-current-profile></p><small>每个 Profile 独立保存工作内容与设置。</small></article><article class="onboarding-card"><h2>'+ (native?'选择或创建 Profile':'连接其他实例')+'</h2><p>'+(native?'打开已有资料，或在空文件夹创建工作空间。':'输入另一台工作坊的服务地址。')+'</p>'+(native?'<button class="onboarding-action secondary" data-profile-choose>选择文件夹</button>':'<label class="control-field">服务地址<input type="url" data-instance-url placeholder="http://localhost:8765" autocomplete="url"></label><button class="onboarding-action secondary" data-profile-connect>连接实例</button>')+'</article></div><p class="onboarding-error" role="alert"></p>';
    host.querySelector('[data-current-profile]').textContent=state.root||state.profileRoot||'当前工作坊';
    const error=message=>{if(host.isConnected)host.querySelector('[role=alert]').textContent=message;};
    if(native)host.querySelector('[data-profile-choose]').onclick=async event=>{const button=event.currentTarget;button.disabled=true;try{const target=await native.onboardingChoose();if(!target)return;await window.wbLayoutStorage?.flush?.();await native.onboardingSelect(target);}catch(e){error(e.message);}finally{if(button.isConnected)button.disabled=false;}};
    else host.querySelector('[data-profile-connect]').onclick=async()=>{try{const url=new URL(host.querySelector('[data-instance-url]').value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('请输入不含凭据的 HTTP 或 HTTPS 服务地址');await window.wbLayoutStorage?.flush?.();location.assign(url.href);}catch(e){error(e.message);}};
  }
  async function selectProfile(){
    if(window.settingsCenter?.close?.()===false)return;
    const d=document.createElement('dialog');d.className='control-dialog lingxi-profile-selector';d.innerHTML='<div class="onboarding-brand"><img src="assets/lingxi-logo.svg" alt="灵犀"><span>灵犀工作坊</span></div><h1 class="onboarding-heading">选择你的工作空间</h1><div data-profile-cards></div><div class="onboarding-actions"><button class="onboarding-action quiet" data-close>返回工作台</button></div>';document.body.append(d);d.querySelector('[data-close]').onclick=()=>d.close();d.addEventListener('close',()=>d.remove(),{once:true});d.showModal();try{await profileCards(d.querySelector('[data-profile-cards]'),true);}catch(e){d.querySelector('[data-profile-cards]').textContent=e.message;}
  }
  function about() {
    const version=__LINGXI_VERSION__;
    return `<section class="lingxi-about"><header class="lingxi-about-brand"><img src="assets/lingxi-logo.svg" alt="灵犀" width="48"><div><h2>灵犀工作坊</h2><p>版本 ${version}</p></div></header><div class="lingxi-about-cards"><article class="lingxi-about-card"><div><h3>检查更新</h3><p>${window.workbenchDesktop?.checkUpdate?"检查正式版与预发布版，下载和安装由你确认。":"联网检查最新版与预发布，直接获取并校验安装包。"}</p><p class="lingxi-about-update-status" data-about-update-status role="status"></p></div><div class="lingxi-about-card-actions lingxi-update-actions"><button type="button" class="btn lingxi-update-primary" data-about-check-update>检查更新</button><button type="button" class="lingxi-update-details" data-update-details>更新详情 ↗</button></div></article><article class="lingxi-about-card"><div><h3>GitHub</h3><p>项目源码、使用说明与问题反馈。</p></div><a href="https://github.com/Ceeyu-iooi/Lingxi-Workspace" target="_blank" rel="noopener noreferrer">查看 GitHub ↗</a></article><article class="lingxi-about-card"><div><h3>设计预览</h3><p>查看灵犀的实际组件、浅深配色与交互状态。</p></div><div class="lingxi-about-card-actions"><a href="preview.html" target="_blank" rel="noopener">浅色 ↗</a><a href="preview-dark.html" target="_blank" rel="noopener">深色 ↗</a></div></article><article class="lingxi-about-card"><div><h3>引用与致谢</h3><p>设计展示结构参考 VoltAgent awesome-design-md；原生绘图适配参考 DeepSeek Harness。实际控件来自已核验的集成组件。</p><details><summary>查看来源</summary><p><a href="https://github.com/VoltAgent/awesome-design-md" target="_blank" rel="noopener noreferrer">VoltAgent awesome-design-md ↗</a><br><a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener noreferrer">DeepSeek Harness ↗</a><br>JellyRadio、LatticeLoader、SlideCommit、SquishSwitch、WakeSlider：React Bits 应用内集成，保留来源与许可证。</p></details></div></article><article class="lingxi-about-card"><div><h3>许可证</h3><p>灵犀工作坊采用 CC-BY-NC-4.0。第三方组件遵循各自许可证。</p><details><summary>查看许可说明</summary><p>React Bits：MIT + Commons Clause，仅作为应用集成分发；Node.js 与 SQLite 保留各自许可；设计参考及 DeepSeek Harness：MIT。完整许可和来源说明随产品提供。${window.workbenchDesktop?'<br><a href="/licenses/chromium" target="_blank" rel="noopener">Chromium 完整许可证 ↗</a>':''}</p></details></div></article><article class="lingxi-about-card"><div><h3>隐私与资料</h3><p>资料保存在当前 Profile。凭据只由本机后端读取，查询发送至对应官方服务。</p><details><summary>查看隐私说明</summary><p>不上传工作内容作为遥测。网页与桌面资料相互独立；携带凭据的备份必须使用加密 Profile 备份。旧桌面客户端首次进入预发布更新机制，请手动下载新安装包，升级保留 Profile。</p></details></div></article>${window.workbenchDesktop?.closeBehavior?'<article class="lingxi-about-card"><div><h3>桌面行为</h3><p>关闭窗口后保留后台，随时从托盘恢复。</p></div><label>收至托盘 <input type="checkbox" data-tray-setting checked></label></article>':''}</div></section>`;
  }
  function mountAbout(host) {
    host.innerHTML=about();
    const bridge=window.workbenchDesktop||{checkUpdate:()=>request('POST','/api/updates/check',{}),downloadUpdate:()=>request('POST','/api/updates/download',{}),updateState:()=>request('GET','/api/updates/state')};
    const check=host.querySelector('[data-about-check-update]'),status=host.querySelector('[data-about-update-status]');let current={status:'idle'},pollTimer;
    const details=()=>{
      const d=document.createElement('dialog');d.className='control-dialog lingxi-update-dialog';d.innerHTML='<header class="control-dialog-head"><h3></h3><button class="btn ghost" data-close aria-label="关闭">×</button></header><div class="lingxi-release-notes"></div><p data-update-message role="status"></p><progress max="100" value="0" hidden></progress><div class="control-dialog-actions"><button class="btn ghost" data-later>暂不安装</button><button class="btn" data-install></button></div>';
      d.querySelector('h3').textContent=current.availableVersion?'发现新版本 '+current.availableVersion:'更新详情';
      const notes=String(current.releaseNotes||'尚未获取新版本详情。');d.querySelector('.lingxi-release-notes').innerHTML=DOMPurify.sanitize(marked.parse(notes),{ALLOWED_TAGS:['h2','h3','h4','p','ul','ol','li','strong','em','code','pre','a','br','hr'],ALLOWED_ATTR:['href','title']});d.querySelectorAll('a').forEach(a=>{try{if(new URL(a.href).protocol!=='https:')a.removeAttribute('href');else{a.target='_blank';a.rel='noopener noreferrer';}}catch{a.removeAttribute('href');}});
      const button=d.querySelector('[data-install]'),message=d.querySelector('[data-update-message]'),progress=d.querySelector('progress');let alive=true,timer;
      const paint=()=>{if(!alive)return;const running=['downloading','installing'].includes(current.status);button.disabled=running;button.hidden=!['available','cancelled','downloaded','downloading','installing'].includes(current.status);button.textContent=current.status==='downloaded'?(window.workbenchDesktop?(current.portable?'打开便携更新包':'重启安装'):'获取安装包'):'下载安装';message.textContent=current.error|| (current.status==='downloading'?'正在下载 '+Math.round(current.progress||0)+'%':current.status==='downloaded'?'下载与校验完成，可以确认安装':'');progress.hidden=!['downloading','downloaded'].includes(current.status);progress.value=current.progress||0;};
      const poll=async()=>{if(!alive)return;try{current=await bridge.updateState();paint();if(current.status==='downloading')timer=setTimeout(poll,500);}catch(e){message.textContent=e.message;button.disabled=false;}};
      button.onclick=async()=>{button.disabled=true;try{if(current.status==='downloaded'){if(window.workbenchDesktop){await window.wbLayoutStorage?.flush?.();current=await bridge.installUpdate();}else{const link=document.createElement('a');link.href='/api/updates/file';link.download=current.file||'';link.click();}}else{current={...current,status:'downloading',progress:0};paint();const job=bridge.downloadUpdate();void poll();current=await job;}paint();if(current.status==='downloading')poll();}catch(e){message.textContent=e.message;button.disabled=false;}};
      d.querySelector('[data-close]').onclick=()=>d.close();d.querySelector('[data-later]').onclick=()=>d.close();d.addEventListener('close',()=>{alive=false;clearTimeout(timer);d.remove();},{once:true});document.body.append(d);paint();d.showModal();
    };
    check.onclick=async()=>{check.disabled=true;status.textContent='正在检查更新…';try{current=await bridge.checkUpdate();if(!check.isConnected)return;status.textContent=current.status==='available'?'发现新版本 '+current.availableVersion:current.status==='latest'?'当前已是最新版本':current.error||'';if(['available','downloaded'].includes(current.status))details();}catch(e){if(status.isConnected)status.textContent=e.message;}finally{if(check.isConnected)check.disabled=false;}};
    host.querySelector('[data-update-details]').onclick=details;
    const tray=host.querySelector('[data-tray-setting]');if(tray){bridge.closeState().then(value=>{if(tray.isConnected)tray.checked=value.closeToTray;});tray.onchange=()=>bridge.closeBehavior(tray.checked).catch(e=>status.textContent=e.message);}
  }
  function resetBatteries(host,resetCredits) {
    const count=Number.isSafeInteger(resetCredits?.availableCount)&&resetCredits.availableCount>=0?resetCredits.availableCount:null;
    host.innerHTML=`<div class="lingxi-reset-inline"><span>重置卡：${count===null?'--':count}张</span><div class="lingxi-reset-batteries">${count===null?'':Array.from({length:count},(_,i)=>`<span class="lingxi-reset-battery" data-reset-index="${i}" tabindex="0"><span data-battery-gauge></span></span>`).join('')}</div></div>`;
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
    host.innerHTML='<div class="lingxi-codex-login"><h2>读取本机 Codex 登录凭据</h2><p class="meta">授权灵犀只读本机已有登录，用于查询额度、Credit 与重置卡。</p><div class="control-actions"><button type="button" class="onboarding-action" data-authorize>授权读取</button><button type="button" class="onboarding-action quiet" data-revoke>撤销授权</button></div><p data-login-status role="status"></p></div>';
    const run=async authorized=>{const button=host.querySelector('[data-authorize]');button.disabled=true;try{const result=await request('POST','/api/codex/local-authorization',{authorized});if(!host.isConnected)return;host.querySelector('[data-login-status]').textContent=result.unavailable?.quota || (authorized?'已授权读取本机登录':'已撤销读取授权');completed();}catch(error){if(host.isConnected)host.querySelector('[data-login-status]').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}};
    host.querySelector('[data-authorize]').onclick=()=>run(true);host.querySelector('[data-revoke]').onclick=()=>run(false);
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
  window.LingxiDesign = { profileCards, selectProfile, resetBatteries, mountAbout, profileMenuMarkup, connectButton, identity, about, login, tooltipMarkup, header, escape };
  const ready=()=>{const main=document.getElementById("main");if(!main)return;let scheduled=false;new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;header();});}).observe(main,{childList:true,subtree:true,attributes:true,attributeFilter:["class","aria-selected","aria-pressed"]});header();};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else queueMicrotask(ready);
})();
