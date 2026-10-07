/* Compact command navigation inspired by ZCode's keyboard-first workspace. */
(() => {
  let snapshot = {user:null,projects:[],tasks:[]}, selected = 0, matches = [], returnFocus;
  const routes = [{title:'总览',view:'overview'},{title:'项目与待办',view:'projects'},{title:'月度总结',view:'summary'},{title:'近期热点',view:'news'},{title:'记账',view:'finance'},{title:'用量监测',view:'usage'},{title:'提示词管理',view:'prompts'},{title:'技能管理',view:'skills'},{title:'设置',view:'settings'}];
  window.addEventListener('DOMContentLoaded', () => {
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'shell-search'; trigger.id = 'command-trigger';
    trigger.innerHTML = '<span>搜索与跳转</span><kbd>Ctrl K</kbd>';
    document.querySelector('.side nav').before(trigger);
    const dialog = document.createElement('dialog'); dialog.className = 'command-dialog'; dialog.id = 'command-dialog';
    dialog.setAttribute('aria-label','搜索与跳转');
    dialog.innerHTML = '<input id="command-input" type="search" autocomplete="off" placeholder="搜索页面、项目或待办" aria-label="搜索页面、项目或待办"><div class="command-results" id="command-results" role="listbox" aria-label="搜索结果"></div><div class="command-footer"><span>↑ ↓ 选择 · Enter 打开</span><span>Esc 关闭</span></div>';
    document.body.appendChild(dialog);
    const input = dialog.querySelector('input'), list = dialog.querySelector('.command-results');
    const choose = index => {
      const item = matches[index]; if (!item) return;
      dialog.close(); location.hash = '#/' + item.view;
      requestAnimationFrame(() => {
        if (!item.id) return;
        const el = document.querySelector(`${item.kind === '项目' ? '.proj-row' : '.todo-item'}[data-id="${CSS.escape(item.id)}"]`);
        if (el) { el.scrollIntoView({block:'center'}); el.classList.add('command-highlight'); setTimeout(() => el.classList.remove('command-highlight'),2000); }
      });
    };
    const highlight = () => {
      [...list.children].forEach((el,i) => {el.setAttribute('aria-selected',String(i === selected)); el.id='command-option-'+i;});
      input.setAttribute('aria-activedescendant','command-option-'+selected);
      list.children[selected]?.scrollIntoView({block:'nearest'});
    };
    const draw = () => {
      const query = input.value.trim().toLocaleLowerCase(); selected=0;
      const extra=[...(window.controlCenter?.sections||[]).map(s=>({title:s[1],view:'settings/'+s[0]}))];
      const entries = [...routes.concat(extra).map(route=>({...route,kind:'页面'})),...snapshot.projects.map(p=>({title:p.name,id:p.id,view:'projects',kind:'项目'})),...snapshot.tasks.map(t=>({title:t.title,id:t.id,view:'projects',kind:'待办'}))];
      matches = entries.filter(item=>item.title.toLocaleLowerCase().includes(query)).slice(0,30);
      list.replaceChildren();
      matches.forEach((item,i) => { const button=document.createElement('button');button.type='button';button.className='command-result';button.setAttribute('role','option');const label=document.createElement('span');label.textContent=item.title;const kind=document.createElement('small');kind.textContent=item.kind;button.append(label,kind);button.onclick=()=>choose(i);list.append(button); });
      if (!matches.length) { const empty=document.createElement('div');empty.className='empty';empty.textContent='没有匹配结果，试试其他关键词';list.append(empty);input.removeAttribute('aria-activedescendant'); }
      else highlight();
    };
    input.setAttribute('role','combobox');input.setAttribute('aria-controls','command-results');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','true');
    const open = () => { if (!snapshot.user || dialog.open) return; returnFocus=document.activeElement;dialog.showModal();input.value='';draw();input.focus(); };
    const mobileTrigger = document.createElement('button');mobileTrigger.type='button';mobileTrigger.className='mobile-command-trigger';mobileTrigger.textContent='⌕';mobileTrigger.setAttribute('aria-label','搜索与跳转');mobileTrigger.onclick=open;document.querySelector('.shell-heading').prepend(mobileTrigger);
    trigger.onclick=open; input.oninput=draw;
    input.onkeydown=e=>{if (e.key==='Escape') {e.preventDefault();dialog.close();} else if (e.key==='ArrowDown'||e.key==='ArrowUp') { e.preventDefault();selected=Math.max(0,Math.min(matches.length-1,selected+(e.key==='ArrowDown'?1:-1)));highlight(); } else if(e.key==='Enter'){e.preventDefault();choose(selected);} };
    dialog.addEventListener('close',()=>{if(returnFocus?.isConnected)returnFocus.focus();});
    dialog.onclick=e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}};
    window.addEventListener('workbench:state',e=>{snapshot=e.detail;trigger.disabled=!snapshot.user;if(!snapshot.user&&dialog.open)dialog.close();});
    window.addEventListener('workbench:preferences',e=>{const label=document.querySelector('#local-status');if(label)label.textContent=e.detail.pending?'布局已暂存，待同步':'本地已保存';});
    document.addEventListener('keydown',e=>{if(e.altKey)return;const bindings={search:'Ctrl+K',sidebar:'Ctrl+B',settings:'Ctrl+,',...window.workbenchControlData?.config.shortcuts};const match=value=>{const [modifier,key]=value.split('+');return (modifier==='Ctrl'?e.ctrlKey:e.metaKey)&&e.key.toLowerCase()===key.toLowerCase();};if(match(bindings.search)){e.preventDefault();open();}else if(match(bindings.sidebar)){e.preventDefault();document.querySelector('#sidebar-toggle').click();}else if(match(bindings.settings)&&snapshot.user){e.preventDefault();location.hash='#/settings';}});
  });
})();
